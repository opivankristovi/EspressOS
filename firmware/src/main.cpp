// EspressOS - LOGO!-style block logic controller for the ESP32.
#include <Arduino.h>
#include <ArduinoJson.h>
#include <AsyncTCP.h>
#include <DNSServer.h>
#include <ESPAsyncWebServer.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <Update.h>
#include <WiFi.h>
#include <esp_random.h>
#include <esp_task_wdt.h>
#include <mbedtls/base64.h>
#include <mbedtls/sha256.h>

#include "Engine.h"
#include "EspHal.h"
#include "Mqtt.h"
#include "Sensors.h"

#ifndef EOS_VERSION
#define EOS_VERSION "dev"
#endif

static const char* kProgramFile = "/program.json";
static const char* kConfigFile = "/config.json";
static const char* kRunFlagFile = "/run.flag";
static const char* kBoardFile = "/board.json";  // absent = bare ESP32 (chip rules only)
static constexpr size_t kMaxBody = 64 * 1024;
static constexpr uint32_t kApFallbackMs = 120000;  // keep trying the router this long before opening the setup AP
static constexpr uint32_t kStaRetryMs = 30000;

struct Config {
  String ssid, pass;  // Wi-Fi password must stay recoverable to connect
  String host = "espressos";
  String adminHash, adminSalt;  // salted SHA-256 of the admin password; empty = setup mode
  String apKey;                  // WPA2 key of the fallback setup network once an admin password exists
  String tz = "CET-1CEST,M3.5.0,M10.5.0/3";
  int sda = 21, scl = 22;
  Mqtt::Settings mqtt;
};

static Config cfg;
static EspHal hal;
static eos::BoardProfile board;
static String boardError;  // stored profile unreadable: board is locked until one is chosen again
static eos::Engine engine(hal);
static SemaphoreHandle_t engineLock;
static String lastError;
static bool apMode = false;
static bool configLocked = false;  // config.json unreadable: refuse logins instead of falling back to setup mode
static bool timeConfigured = false;
static uint32_t staLostSince = 0, lastStaRetry = 0;

static AsyncWebServer server(80);
static AsyncWebSocket ws("/ws");
static DNSServer dns;

// ------------------------------------------------------------------ files
static String readFile(const char* path) {
  File f = LittleFS.open(path, "r");
  if (!f) return String();
  String s = f.readString();
  f.close();
  return s;
}

// Replaces a file without ever leaving a half-written one behind: the data goes
// to <path>.tmp first, the old file becomes <path>.bak, then the new one is
// renamed into place. A power cut at any point leaves one intact copy.
static bool writeFile(const char* path, const char* data, size_t len) {
  String tmp = String(path) + ".tmp", bak = String(path) + ".bak";
  File f = LittleFS.open(tmp, "w");
  if (!f) return false;
  size_t n = f.write((const uint8_t*)data, len);
  f.close();
  if (n != len) { LittleFS.remove(tmp); return false; }
  LittleFS.remove(bak);
  if (LittleFS.exists(path) && !LittleFS.rename(path, bak)) { LittleFS.remove(tmp); return false; }
  return LittleFS.rename(tmp, path);
}

static bool isJson(const String& s) {
  JsonDocument d;
  return s.length() && !deserializeJson(d, s);
}

// Contents of a JSON file, or of its backup if the file is missing or damaged.
static String readJsonFile(const char* path) {
  String s = readFile(path);
  if (isJson(s)) return s;
  String b = readFile((String(path) + ".bak").c_str());
  if (isJson(b)) {
    Serial.printf("%s damaged, using its backup\n", path);
    return b;
  }
  return String();
}

static bool fileOrBackupExists(const char* path) { return LittleFS.exists(path) || LittleFS.exists(String(path) + ".bak"); }

// ------------------------------------------------------------------ password
static String sha256Hex(const String& s) {
  uint8_t out[32];
  mbedtls_sha256((const uint8_t*)s.c_str(), s.length(), out, 0);
  char hex[65];
  for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", out[i]);
  return String(hex);
}

static bool setupMode() { return cfg.adminHash.isEmpty() && !configLocked; }

static String randomKey(int len) {
  static const char kChars[] = "abcdefghjkmnpqrstuvwxyz23456789";  // no look-alikes (l/1, o/0, i)
  String k;
  for (int i = 0; i < len; i++) k += kChars[esp_random() % (sizeof kChars - 1)];
  return k;
}

