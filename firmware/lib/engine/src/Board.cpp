#include "Board.h"

#include <ArduinoJson.h>
#include <string.h>

#include <vector>

namespace eos {

namespace {

// Characters, not bytes, so a non-ASCII name counts like it does in the editor.
size_t utf8Len(const char* s) {
  size_t n = 0;
  for (; *s; s++) n += ((unsigned char)*s & 0xC0) != 0x80;
  return n;
}

// Copies at most cap-1 bytes without cutting a multi-byte character in half.
void copyText(char* dst, size_t cap, const char* src) {
  size_t n = strlen(src);
  if (n >= cap) {
    n = cap - 1;
    while (n && ((unsigned char)src[n] & 0xC0) == 0x80) n--;
  }
  memcpy(dst, src, n);
  dst[n] = 0;
}

// Optional display string: absent/null, or a string of at most `max` characters.
bool optText(JsonVariantConst v, size_t max) { return v.isNull() || (v.is<const char*>() && utf8Len(v.as<const char*>()) <= max); }

std::string num(int n) { return std::to_string(n); }

// Pins where a driven output misbehaves around reset: 0/2/5/12/15 are strapping
// pins (a relay load can stop the board from booting), 14 pulses at boot.
bool bootNoisy(int pin) { return pin == 0 || pin == 2 || pin == 5 || pin == 12 || pin == 14 || pin == 15; }

}  // namespace

void BoardProfile::setBare() {
  bare_ = true;
  copyText(id_, sizeof id_, "bare");
  copyText(name_, sizeof name_, "Bare ESP32 dev board");
  for (int i = 0; i < kPins; i++) { use_[i] = 0; inv_[i] = -1; }
  oneWire_ = 0;
  sda_ = scl_ = -1;
}

bool BoardProfile::parse(const char* json, std::string& err, const ChipRules& chip) {
  JsonDocument doc;
  if (DeserializationError de = deserializeJson(doc, json ? json : "")) { err = std::string("JSON: ") + de.c_str(); return false; }
  if (!doc.is<JsonObjectConst>()) { err = "A board profile must be a JSON object"; return false; }
  if (measureJson(doc) > kMaxJson) { err = "Board profile is larger than 4096 bytes"; return false; }
  JsonObjectConst p = doc.as<JsonObjectConst>();
  JsonVariantConst schema = p["schema"];
  bool schemaOk = schema.is<int>() && schema.as<int>() == 1;
  const char* id = p["id"].is<const char*>() ? p["id"].as<const char*>() : "";

  // "bare" = no profile: valid without schema, but never with pins of its own.
  if (!strcmp(id, "bare")) {
    if (!schema.isNull() && !schemaOk) { err = "Unsupported board profile schema (expected 1)"; return false; }
    if (!p["terminals"].isNull() || !p["i2c"].isNull() || !p["onewire"].isNull()) {
      err = "The id \"bare\" is reserved for \"no profile\" and cannot have terminals or buses";
      return false;
    }
    setBare();
    return true;
  }

  if (!schemaOk) { err = "Unsupported board profile schema (expected 1)"; return false; }
  size_t idLen = strlen(id);
  bool idOk = idLen >= 1 && idLen <= 24;
  for (const char* c = id; *c; c++) idOk &= (*c >= 'a' && *c <= 'z') || (*c >= '0' && *c <= '9') || *c == '-';
  if (!idOk) { err = "Board id: 1-24 characters a-z, 0-9 and '-'"; return false; }
  JsonVariantConst name = p["name"];
  if (!name.is<const char*>() || !utf8Len(name.as<const char*>()) || utf8Len(name.as<const char*>()) > 40) {
    err = "Board name: 1-40 characters";
    return false;
  }
  if (!optText(p["rev"], 8)) { err = "Board rev: at most 8 characters"; return false; }

  BoardProfile t;  // built aside, taken over only when everything is valid
  t.bare_ = false;
  copyText(t.id_, sizeof t.id_, id);
  copyText(t.name_, sizeof t.name_, name.as<const char*>());
  uint64_t taken = 0;  // every GPIO at most once across terminals, i2c and onewire
  auto claim = [&](int pin, const std::string& what) {
    if (taken & (1ULL << pin)) { err = what + ": GPIO " + num(pin) + " is used twice in this profile"; return false; }
    taken |= 1ULL << pin;
    return true;
  };

  JsonVariantConst i2c = p["i2c"];
  if (!i2c.isNull()) {
    if (!i2c.is<JsonObjectConst>() || !i2c["sda"].is<int>() || !i2c["scl"].is<int>()) { err = "i2c: needs numbers sda and scl (or null for no bus)"; return false; }
    int sda = i2c["sda"], scl = i2c["scl"];
    if (!chip.outputCapable(sda) || !chip.outputCapable(scl)) { err = "i2c: SDA and SCL must be output-capable GPIOs"; return false; }
    if (sda == scl) { err = "i2c: SDA and SCL must be different pins"; return false; }
    if (!claim(sda, "i2c") || !claim(scl, "i2c")) return false;
    t.sda_ = (int8_t)sda;
    t.scl_ = (int8_t)scl;
  }

  JsonVariantConst ow = p["onewire"];
  if (!ow.isNull()) {
    if (!ow.is<JsonArrayConst>()) { err = "onewire: must be a list of GPIOs"; return false; }
    for (JsonVariantConst v : ow.as<JsonArrayConst>()) {
      if (!v.is<int>() || !chip.outputCapable(v.as<int>())) { err = "onewire: 1-Wire pins must be output-capable GPIOs"; return false; }
      if (!claim(v.as<int>(), "onewire")) return false;
      t.oneWire_ |= 1ULL << v.as<int>();
    }
  }

  if (!p["terminals"].is<JsonArrayConst>()) { err = "terminals: must be a list"; return false; }
  JsonArrayConst terms = p["terminals"].as<JsonArrayConst>();
  if (terms.size() > (size_t)kMaxTerminals) { err = "More than 40 terminals"; return false; }
  std::vector<std::string> labels;
  for (JsonVariantConst tv : terms) {
    if (!tv.is<JsonObjectConst>()) { err = "Every terminal must be an object"; return false; }
    JsonObjectConst tm = tv.as<JsonObjectConst>();
    const char* label = tm["label"].is<const char*>() ? tm["label"].as<const char*>() : "";
    size_t ll = strlen(label);
    bool labelOk = ll >= 1 && ll <= 8;
    for (const char* c = label; *c; c++)
      labelOk &= (*c >= 'A' && *c <= 'Z') || (*c >= 'a' && *c <= 'z') || (*c >= '0' && *c <= '9') || *c == '_' || *c == '.' || *c == '-';
    if (!labelOk) { err = "Terminal label \"" + std::string(label) + "\": 1-8 characters A-Z, a-z, 0-9, '_', '.', '-'"; return false; }
    std::string what = "Terminal " + std::string(label);
    for (const auto& l : labels)
      if (l == label) { err = what + ": label used twice"; return false; }
    labels.push_back(label);

    if (!tm["gpio"].is<int>()) { err = what + ": gpio must be a number"; return false; }
    int pin = tm["gpio"];
    if (!chip.validPin(pin)) { err = what + ": GPIO " + num(pin) + " cannot be used (boot/serial or flash pin)"; return false; }
    if (!claim(pin, what)) return false;

    JsonVariantConst uv = tm["uses"];
    if (!uv.is<JsonArrayConst>() || !uv.size()) { err = what + ": uses must list di, do, ai, pwm and/or touch"; return false; }
    uint8_t mask = 0;
    for (JsonVariantConst u : uv.as<JsonArrayConst>()) {
      const char* s = u.is<const char*>() ? u.as<const char*>() : "";
      uint8_t bit = !strcmp(s, "di") ? kDI : !strcmp(s, "do") ? kDO : !strcmp(s, "ai") ? kAI : !strcmp(s, "pwm") ? kPWM : !strcmp(s, "touch") ? kTouch : 0;
      if (!bit) { err = what + ": unknown use \"" + s + "\" (di, do, ai, pwm, touch)"; return false; }
      if (mask & bit) { err = what + ": use \"" + s + "\" listed twice"; return false; }
      mask |= bit;
    }
    if ((mask & (kDO | kPWM)) && !chip.outputCapable(pin)) { err = what + ": GPIO " + num(pin) + " is input-only (no do/pwm)"; return false; }
    if ((mask & kAI) && !chip.adcCapable(pin)) { err = what + ": GPIO " + num(pin) + " has no usable ADC (ai needs 32-36 or 39)"; return false; }
    if ((mask & kTouch) && !chip.touchCapable(pin)) { err = what + ": GPIO " + num(pin) + " has no touch sensor (touch needs 2, 4, 12-15, 27, 32 or 33)"; return false; }

    int8_t inv = -1;
    JsonVariantConst act = tm["active"];
    if (!act.isNull()) {
      const char* a = act.is<const char*>() ? act.as<const char*>() : "";
      if (strcmp(a, "high") && strcmp(a, "low")) { err = what + ": active must be \"high\" or \"low\""; return false; }
      if (mask & (kAI | kPWM | kTouch)) { err = what + ": a fixed active level only fits di/do terminals"; return false; }
      if ((mask & kDO) && bootNoisy(pin)) {
        err = what + ": GPIO " + num(pin) + " is a boot-strapping/boot-noisy pin; a relay there chatters at reset or stops the board from booting";
        return false;
      }
      inv = a[0] == 'l' ? 1 : 0;
    }
    if (!tm["pull"].isNull() && !tm["pull"].is<bool>()) { err = what + ": pull must be true or false"; return false; }
    if (!optText(tm["group"], 24)) { err = what + ": group is at most 24 characters"; return false; }
    if (!optText(tm["note"], 48)) { err = what + ": note is at most 48 characters"; return false; }
    t.use_[pin] = mask;
    t.inv_[pin] = inv;
  }

  *this = t;
  err.clear();
  return true;
}

bool BoardProfile::allows(int pin, PinUse use) const {
  if (bare_) return true;
  uint8_t bit = use == PinUse::DigitalIn ? kDI : use == PinUse::DigitalOut ? kDO : use == PinUse::AnalogIn ? kAI : use == PinUse::Touch ? kTouch : kPWM;
  return uses(pin) & bit;
}

bool BoardProfile::oneWireOk(int pin) const { return bare_ || (pin >= 0 && pin < kPins && (oneWire_ & (1ULL << pin))); }

bool BoardProfile::reservedBus(int pin) const {
  if (bare_ || pin < 0 || pin >= kPins) return false;
  return pin == sda_ || pin == scl_ || (oneWire_ & (1ULL << pin));
}

}  // namespace eos
