#include "Sensors.h"

#include <Adafruit_ADS1X15.h>
#include <Adafruit_BME280.h>
#include <Adafruit_SHT31.h>
#include <Arduino.h>
#include <BH1750.h>
#include <DallasTemperature.h>
#include <OneWire.h>
#include <Wire.h>

#include <memory>

namespace Sensors {
namespace {

struct Cfg {
  int addr = 0;
  int pin = -1;
  // generic I2C
  int reg = 0, len = 2;
  bool isSigned = false, bigEndian = true;
  float scale = 1, offset = 0;
};

class Device {
 public:
  virtual ~Device() {}
  virtual bool begin(const Cfg& c) = 0;
  // Fill out[0..channels-1]; return false on read error.
  virtual bool poll(float* out) = 0;
  virtual int channels() const = 0;
};

class Bme280Dev : public Device {
  Adafruit_BME280 s;
 public:
  bool begin(const Cfg& c) override { return s.begin(c.addr ? c.addr : 0x76, &Wire); }
  bool poll(float* o) override {
    o[0] = s.readTemperature();
    o[1] = s.readHumidity();
    o[2] = s.readPressure() / 100.f;
    return !isnan(o[0]);
  }
  int channels() const override { return 3; }
};

class Sht31Dev : public Device {
  Adafruit_SHT31 s{&Wire};
 public:
  bool begin(const Cfg& c) override { return s.begin(c.addr ? c.addr : 0x44); }
  bool poll(float* o) override {
    o[0] = s.readTemperature();
    o[1] = s.readHumidity();
    return !isnan(o[0]) && !isnan(o[1]);
  }
  int channels() const override { return 2; }
};

class Bh1750Dev : public Device {
  BH1750 s;
 public:
  bool begin(const Cfg& c) override { return s.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, c.addr ? c.addr : 0x23, &Wire); }
  bool poll(float* o) override {
    o[0] = s.readLightLevel();
    return o[0] >= 0;
  }
  int channels() const override { return 1; }
};

class Ds18b20Dev : public Device {
  std::unique_ptr<OneWire> ow;
  std::unique_ptr<DallasTemperature> dt;
  bool pending = false;
 public:
  bool begin(const Cfg& c) override {
    if (c.pin < 0) return false;
    ow.reset(new OneWire(c.pin));
    dt.reset(new DallasTemperature(ow.get()));
    dt->begin();
    dt->setWaitForConversion(false);
    return dt->getDeviceCount() > 0;
  }
  bool poll(float* o) override {
    // Non-blocking: read the conversion requested on the previous poll.
    bool ok = false;
    if (pending) {
      float t = dt->getTempCByIndex(0);
      ok = t != DEVICE_DISCONNECTED_C;
      o[0] = t;
    }
    dt->requestTemperatures();
    pending = true;
    return ok;
  }
  int channels() const override { return 1; }
};

class Ads1115Dev : public Device {
  Adafruit_ADS1115 s;
 public:
  bool begin(const Cfg& c) override { return s.begin(c.addr ? c.addr : 0x48, &Wire); }
  bool poll(float* o) override {
    for (int i = 0; i < 4; i++) o[i] = s.computeVolts(s.readADC_SingleEnded(i));
    return true;
  }
  int channels() const override { return 4; }
};

// Reads len (1-4) bytes from register reg: value = raw * scale + offset.
class GenericI2cDev : public Device {
  Cfg c;
 public:
  bool begin(const Cfg& cfg) override {
    c = cfg;
    if (c.len < 1) c.len = 1;
    if (c.len > 4) c.len = 4;
    Wire.beginTransmission(c.addr);
    return Wire.endTransmission() == 0;
  }
  bool poll(float* o) override {
    Wire.beginTransmission(c.addr);
    Wire.write((uint8_t)c.reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom(c.addr, c.len) != c.len) return false;
    uint32_t raw = 0;
    for (int i = 0; i < c.len; i++) {
      uint32_t b = Wire.read();
      raw |= c.bigEndian ? b << (8 * (c.len - 1 - i)) : b << (8 * i);
    }
    double v = raw;
    if (c.isSigned && (raw & (1UL << (8 * c.len - 1)))) v = (double)raw - (double)(1ULL << (8 * c.len));
    o[0] = (float)(v * c.scale + c.offset);
    return true;
  }
  int channels() const override { return 1; }
};

struct DriverEntry {
  const char* id;
  Device* (*create)();
};
template <class T>
Device* mk() { return new T(); }

const DriverEntry kDrivers[] = {
    {"BME280", mk<Bme280Dev>}, {"SHT31", mk<Sht31Dev>},   {"BH1750", mk<Bh1750Dev>},
    {"DS18B20", mk<Ds18b20Dev>}, {"ADS1115", mk<Ads1115Dev>}, {"I2C_GENERIC", mk<GenericI2cDev>},
};

struct Slot {
  int id = 0;
  String driver;
  std::unique_ptr<Device> dev;
  Cfg cfg;
  uint32_t pollMs = 2000;
  uint32_t last = 0;
  bool started = false;
  volatile bool ok = false;
  volatile float v[kMaxChannels] = {};
  uint32_t nextRetry = 0;
  int nch = 0;
  void reset() {
    nch = 0; id = 0; driver = ""; dev.reset(); cfg = Cfg(); pollMs = 2000; last = 0;
    started = false; ok = false; nextRetry = 0;
    for (int c = 0; c < kMaxChannels; c++) v[c] = 0;
  }
};

Slot slots[kMaxDevices];
int nSlots = 0;
SemaphoreHandle_t lock;  // guards slots[] and the I2C bus
int gSda = 21, gScl = 22;

void pollTask(void*) {
  for (;;) {
    xSemaphoreTake(lock, portMAX_DELAY);
    uint32_t now = millis();
    for (int i = 0; i < nSlots; i++) {
      Slot& s = slots[i];
      if (!s.dev) continue;
      if (!s.started) {
        if ((int32_t)(now - s.nextRetry) < 0) continue;
        s.started = s.dev->begin(s.cfg);
        if (!s.started) { s.ok = false; s.nextRetry = now + 5000; continue; }
        s.last = now - s.pollMs;
      }
      if (now - s.last < s.pollMs) continue;
      s.last = now;
      float tmp[kMaxChannels] = {};
      bool ok = s.dev->poll(tmp);
      if (ok) for (int c = 0; c < kMaxChannels; c++) s.v[c] = tmp[c];
      s.ok = ok;
    }
    xSemaphoreGive(lock);
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

}  // namespace

void begin(int sda, int scl) {
  gSda = sda;
  gScl = scl;
  Wire.begin(sda, scl);
  Wire.setClock(100000);
  lock = xSemaphoreCreateMutex();
  xTaskCreatePinnedToCore(pollTask, "sensors", 6144, nullptr, 1, nullptr, 0);
}

bool validate(JsonArrayConst devices, String& err) {
  if (devices.size() > kMaxDevices) { err = "Too many sensors (max " + String(kMaxDevices) + ")"; return false; }
  for (JsonObjectConst d : devices) {
    const char* drv = d["driver"] | "";
    bool found = false;
    for (const auto& e : kDrivers) if (strcmp(e.id, drv) == 0) found = true;
    if (!found) { err = String("Driver '") + drv + "' is not built into this firmware"; return false; }
  }
  return true;
}

void configure(JsonArrayConst devices) {
  xSemaphoreTake(lock, portMAX_DELAY);
  for (int i = 0; i < nSlots; i++) slots[i].reset();
  nSlots = 0;
  for (JsonObjectConst d : devices) {
    if (nSlots >= kMaxDevices) break;
    Slot& s = slots[nSlots];
    s.id = d["id"] | 0;
    s.driver = d["driver"] | "";
    for (const auto& e : kDrivers) if (s.driver == e.id) s.dev.reset(e.create());
    if (!s.dev) continue;
    s.nch = s.dev->channels();
    s.cfg.addr = d["addr"] | 0;
    s.cfg.pin = d["pin"] | -1;
    s.cfg.reg = d["reg"] | 0;
    s.cfg.len = d["len"] | 2;
    s.cfg.isSigned = d["signed"] | false;
    s.cfg.bigEndian = d["be"] | true;
    s.cfg.scale = d["scale"] | 1.0f;
    s.cfg.offset = d["offset"] | 0.0f;
    float poll = d["poll"] | 2.0f;
    s.pollMs = (uint32_t)(poll * 1000);
    if (s.pollMs < 100) s.pollMs = 100;
    nSlots++;
  }
  xSemaphoreGive(lock);
}

float value(int devId, int channel, bool* ok) {
  // Lock-free read: 32-bit float/bool stores are atomic on the ESP32.
  for (int i = 0; i < nSlots; i++)
    if (slots[i].id == devId && channel >= 0 && channel < slots[i].nch) {
      *ok = slots[i].ok;
      return slots[i].v[channel];
    }
  *ok = false;
  return 0;
}

String statusJson() {
  JsonDocument doc;
  JsonArray a = doc.to<JsonArray>();
  xSemaphoreTake(lock, portMAX_DELAY);
  for (int i = 0; i < nSlots; i++) {
    JsonObject o = a.add<JsonObject>();
    o["id"] = slots[i].id;
    o["driver"] = slots[i].driver;
    o["ok"] = (bool)slots[i].ok;
    JsonArray v = o["v"].to<JsonArray>();
    for (int c = 0; c < slots[i].nch; c++) v.add((float)slots[i].v[c]);
  }
  xSemaphoreGive(lock);
  String s;
  serializeJson(doc, s);
  return s;
}

String driversJson() {
  String s = "[";
  for (size_t i = 0; i < sizeof(kDrivers) / sizeof(kDrivers[0]); i++) {
    if (i) s += ",";
    s += "\"";
    s += kDrivers[i].id;
    s += "\"";
  }
  return s + "]";
}

String i2cScanJson() {
  String s = "{\"sda\":" + String(gSda) + ",\"scl\":" + String(gScl) + ",\"found\":[";
  xSemaphoreTake(lock, portMAX_DELAY);
  bool first = true;
  for (int a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      if (!first) s += ",";
      s += String(a);
      first = false;
    }
  }
  xSemaphoreGive(lock);
  return s + "]}";
}

}  // namespace Sensors