static void setAdminPassword(const String& pass) {
  char salt[17];
  snprintf(salt, sizeof salt, "%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random());
  cfg.adminSalt = salt;
  cfg.adminHash = sha256Hex(cfg.adminSalt + pass);
  if (cfg.apKey.isEmpty()) cfg.apKey = randomKey(12);
}

static bool passwordMatches(const String& pass) {
  if (configLocked) return false;
  String h = sha256Hex(cfg.adminSalt + pass);
  if (h.length() != cfg.adminHash.length()) return false;
  uint8_t diff = 0;  // constant-time compare
  for (size_t i = 0; i < h.length(); i++) diff |= h[i] ^ cfg.adminHash[i];
  return diff == 0;
}

// HTTP Basic credentials "admin:<password>"
static bool credentialsOk(AsyncWebServerRequest* r) {
  if (!r->hasHeader("Authorization")) return false;
  String a = r->header("Authorization");
  if (!a.startsWith("Basic ")) return false;
  a = a.substring(6);
  a.trim();
  uint8_t buf[192];
  size_t n = 0;
  if (a.length() > 250 || mbedtls_base64_decode(buf, sizeof buf - 1, &n, (const uint8_t*)a.c_str(), a.length()) != 0) return false;
  buf[n] = 0;
  String cred((const char*)buf);
  int colon = cred.indexOf(':');
  return colon > 0 && cred.substring(0, colon) == "admin" && passwordMatches(cred.substring(colon + 1));
}

// Failed-login throttling per client address: after 5 failures the address is
// locked out for 30 s, doubling with every further failure (max 16 min).
struct LoginFails {
  uint32_t ip = 0;
  uint8_t n = 0;
  uint32_t last = 0, until = 0;
};
static LoginFails loginFails[8];

static LoginFails* loginFailsFor(uint32_t ip, bool create) {
  LoginFails* slot = nullptr;
  for (auto& f : loginFails) {
    if (f.n && millis() - f.last > 15 * 60000UL) f = LoginFails();  // forgotten after 15 quiet minutes
    if (f.n && f.ip == ip) return &f;
    if (!slot || !f.n || (slot->n && f.last < slot->last)) slot = &f;  // a free slot, else the oldest
  }
  if (!create) return nullptr;
  *slot = LoginFails();
  slot->ip = ip;
  return slot;
}

static uint32_t lockoutLeft(AsyncWebServerRequest* r) {
  LoginFails* f = loginFailsFor(r->client()->getRemoteAddress(), false);
  if (!f || !f->until) return 0;
  int32_t left = (int32_t)(f->until - millis());
  return left > 0 ? (uint32_t)left : 0;
}

static void noteLogin(AsyncWebServerRequest* r, bool ok) {
  uint32_t ip = r->client()->getRemoteAddress();
  if (ok) {
    if (LoginFails* f = loginFailsFor(ip, false)) *f = LoginFails();
    return;
  }
  LoginFails* f = loginFailsFor(ip, true);
  if (f->n < 255) f->n++;
  f->last = millis();
  if (f->n >= 5) f->until = millis() + (30000UL << (f->n - 5 > 5 ? 5 : f->n - 5));
}

// ------------------------------------------------------------------ config
static bool validI2cPins(int sda, int scl) { return EspHal::outputCapable(sda) && EspHal::outputCapable(scl) && sda != scl; }

// A board profile (or a locked board) owns the I2C pins; bare boards use Settings.
static bool i2cFixed() { return !board.bare() || boardError.length(); }
static int i2cSda() { return boardError.length() ? -1 : board.bare() ? cfg.sda : board.sda(); }
static int i2cScl() { return boardError.length() ? -1 : board.bare() ? cfg.scl : board.scl(); }

// ------------------------------------------------------------------ board profile
// Read at boot only: pins and the I2C bus are set up once. An unreadable profile
// never falls back to bare or to the backup (a program for other wiring could
// drive the wrong pins): the board stays locked until a profile is chosen again.
// The .bak that writeFile leaves is the profile from BEFORE the last change,
// usually another board, so it is never used as the working profile.
static const char* const kBoardSuffixes[] = {"", ".bak", ".tmp"};
static void loadBoard() {
  board.setBare();
  boardError = "";
  bool any = false;
  for (const char* s : kBoardSuffixes) any |= LittleFS.exists(String(kBoardFile) + s);
  if (!any) return;  // never set: bare
  std::string err;
  String text = readFile(kBoardFile);
  if (text.length() && board.parse(text.c_str(), err, EspHal::chipRules())) return;
  board.setBare();
  if (!LittleFS.exists(kBoardFile)) err = "the last change was interrupted (power cut?)";
  else if (text.isEmpty()) err = "file is empty";
  boardError = String("Board profile is unreadable: ") + err.c_str() + ". Choose the board again in Settings \xE2\x86\x92 Board.";
  Serial.println(boardError);
}

static bool removeBoardFiles() {
  for (const char* suffix : kBoardSuffixes) {
    String f = String(kBoardFile) + suffix;
    if (LittleFS.exists(f) && !LittleFS.remove(f)) return false;
  }
  return true;
}

static void loadConfig() {
  JsonDocument d;
  String text = readJsonFile(kConfigFile);
  if (text.isEmpty() || deserializeJson(d, text)) {
    // Settings exist but neither copy can be read: don't drop into the open setup
    // mode (anyone nearby could claim the board). Logins are refused until the
    // flash is erased over USB.
    if (fileOrBackupExists(kConfigFile)) {
      configLocked = true;
      Serial.println("config.json unreadable: logins disabled. Erase the flash over USB to reset the board.");
    }
    return;
  }
  cfg.ssid = d["ssid"] | "";
  cfg.pass = d["pass"] | "";
  cfg.host = d["host"] | "espressos";
  cfg.adminHash = d["adminHash"] | "";
  cfg.adminSalt = d["adminSalt"] | "";
  cfg.tz = d["tz"] | cfg.tz.c_str();
  cfg.sda = d["sda"] | 21;
  cfg.scl = d["scl"] | 22;
  cfg.apKey = d["apKey"] | "";
  if (!validI2cPins(cfg.sda, cfg.scl)) { cfg.sda = 21; cfg.scl = 22; }  // never let a bad config brick the board
  JsonObjectConst m = d["mqtt"];
  cfg.mqtt.host = m["host"] | "";
  cfg.mqtt.port = m["port"] | 1883;
  cfg.mqtt.user = m["user"] | "";
  cfg.mqtt.pass = m["pass"] | "";
  cfg.mqtt.base = m["base"] | "";
  cfg.mqtt.ha = m["ha"] | true;
  cfg.mqtt.haPrefix = m["haPrefix"] | "homeassistant";
  String legacy = d["adminPass"] | "";  // v0.1.0 stored it in plain text
  if (legacy.length() && cfg.adminHash.isEmpty()) setAdminPassword(legacy);
}

static bool saveConfig() {
  JsonDocument d;
  d["ssid"] = cfg.ssid;
  d["pass"] = cfg.pass;
  d["host"] = cfg.host;
  d["adminHash"] = cfg.adminHash;
  d["adminSalt"] = cfg.adminSalt;
  d["tz"] = cfg.tz;
  d["sda"] = cfg.sda;
  d["scl"] = cfg.scl;
  d["apKey"] = cfg.apKey;
  JsonObject m = d["mqtt"].to<JsonObject>();
  m["host"] = cfg.mqtt.host;
  m["port"] = cfg.mqtt.port;
  m["user"] = cfg.mqtt.user;
  m["pass"] = cfg.mqtt.pass;
  m["base"] = cfg.mqtt.base;
  m["ha"] = cfg.mqtt.ha;
  m["haPrefix"] = cfg.mqtt.haPrefix;
  String s;
  serializeJson(d, s);
  return writeFile(kConfigFile, s.c_str(), s.length());
}

// MQTT settings from a /api/config request, checked before anything changes.
// The password is only replaced when one is sent; an empty user name clears it.
static bool topicOk(const String& t) { return t.length() <= 64 && t.indexOf('+') < 0 && t.indexOf('#') < 0; }

static bool readMqttSettings(JsonObjectConst m, Mqtt::Settings& s, String& why) {
  if (m["host"].is<const char*>()) s.host = m["host"].as<const char*>();
  s.host.trim();
  bool okHost = s.host.length() <= 64;
  for (char c : s.host) okHost &= isalnum((unsigned char)c) || c == '.' || c == '-' || c == '_';
  if (!okHost) { why = "MQTT broker: use a host name or IP address (letters, digits, '.', '-')"; return false; }
  if (m["port"].is<int>()) s.port = m["port"].as<int>();
  if (s.port < 1 || s.port > 65535) { why = "MQTT port must be 1-65535"; return false; }
  if (m["user"].is<const char*>()) s.user = m["user"].as<const char*>();
  if (m["pass"].is<const char*>()) s.pass = m["pass"].as<const char*>();
  if (s.user.isEmpty()) s.pass = "";
  if (s.user.length() > 64 || s.pass.length() > 64) { why = "MQTT user name and password: at most 64 characters"; return false; }
  if (m["base"].is<const char*>()) s.base = m["base"].as<const char*>();
  s.base.trim();
  while (s.base.endsWith("/")) s.base.remove(s.base.length() - 1);
  if (!topicOk(s.base)) { why = "MQTT base topic: at most 64 characters, no + or #"; return false; }
  if (m["ha"].is<bool>()) s.ha = m["ha"].as<bool>();
  if (m["haPrefix"].is<const char*>()) s.haPrefix = m["haPrefix"].as<const char*>();
  s.haPrefix.trim();
  if (s.haPrefix.isEmpty()) s.haPrefix = "homeassistant";
  if (!topicOk(s.haPrefix)) { why = "Discovery prefix: at most 64 characters, no + or #"; return false; }
  return true;
}

// ------------------------------------------------------------------ engine
// A block parameter read the way the engine reads it (number, bool or numeric string).
static float numParam(JsonVariantConst v, float def) {
  if (v.is<float>()) return v.as<float>();
  if (v.is<const char*>()) return (float)atof(v.as<const char*>());
  if (v.is<bool>()) return v.as<bool>() ? 1.f : 0.f;
  return def;
}

// Validates + loads a program into the engine and the sensor manager.
static bool deploy(const char* json, String& err) {
  JsonDocument doc;
  if (DeserializationError e = deserializeJson(doc, json)) { err = String("JSON: ") + e.c_str(); return false; }
  if (boardError.length()) { err = boardError; return false; }
  // A program stamped for other wiring must not drive these pins (absent stamp = bare).
  const char* stamp = doc["board"].is<const char*>() ? doc["board"].as<const char*>() : "bare";
  if (strcmp(stamp, board.id()) != 0) {
    err = String("Program was made for board \"") + stamp + "\" but this board is set to \"" + board.id() +
          "\". Open it in the editor and use Retarget, then Deploy.";
    return false;
  }
  JsonArrayConst devs = doc["devices"].as<JsonArrayConst>();
  if (!Sensors::validate(devs, err)) return false;
  bool i2cBusy = Sensors::usesI2c(devs);
  int sda = i2cSda(), scl = i2cScl();
  for (JsonObjectConst b : doc["blocks"].as<JsonArrayConst>()) {
    const char* t = b["type"] | "";
    bool di = !strcmp(t, "DI"), dout = !strcmp(t, "DO");
    if (!di && !dout && strcmp(t, "AI") && strcmp(t, "AO")) continue;
    JsonObjectConst p = b["p"];
    int pin = (int)numParam(p["pin"], -1);
    String where = "Block " + String((int)(b["id"] | 0)) + ": GPIO " + String(pin);
    // With a profile the bus pins are never I/O; bare keeps the old rule (only while an I2C sensor exists).
    if (board.reservedBus(pin)) {
      err = where + (pin == sda || pin == scl ? " is the I2C bus on this board" : " is a 1-Wire pin on this board");
      return false;
    }
    if (board.bare() && i2cBusy && (pin == sda || pin == scl)) {
      err = where + " is the I2C bus (SDA " + String(sda) + ", SCL " + String(scl) + ")";
      return false;
    }
    for (JsonObjectConst d : devs)
      if (!strcmp(d["driver"] | "", "DS18B20") && (d["pin"] | -1) == pin) {
        err = where + " is the data pin of DS18B20 sensor " + String((int)(d["id"] | 0));
        return false;
      }
    int fixed = board.fixedInv(pin);
    if ((di || dout) && fixed >= 0 && (numParam(p["inv"], 0) != 0) != (fixed == 1)) {
      err = where + " is active-" + (fixed ? "low" : "high") + " on this board: set Invert to " + (fixed ? "on" : "off");
      return false;
    }
  }
  // Engine and sensors are swapped together while the scan task is held off,
  // so no SENSOR block can read a device that is being replaced.
  std::string eerr;
  xSemaphoreTake(engineLock, portMAX_DELAY);
  bool ok = engine.load(json, eerr);
  if (ok) {
    Sensors::configure(devs);
    engine.run();
  }
  uint32_t cycle = engine.cycleMs();
  xSemaphoreGive(engineLock);
  if (!ok) {
    err = eerr.c_str();
    return false;
  }
  // Web controls become MQTT topics (and Home Assistant entities).
  std::vector<Mqtt::Entity> ents;
  for (JsonObjectConst b : doc["blocks"].as<JsonArrayConst>()) {
    if (strcmp(b["type"] | "", "VIN") != 0) continue;
    JsonObjectConst p = b["p"];
    Mqtt::Entity e;
    e.idx = p["idx"] | 0;
    if (e.idx < 0 || e.idx >= EspHal::kVirtual) continue;
    e.name = p["name"] | "";
    if (!strcmp(b["ui"] | "", "VSLIDER")) {
      e.kind = 'n';
      e.min = p["min"] | 0.0f;
      e.max = p["max"] | 100.0f;
      e.step = p["step"] | 1.0f;
    } else {
      e.kind = !strcmp(p["mode"] | "", "button") ? 'b' : 's';
    }
    ents.push_back(e);
  }
  Mqtt::setEntities(ents);
  Mqtt::setCycleMs(cycle);
  return true;
}

static void engineSetRunning(bool run) {
  xSemaphoreTake(engineLock, portMAX_DELAY);
  if (run) engine.run();
  else engine.stop();
  xSemaphoreGive(engineLock);
}

static bool engineRunning() {
  xSemaphoreTake(engineLock, portMAX_DELAY);
  bool r = engine.running();
  xSemaphoreGive(engineLock);
  return r;
}

static void engineTask(void*) {
  esp_task_wdt_add(nullptr);
  TickType_t wake = xTaskGetTickCount();
  for (;;) {
    xSemaphoreTake(engineLock, portMAX_DELAY);
    engine.scan(millis());
    uint32_t period = engine.cycleMs();
    xSemaphoreGive(engineLock);
    esp_task_wdt_reset();
    TickType_t ticks = pdMS_TO_TICKS(period);
    vTaskDelayUntil(&wake, ticks ? ticks : 1);
  }
}

static String monitorJson() {
  xSemaphoreTake(engineLock, portMAX_DELAY);
  std::string snap = engine.snapshot();
  xSemaphoreGive(engineLock);
  String s(snap.c_str());
  s.remove(s.length() - 1);  // drop final '}' and append extras
  s += ",\"v\":[";
  for (int i = 0; i < EspHal::kVirtual; i++) {
    if (i) s += ",";
    s += String((float)hal.vin[i], 3);
  }
  s += "],\"dev\":" + Sensors::statusJson() + "}";
  return s;
}

// ------------------------------------------------------------------ wifi
static void startAp() {
  if (apMode) return;
  uint64_t mac = ESP.getEfuseMac();
  char name[32];
  snprintf(name, sizeof name, "EspressOS-%04X", (unsigned)(mac >> 32) & 0xFFFF);
  WiFi.mode(cfg.ssid.length() ? WIFI_AP_STA : WIFI_AP);  // keep retrying the router in the background
  // First setup has nothing to protect yet, so its network is open. Once an admin
  // password exists the fallback network uses WPA2 (its key is shown in Settings).
  bool open = setupMode() || cfg.apKey.length() < 8;
  WiFi.softAP(name, open ? nullptr : cfg.apKey.c_str());
  dns.start(53, "*", WiFi.softAPIP());
  apMode = true;
  Serial.printf("Setup AP '%s' (%s) at %s\n", name, open ? "open" : "WPA2, key in Settings", WiFi.softAPIP().toString().c_str());
}

static void stopAp() {
  if (!apMode) return;
  dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  apMode = false;
  Serial.println("Router connected, setup AP closed");
}

static void onStaConnected() {
  Serial.printf("IP: %s\n", WiFi.localIP().toString().c_str());
  if (!timeConfigured) {
    configTzTime(cfg.tz.c_str(), "pool.ntp.org", "time.google.com");
    timeConfigured = true;
  }
}

static void startWifi() {
  WiFi.setHostname(cfg.host.c_str());
  if (cfg.ssid.isEmpty()) {
    startAp();  // first setup: nothing to protect yet
  } else {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
    Serial.printf("Connecting to %s", cfg.ssid.c_str());
    for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; i++) {
      delay(250);
      Serial.print('.');
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) onStaConnected();
    else staLostSince = lastStaRetry = millis();  // wifiTick() keeps trying; AP only after kApFallbackMs
  }
  if (MDNS.begin(cfg.host.c_str())) MDNS.addService("http", "tcp", 80);
}

