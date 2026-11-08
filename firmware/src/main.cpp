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
#include <esp_task_wdt.h>

#include "Engine.h"
#include "EspHal.h"
#include "Sensors.h"

#ifndef EOS_VERSION
#define EOS_VERSION "dev"
#endif

static const char* kProgramFile = "/program.json";
static const char* kConfigFile = "/config.json";
static const char* kRunFlagFile = "/run.flag";

struct Config {
  String ssid, pass;
  String host = "espressos";
  String adminPass;  // empty = no login
  String tz = "CET-1CEST,M3.5.0,M10.5.0/3";
  int sda = 21, scl = 22;
};

static Config cfg;
static EspHal hal;
static eos::Engine engine(hal);
static SemaphoreHandle_t engineLock;
static String lastError;
static bool apMode = false;

static AsyncWebServer server(80);
static AsyncWebSocket ws("/ws");
static DNSServer dns;
static AsyncAuthenticationMiddleware authMw;

// ------------------------------------------------------------------ config
static String readFile(const char* path) {
  File f = LittleFS.open(path, "r");
  if (!f) return String();
  String s = f.readString();
  f.close();
  return s;
}

static bool writeFile(const char* path, const char* data, size_t len) {
  File f = LittleFS.open(path, "w");
  if (!f) return false;
  size_t n = f.write((const uint8_t*)data, len);
  f.close();
  return n == len;
}

static void loadConfig() {
  JsonDocument d;
  if (deserializeJson(d, readFile(kConfigFile))) return;
  cfg.ssid = d["ssid"] | "";
  cfg.pass = d["pass"] | "";
  cfg.host = d["host"] | "espressos";
  cfg.adminPass = d["adminPass"] | "";
  cfg.tz = d["tz"] | cfg.tz.c_str();
  cfg.sda = d["sda"] | 21;
  cfg.scl = d["scl"] | 22;
}

static void saveConfig() {
  JsonDocument d;
  d["ssid"] = cfg.ssid;
  d["pass"] = cfg.pass;
  d["host"] = cfg.host;
  d["adminPass"] = cfg.adminPass;
  d["tz"] = cfg.tz;
  d["sda"] = cfg.sda;
  d["scl"] = cfg.scl;
  String s;
  serializeJson(d, s);
  writeFile(kConfigFile, s.c_str(), s.length());
}

// ------------------------------------------------------------------ engine
// Validates + loads a program into the engine and the sensor manager.
static bool deploy(const char* json, String& err) {
  JsonDocument doc;
  if (DeserializationError e = deserializeJson(doc, json)) { err = String("JSON: ") + e.c_str(); return false; }
  JsonArrayConst devs = doc["devices"].as<JsonArrayConst>();
  if (!Sensors::validate(devs, err)) return false;
  // Engine and sensors are swapped together while the scan task is held off,
  // so no SENSOR block can read a device that is being replaced.
  std::string eerr;
  xSemaphoreTake(engineLock, portMAX_DELAY);
  bool ok = engine.load(json, eerr);
  if (ok) {
    Sensors::configure(devs);
    engine.run();
  }
  xSemaphoreGive(engineLock);
  if (!ok) err = eerr.c_str();
  return ok;
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
static void startWifi() {
  WiFi.setHostname(cfg.host.c_str());
  if (cfg.ssid.length()) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
    Serial.printf("Connecting to %s", cfg.ssid.c_str());
    for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; i++) {
      delay(250);
      Serial.print('.');
    }
    Serial.println();
  }
  if (WiFi.status() == WL_CONNECTED) {
    apMode = false;
    WiFi.setAutoReconnect(true);
    Serial.printf("IP: %s\n", WiFi.localIP().toString().c_str());
    configTzTime(cfg.tz.c_str(), "pool.ntp.org", "time.google.com");
  } else {
    apMode = true;
    uint64_t mac = ESP.getEfuseMac();
    char name[32];
    snprintf(name, sizeof name, "EspressOS-%04X", (unsigned)(mac >> 32) & 0xFFFF);
    WiFi.mode(WIFI_AP);
    WiFi.softAP(name);
    dns.start(53, "*", WiFi.softAPIP());
    Serial.printf("Setup AP '%s' at %s\n", name, WiFi.softAPIP().toString().c_str());
  }
  if (MDNS.begin(cfg.host.c_str())) MDNS.addService("http", "tcp", 80);
}

// ------------------------------------------------------------------ http
static void sendJson(AsyncWebServerRequest* r, int code, const String& body) {
  r->send(code, "application/json", body);
}

static void sendResult(AsyncWebServerRequest* r, bool ok, const String& err) {
  JsonDocument d;
  d["ok"] = ok;
  if (!ok) d["err"] = err;
  String s;
  serializeJson(d, s);
  sendJson(r, ok ? 200 : 400, s);
}

// Collects a request body into _tempObject (freed by the library).
static void collectBody(AsyncWebServerRequest* r, uint8_t* data, size_t len, size_t index, size_t total) {
  if (total > 64 * 1024) return;
  if (index == 0) {
    r->_tempObject = malloc(total + 1);
    if (!r->_tempObject) return;
  }
  if (!r->_tempObject) return;
  memcpy((uint8_t*)r->_tempObject + index, data, len);
  if (index + len == total) ((char*)r->_tempObject)[total] = 0;
}