// Routers often boot slower than the ESP32 after a power cut: keep retrying
// and only open the setup AP after a while; close it once the router is back.
static void wifiTick() {
  if (cfg.ssid.isEmpty()) return;
  uint32_t now = millis();
  if (WiFi.status() == WL_CONNECTED) {
    if (staLostSince) { staLostSince = 0; onStaConnected(); }
    stopAp();
    return;
  }
  if (!staLostSince) staLostSince = now;
  if (now - lastStaRetry >= kStaRetryMs) {
    lastStaRetry = now;
    WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
  }
  if (!apMode && now - staLostSince >= kApFallbackMs) startAp();
}

// ------------------------------------------------------------------ request gate
// One policy for every request, applied by the middleware AND by the body /
// upload callbacks (the library streams bodies before middleware runs).
enum Gate { kOk = 0, kNeedAuth = 401, kForbidden = 403, kTooMany = 429 };

static bool hostOk(AsyncWebServerRequest* r) {
  // Rejecting foreign Host names defeats DNS-rebinding pages reading the API.
  String h = r->host();
  int colon = h.indexOf(':');
  if (colon >= 0) h = h.substring(0, colon);
  h.toLowerCase();
  String name = cfg.host;
  name.toLowerCase();
  return h == name || h == name + ".local" || h == WiFi.localIP().toString() || h == WiFi.softAPIP().toString();
}

static bool originOk(AsyncWebServerRequest* r) {
  if (!r->hasHeader("Origin")) return true;  // non-browser clients
  String o = r->header("Origin");
  int p = o.indexOf("://");
  if (p >= 0) o = o.substring(p + 3);
  return o.equalsIgnoreCase(r->host());
}

static Gate gate(AsyncWebServerRequest* r, const char** why) {
  const String& url = r->url();
  bool isApi = url.startsWith("/api/") || url == "/ws";
  bool write = r->method() != HTTP_GET && r->method() != HTTP_HEAD;
  *why = "";
  if (isApi && !hostOk(r)) { *why = "Unknown host name"; return kForbidden; }
  if (!setupMode()) {
    if (lockoutLeft(r)) { *why = "Too many failed logins; try again later"; return kTooMany; }
    if (!credentialsOk(r)) return kNeedAuth;
  }
  if (isApi && (write || url == "/ws") && !originOk(r)) { *why = "Cross-site request blocked"; return kForbidden; }
  // A header a foreign web page cannot add without a CORS preflight, which this server never approves.
  if (isApi && write && !r->hasHeader("X-EOS")) { *why = "Missing X-EOS header"; return kForbidden; }
  if (setupMode() && isApi && write && url != "/api/config") { *why = "Set an admin password first (Settings)"; return kForbidden; }
  return kOk;
}