static const char* body(AsyncWebServerRequest* r) { return r->_tempObject ? (const char*)r->_tempObject : nullptr; }

static void setupRoutes() {
  if (cfg.adminPass.length()) {
    authMw.setUsername("admin");
    authMw.setPassword(cfg.adminPass.c_str());
    authMw.setRealm("EspressOS");
    authMw.setAuthType(AsyncAuthType::AUTH_BASIC);
    authMw.generateHash();
    server.addMiddleware(&authMw);
  }

  server.on("/api/info", HTTP_GET, [](AsyncWebServerRequest* r) {
    JsonDocument d;
    d["version"] = EOS_VERSION;
    d["uptime"] = millis() / 1000;
    d["heap"] = ESP.getFreeHeap();
    d["ap"] = apMode;
    d["ip"] = apMode ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
    d["rssi"] = apMode ? 0 : WiFi.RSSI();
    d["host"] = cfg.host;
    xSemaphoreTake(engineLock, portMAX_DELAY);
    d["running"] = engine.running();
    d["blocks"] = engine.blockCount();
    d["cycleMs"] = engine.cycleMs();
    d["cycles"] = engine.cycles();
    xSemaphoreGive(engineLock);
    d["error"] = lastError;
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
        if (!b) return sendResult(r, false, "Empty or too large body");
        String err;
        bool ok = deploy(b, err);
        if (ok) {
          writeFile(kProgramFile, b, strlen(b));
          writeFile(kRunFlagFile, "1", 1);
          lastError = "";
        } else {
          lastError = err;
        }
        sendResult(r, ok, err);
      },
      nullptr, collectBody);

  server.on("/api/run", HTTP_POST, [](AsyncWebServerRequest* r) {
    xSemaphoreTake(engineLock, portMAX_DELAY);
    engine.run();
    xSemaphoreGive(engineLock);
    writeFile(kRunFlagFile, "1", 1);
    sendResult(r, true, "");
  });

  server.on("/api/stop", HTTP_POST, [](AsyncWebServerRequest* r) {
    xSemaphoreTake(engineLock, portMAX_DELAY);
    engine.stop();
    xSemaphoreGive(engineLock);
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
    d["sda"] = cfg.sda;
    d["scl"] = cfg.scl;
    d["hasAdminPass"] = cfg.adminPass.length() > 0;
    String s;
    serializeJson(d, s);
    sendJson(r, 200, s);
  });

  server.on(
      "/api/config", HTTP_POST,
      [](AsyncWebServerRequest* r) {
        JsonDocument d;
        if (!body(r) || deserializeJson(d, body(r))) return sendResult(r, false, "Bad JSON");
        if (d["ssid"].is<const char*>()) cfg.ssid = d["ssid"].as<const char*>();
        if (d["pass"].is<const char*>()) cfg.pass = d["pass"].as<const char*>();  // only sent when changed
        if (d["host"].is<const char*>()) cfg.host = d["host"].as<const char*>();
        if (d["tz"].is<const char*>()) cfg.tz = d["tz"].as<const char*>();
        if (d["adminPass"].is<const char*>()) cfg.adminPass = d["adminPass"].as<const char*>();
        if (d["sda"].is<int>()) cfg.sda = d["sda"];
        if (d["scl"].is<int>()) cfg.scl = d["scl"];
        saveConfig();
        sendResult(r, true, "");
      },
      nullptr, collectBody);

  server.on("/api/reboot", HTTP_POST, [](AsyncWebServerRequest* r) {
    sendResult(r, true, "");
    xTaskCreate([](void*) { delay(500); ESP.restart(); }, "reboot", 2048, nullptr, 1, nullptr);
  });

  // Firmware update: multipart upload of a .bin built by PlatformIO / CI.
  server.on(
      "/api/ota", HTTP_POST,
      [](AsyncWebServerRequest* r) {
        bool ok = !Update.hasError();
        sendResult(r, ok, ok ? "" : Update.errorString());
        if (ok) xTaskCreate([](void*) { delay(800); ESP.restart(); }, "reboot", 2048, nullptr, 1, nullptr);
      },
      [](AsyncWebServerRequest* r, const String& filename, size_t index, uint8_t* data, size_t len, bool final) {
        if (index == 0) {
          xSemaphoreTake(engineLock, portMAX_DELAY);
          engine.stop();
          xSemaphoreGive(engineLock);
          int cmd = filename.indexOf("littlefs") >= 0 ? U_SPIFFS : U_FLASH;
          if (!Update.begin(UPDATE_SIZE_UNKNOWN, cmd)) Update.printError(Serial);
        }
        if (len && Update.write(data, len) != len) Update.printError(Serial);
        if (final && !Update.end(true)) Update.printError(Serial);
      });

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
  engineLock = xSemaphoreCreateMutex();
  Sensors::begin(cfg.sda, cfg.scl);

  String prog = readFile(kProgramFile);
  if (prog.length()) {
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
  static uint32_t lastPush = 0;
  if (millis() - lastPush >= 250) {
    lastPush = millis();
    ws.cleanupClients();
    if (ws.count() && ws.availableForWriteAll()) ws.textAll(monitorJson());
  }
  delay(5);
}