// ------------------------------------------------------------------ http helpers
static void sendJson(AsyncWebServerRequest* r, int code, const String& body) { r->send(code, "application/json", body); }

static void sendResult(AsyncWebServerRequest* r, bool ok, const String& err) {
  JsonDocument d;
  d["ok"] = ok;
  if (!ok) d["err"] = err;
  String s;
  serializeJson(d, s);
  sendJson(r, ok ? 200 : 400, s);
}

// Collects a JSON request body into _tempObject (freed by the library).
// Refuses unknown sizes (chunked), oversize bodies and unauthorised requests
// before allocating anything, and never writes past the buffer.
static void collectBody(AsyncWebServerRequest* r, uint8_t* data, size_t len, size_t index, size_t total) {
  if (index == 0) {
    const char* why;
    if (r->_tempObject || total == 0 || total > kMaxBody || gate(r, &why) != kOk) return;
    r->_tempObject = calloc(total + 1, 1);
  }
  char* buf = (char*)r->_tempObject;
  if (!buf) return;
  if (index + len > total) {  // more data than announced: drop everything
    free(buf);
    r->_tempObject = nullptr;
    return;
  }
  memcpy(buf + index, data, len);
}

static const char* body(AsyncWebServerRequest* r) { return r->_tempObject ? (const char*)r->_tempObject : nullptr; }

// ------------------------------------------------------------------ OTA
// Accepts firmware images and LittleFS (web UI) images. A filesystem image
// would wipe the program and settings, so those are kept in RAM and written
// back afterwards.
struct Ota {
  bool busy = false;
  bool fs = false;
  bool wasRunning = false;
  bool ok = false;
  AsyncWebServerRequest* req = nullptr;
  String keepProgram, keepConfig, keepRunFlag;
  String keepBoard[3];  // /board.json, .bak, .tmp exactly as they were (see loadBoard)
  bool hadBoard[3] = {};
  String err;  // why the last upload was refused
};
static Ota ota;

static void otaFinish(bool ok) {
  if (!ok) Update.abort();
  if (ota.fs) {
    if (!LittleFS.begin(true)) Serial.println("LittleFS mount after update failed");
    if (ota.keepConfig.length()) writeFile(kConfigFile, ota.keepConfig.c_str(), ota.keepConfig.length());
    if (ota.keepProgram.length()) writeFile(kProgramFile, ota.keepProgram.c_str(), ota.keepProgram.length());
    if (ota.keepRunFlag.length()) writeFile(kRunFlagFile, ota.keepRunFlag.c_str(), ota.keepRunFlag.length());
    // The board files go back byte for byte, damaged or not, so the board boots
    // exactly as it would have without the update (locked stays locked).
    for (int i = 0; i < 3; i++) {
      if (!ota.hadBoard[i]) continue;
      File f = LittleFS.open(String(kBoardFile) + kBoardSuffixes[i], "w");
      if (f) { f.print(ota.keepBoard[i]); f.close(); }
      ota.keepBoard[i] = String();
      ota.hadBoard[i] = false;
    }
    ota.keepProgram = ota.keepConfig = ota.keepRunFlag = String();
  }
  // A failed update, or a web-UI-only update, resumes the program.
  if (ota.wasRunning && (!ok || ota.fs)) engineSetRunning(true);
  ota.ok = ok;
  ota.busy = false;
  ota.req = nullptr;
}

static void otaUpload(AsyncWebServerRequest* r, const String&, size_t index, uint8_t* data, size_t len, bool final) {
  if (index == 0) {
    const char* why;
    if (gate(r, &why) != kOk || ota.busy || len == 0 || r->_tempObject) return;
    // Firmware images start with the ESP image magic 0xE9; a LittleFS image has
    // "littlefs" at byte 8 of its superblock. Anything else (partitions.bin, a
    // renamed file...) would overwrite the web UI, so it is refused.
    bool firmware = data[0] == 0xE9;
    bool fsImage = len >= 16 && memcmp(data + 8, "littlefs", 8) == 0;
    if (!firmware && !fsImage) {
      ota.err = "Not a firmware or web UI image. Use firmware.bin or littlefs.bin from the build folder.";
      return;
    }
    ota.err = "";
    ota.busy = true;
    ota.ok = false;
    ota.req = r;
    ota.fs = fsImage;
    ota.wasRunning = engineRunning();
    engineSetRunning(false);  // outputs to safe state while flashing
    if (ota.fs) {
      ota.keepProgram = readFile(kProgramFile);
      ota.keepConfig = readFile(kConfigFile);
      ota.keepRunFlag = readFile(kRunFlagFile);
      // Kept byte for byte, even if damaged: losing them would turn the board bare silently.
      for (int i = 0; i < 3; i++) {
        String f = String(kBoardFile) + kBoardSuffixes[i];
        ota.hadBoard[i] = LittleFS.exists(f);
        ota.keepBoard[i] = ota.hadBoard[i] ? readFile(f.c_str()) : String();
      }
      LittleFS.end();
    }
    if (!Update.begin(UPDATE_SIZE_UNKNOWN, ota.fs ? U_SPIFFS : U_FLASH)) {
      Update.printError(Serial);
      otaFinish(false);
      return;
    }
    r->_tempObject = malloc(1);  // marks this request as the accepted upload
    r->onDisconnect([r]() {
      if (ota.busy && ota.req == r) otaFinish(false);  // browser closed / Wi-Fi dropped mid-upload
    });
  }
  if (!r->_tempObject || !ota.busy || ota.req != r) return;
  if (len && Update.write(data, len) != len) {
    Update.printError(Serial);
    otaFinish(false);
    return;
  }
  if (final) {
    bool ok = Update.end(true);
    if (!ok) Update.printError(Serial);
    otaFinish(ok);
  }
}

static void otaDone(AsyncWebServerRequest* r) {
  if (!r->_tempObject) return sendResult(r, false, ota.busy ? "Another update is in progress" : ota.err.length() ? ota.err : "Update rejected");
  if (!ota.ok) return sendResult(r, false, Update.errorString());
  bool firmware = !ota.fs;
  sendResult(r, true, "");
  if (firmware) xTaskCreate([](void*) { delay(800); ESP.restart(); }, "reboot", 2048, nullptr, 1, nullptr);
}

// ------------------------------------------------------------------ routes
static void setupRoutes() {
  server.addMiddleware([](AsyncWebServerRequest* r, ArMiddlewareNext next) {
    const char* why;
    Gate g = gate(r, &why);
    // Logins are counted here only: the middleware runs exactly once per request.
    if (r->hasHeader("Authorization") && (g == kOk || g == kNeedAuth) && !setupMode()) noteLogin(r, g == kOk);
    if (g == kNeedAuth) return r->requestAuthentication(AsyncAuthType::AUTH_BASIC, "EspressOS");
    if (g != kOk) {
      JsonDocument d;
      d["ok"] = false;
      d["err"] = why;
      if (g == kTooMany) d["retryAfter"] = (lockoutLeft(r) + 999) / 1000;
      String s;
      serializeJson(d, s);
      return sendJson(r, (int)g, s);
    }
    next();
  });

  server.on("/api/info", HTTP_GET, [](AsyncWebServerRequest* r) {
    JsonDocument d;
    d["version"] = EOS_VERSION;
    d["uptime"] = millis() / 1000;
    d["heap"] = ESP.getFreeHeap();
    d["ap"] = apMode;
    d["setup"] = setupMode();
    d["ip"] = WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
    d["rssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
    d["host"] = cfg.host;
    xSemaphoreTake(engineLock, portMAX_DELAY);
    d["running"] = engine.running();
    d["blocks"] = engine.blockCount();
    d["cycleMs"] = engine.cycleMs();
    d["cycles"] = engine.cycles();
    xSemaphoreGive(engineLock);
    d["error"] = lastError;
    JsonObject bd = d["board"].to<JsonObject>();
    bd["id"] = boardError.length() ? "?" : board.id();
    bd["name"] = boardError.length() ? "" : board.name();
    d["boardError"] = boardError;
    d["mqtt"] = Mqtt::statusText();
    time_t now = time(nullptr);
    d["timeSynced"] = now > 1700000000;
    d["time"] = (uint32_t)now;
    String s;
    serializeJson(d, s);
    sendJson(r, 200, s);
  });

  server.on("/api/program", HTTP_GET, [](AsyncWebServerRequest* r) {
    if (LittleFS.exists(kProgramFile)) r->send(LittleFS, kProgramFile, "application/json");
    else sendJson(r, 200, "{\"blocks\":[],\"wires\":[],\"devices\":[]}");
  });

  server.on(
      "/api/program", HTTP_POST,
      [](AsyncWebServerRequest* r) {
        const char* b = body(r);
        if (!b) return sendResult(r, false, "Empty, chunked or too large body (max 64 KB)");
        String err;
        bool ok = deploy(b, err);
        if (ok) {
          if (!writeFile(kProgramFile, b, strlen(b)) || !writeFile(kRunFlagFile, "1", 1)) {
            ok = false;
            err = "Running, but it could not be saved to flash (full?): it will be lost on reboot";
          }
          lastError = ok ? "" : err;
        } else {
          lastError = err;
        }
        sendResult(r, ok, err);
      },
      nullptr, collectBody);

  server.on("/api/run", HTTP_POST, [](AsyncWebServerRequest* r) {
    engineSetRunning(true);
    writeFile(kRunFlagFile, "1", 1);
    sendResult(r, true, "");
  });

  server.on("/api/stop", HTTP_POST, [](AsyncWebServerRequest* r) {
    engineSetRunning(false);
    writeFile(kRunFlagFile, "0", 1);
    sendResult(r, true, "");
  });

  server.on(
      "/api/vin", HTTP_POST,
      [](AsyncWebServerRequest* r) {
        JsonDocument d;
        if (!body(r) || deserializeJson(d, body(r))) return sendResult(r, false, "Bad JSON");
        int idx = d["idx"] | -1;
        if (idx < 0 || idx >= EspHal::kVirtual) return sendResult(r, false, "Bad index");
        hal.vin[idx] = d["value"] | 0.0f;
        sendResult(r, true, "");
      },
      nullptr, collectBody);

  server.on("/api/monitor", HTTP_GET, [](AsyncWebServerRequest* r) { sendJson(r, 200, monitorJson()); });
  server.on("/api/drivers", HTTP_GET, [](AsyncWebServerRequest* r) { sendJson(r, 200, Sensors::driversJson()); });
  server.on("/api/i2c/scan", HTTP_GET, [](AsyncWebServerRequest* r) { sendJson(r, 200, Sensors::i2cScanJson()); });

  server.on("/api/config", HTTP_GET, [](AsyncWebServerRequest* r) {
    JsonDocument d;
    d["ssid"] = cfg.ssid;
    d["host"] = cfg.host;
    d["tz"] = cfg.tz;
    d["sda"] = i2cSda();  // effective pins (-1 when the board has no I2C bus)
    d["scl"] = i2cScl();
    if (i2cFixed()) d["i2cFixed"] = true;
    d["hasAdminPass"] = !setupMode();
    d["apKey"] = setupMode() ? "" : cfg.apKey;  // only ever sent to a logged-in admin
    JsonObject m = d["mqtt"].to<JsonObject>();
    m["host"] = cfg.mqtt.host;
    m["port"] = cfg.mqtt.port;
    m["user"] = cfg.mqtt.user;
    m["hasPass"] = cfg.mqtt.pass.length() > 0;  // the password itself is never sent back
    m["base"] = cfg.mqtt.base;
    m["defaultBase"] = "espressos/" + cfg.host;
    m["ha"] = cfg.mqtt.ha;
    m["haPrefix"] = cfg.mqtt.haPrefix;
    String s;
    serializeJson(d, s);
    sendJson(r, 200, s);
  });

  server.on(
      "/api/config", HTTP_POST,
      [](AsyncWebServerRequest* r) {
        JsonDocument d;
        if (!body(r) || deserializeJson(d, body(r))) return sendResult(r, false, "Bad JSON");
        // Validate everything before changing anything.
        const char* newPass = d["adminPass"].is<const char*>() ? d["adminPass"].as<const char*>() : nullptr;
        if (setupMode() && !newPass) return sendResult(r, false, "Choose an admin password first");
        if (newPass && strlen(newPass) < 8) return sendResult(r, false, "Admin password needs at least 8 characters");
        int sda = cfg.sda, scl = cfg.scl;
        if (i2cFixed()) {
          // Sending the effective pins back unchanged is fine; changing them is not.
          if ((d["sda"].is<int>() && d["sda"].as<int>() != i2cSda()) || (d["scl"].is<int>() && d["scl"].as<int>() != i2cScl()))
            return sendResult(r, false, "The I2C pins are fixed by the board profile");
        } else {
          if (d["sda"].is<int>()) sda = d["sda"].as<int>();
          if (d["scl"].is<int>()) scl = d["scl"].as<int>();
          if (!validI2cPins(sda, scl)) return sendResult(r, false, "I2C pins must be two different output-capable GPIOs (not 6-11 or 34-39)");
        }
        Mqtt::Settings mq = cfg.mqtt;
        bool mqttChanged = d["mqtt"].is<JsonObjectConst>();
        if (mqttChanged) {
          String why;
          if (!readMqttSettings(d["mqtt"], mq, why)) return sendResult(r, false, why);
        }
        if (d["host"].is<const char*>()) {
          String h = d["host"].as<const char*>();
          bool okName = h.length() >= 1 && h.length() <= 32;
          for (char c : h) okName &= isalnum((unsigned char)c) || c == '-';
          if (!okName) return sendResult(r, false, "Hostname may only contain letters, digits and '-'");
          cfg.host = h;
        }
        if (d["ssid"].is<const char*>()) cfg.ssid = d["ssid"].as<const char*>();
        if (d["pass"].is<const char*>()) cfg.pass = d["pass"].as<const char*>();  // only sent when changed
        if (d["tz"].is<const char*>()) cfg.tz = d["tz"].as<const char*>();
        if (newPass) setAdminPassword(newPass);  // takes effect immediately
        cfg.sda = sda;
        cfg.scl = scl;
        cfg.mqtt = mq;
        if (mqttChanged) Mqtt::configure(cfg.mqtt);  // reconnects right away
        if (!saveConfig()) return sendResult(r, false, "Could not save the settings to flash");
        sendResult(r, true, "");
      },
      nullptr, collectBody);

  server.on("/api/board", HTTP_GET, [](AsyncWebServerRequest* r) {
    if (boardError.length()) {
      JsonDocument d;
      d["id"] = "?";
      d["error"] = boardError;
      String s;
      serializeJson(d, s);
      return sendJson(r, 200, s);
    }
    String s = board.bare() ? String() : readFile(kBoardFile);  // the file loadBoard parsed (never the .bak)
    sendJson(r, 200, s.length() ? s : String("{\"schema\":1,\"id\":\"bare\",\"name\":\"") + board.name() + "\"}");
  });

  // Pins and the I2C bus are only set up at boot, so a new profile means a restart.
  // The stored program keeps its old stamp and stays stopped until redeployed.
  server.on(
      "/api/board", HTTP_POST,
      [](AsyncWebServerRequest* r) {
        const char* b = body(r);
        if (!b) return sendResult(r, false, "Empty, chunked or too large body");
        if (strlen(b) > eos::BoardProfile::kMaxJson) return sendResult(r, false, "Board profile is larger than 4096 bytes");
        eos::BoardProfile next;
        std::string perr;
        if (!next.parse(b, perr, EspHal::chipRules())) return sendResult(r, false, perr.c_str());
        // Programs are tied to a board by its id. A changed profile under the same id
        // would let the stored program start again on different wiring.
        if (!boardError.length() && !next.bare() && strcmp(next.id(), board.id()) == 0)
          return sendResult(r, false, (String("This board already uses a profile with the id \"") + board.id() +
                                       "\". A changed profile needs a new id, so programs made for the old wiring do not run on it.").c_str());
        bool wasRunning = engineRunning();
        engineSetRunning(false);  // outputs to their safe state before the wiring changes
        bool saved = next.bare() ? removeBoardFiles() : writeFile(kBoardFile, b, strlen(b));
        if (!saved) {
          if (wasRunning) engineSetRunning(true);
          return sendResult(r, false, "Could not save the board profile to flash");
        }
        sendResult(r, true, "");
        xTaskCreate([](void*) { delay(800); ESP.restart(); }, "reboot", 2048, nullptr, 1, nullptr);
      },
      nullptr, collectBody);

  server.on("/api/reboot", HTTP_POST, [](AsyncWebServerRequest* r) {
    sendResult(r, true, "");
    xTaskCreate([](void*) { delay(500); ESP.restart(); }, "reboot", 2048, nullptr, 1, nullptr);
  });

  server.on("/api/ota", HTTP_POST, otaDone, otaUpload);

  ws.onEvent([](AsyncWebSocket*, AsyncWebSocketClient* c, AwsEventType t, void*, uint8_t*, size_t) {
    if (t == WS_EVT_CONNECT) c->text(monitorJson());
  });
  server.addHandler(&ws);

  server.serveStatic("/", LittleFS, "/www/").setDefaultFile("index.html").setCacheControl("max-age=60");

  server.onNotFound([](AsyncWebServerRequest* r) {
    if (apMode && !r->url().startsWith("/api")) {
      r->redirect("http://" + WiFi.softAPIP().toString() + "/");  // captive portal
      return;
    }
    r->send(404, "text/plain", "Not found");
  });

  server.begin();
}

// ------------------------------------------------------------------ main
void setup() {
  Serial.begin(115200);
  Serial.printf("\nEspressOS %s\n", EOS_VERSION);
  if (!LittleFS.begin(true)) Serial.println("LittleFS mount failed");
  loadConfig();
  bool migrate = readFile(kConfigFile).indexOf("\"adminPass\"") >= 0;  // move a plain-text password away
  if (!setupMode() && !configLocked && cfg.apKey.isEmpty()) { cfg.apKey = randomKey(12); migrate = true; }  // boards set up before AP keys
  if (migrate) saveConfig();
  engineLock = xSemaphoreCreateMutex();
  loadBoard();  // before the I2C bus and the stored program: both depend on it
  hal.board = &board;
  Sensors::begin(i2cSda(), i2cScl(), &board);
  Mqtt::begin(&hal, cfg.host, cfg.mqtt);  // before deploy(): programs register their topics

  String prog = readJsonFile(kProgramFile);
  if (prog.length() && boardError.length()) {
    lastError = "Stored program not started: " + boardError;  // never run it on unknown wiring
    Serial.println(lastError);
  } else if (prog.length()) {
    String err;
    if (!deploy(prog.c_str(), err)) {
      lastError = "Stored program: " + err;
      Serial.println(lastError);
    } else if (readFile(kRunFlagFile) == "0") {
      engine.stop();
    }
  }

  // Engine on core 1 at high priority; Wi-Fi/web stay on core 0.
  xTaskCreatePinnedToCore(engineTask, "engine", 8192, nullptr, 5, nullptr, 1);
  startWifi();
  setupRoutes();
}

void loop() {
  if (apMode) dns.processNextRequest();
  wifiTick();
  static uint32_t lastPush = 0;
  if (millis() - lastPush >= 250) {
    lastPush = millis();
    ws.cleanupClients();
    if (ws.count() && ws.availableForWriteAll()) ws.textAll(monitorJson());
  }
  delay(5);
}
