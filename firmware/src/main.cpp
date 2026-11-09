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
#include "Sensors.h"

#ifndef EOS_VERSION
#define EOS_VERSION "dev"
#endif

static const char* kProgramFile = "/program.json";
static const char* kConfigFile = "/config.json";
static const char* kRunFlagFile = "/run.flag";
static constexpr size_t kMaxBody = 64 * 1024;
static constexpr uint32_t kApFallbackMs = 120000;  // keep trying the router this long before opening the setup AP
static constexpr uint32_t kStaRetryMs = 30000;

struct Config {
  String ssid, pass;  // Wi-Fi password must stay recoverable to connect
  String host = "espressos";
  String adminHash, adminSalt;  // salted SHA-256 of the admin password; empty = setup mode
  String tz = "CET-1CEST,M3.5.0,M10.5.0/3";
  int sda = 21, scl = 22;
};

static Config cfg;
static EspHal hal;
static eos::Engine engine(hal);
static SemaphoreHandle_t engineLock;
static String lastError;
static bool apMode = false;
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

static bool writeFile(const char* path, const char* data, size_t len) {
  File f = LittleFS.open(path, "w");
  if (!f) return false;
  size_t n = f.write((const uint8_t*)data, len);
  f.close();
  return n == len;
}

// ------------------------------------------------------------------ password
static String sha256Hex(const String& s) {
  uint8_t out[32];
  mbedtls_sha256((const uint8_t*)s.c_str(), s.length(), out, 0);
  char hex[65];
  for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", out[i]);
  return String(hex);
}

static bool setupMode() { return cfg.adminHash.isEmpty(); }

static void setAdminPassword(const String& pass) {
  char salt[17];
  snprintf(salt, sizeof salt, "%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random());
  cfg.adminSalt = salt;
  cfg.adminHash = sha256Hex(cfg.adminSalt + pass);
}

static bool passwordMatches(const String& pass) {
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

// ------------------------------------------------------------------ config
static bool validI2cPins(int sda, int scl) { return EspHal::outputCapable(sda) && EspHal::outputCapable(scl) && sda != scl; }

static void loadConfig() {
  JsonDocument d;
  if (deserializeJson(d, readFile(kConfigFile))) return;
  cfg.ssid = d["ssid"] | "";
  cfg.pass = d["pass"] | "";
  cfg.host = d["host"] | "espressos";
  cfg.adminHash = d["adminHash"] | "";
  cfg.adminSalt = d["adminSalt"] | "";
  cfg.tz = d["tz"] | cfg.tz.c_str();
  cfg.sda = d["sda"] | 21;
  cfg.scl = d["scl"] | 22;
  if (!validI2cPins(cfg.sda, cfg.scl)) { cfg.sda = 21; cfg.scl = 22; }  // never let a bad config brick the board
  String legacy = d["adminPass"] | "";  // v0.1.0 stored it in plain text
  if (legacy.length() && cfg.adminHash.isEmpty()) setAdminPassword(legacy);
}

static void saveConfig() {
  JsonDocument d;
  d["ssid"] = cfg.ssid;
  d["pass"] = cfg.pass;
  d["host"] = cfg.host;
  d["adminHash"] = cfg.adminHash;
  d["adminSalt"] = cfg.adminSalt;
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
  WiFi.softAP(name);
  dns.start(53, "*", WiFi.softAPIP());
  apMode = true;
  Serial.printf("Setup AP '%s' at %s\n", name, WiFi.softAPIP().toString().c_str());
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
enum Gate { kOk = 0, kNeedAuth = 401, kForbidden = 403 };

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
  if (!setupMode() && !credentialsOk(r)) return kNeedAuth;
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
// Firmware images start with the ESP image magic 0xE9; anything else is a
// LittleFS (web UI) image. A filesystem image would wipe the program and
// settings, so those are kept in RAM and written back afterwards.
struct Ota {
  bool busy = false;
  bool fs = false;
  bool wasRunning = false;
  bool ok = false;
  AsyncWebServerRequest* req = nullptr;
  String keepProgram, keepConfig, keepRunFlag;
};
static Ota ota;

static void otaFinish(bool ok) {
  if (!ok) Update.abort();
  if (ota.fs) {
    if (!LittleFS.begin(true)) Serial.println("LittleFS mount after update failed");
    if (ota.keepConfig.length()) writeFile(kConfigFile, ota.keepConfig.c_str(), ota.keepConfig.length());
    if (ota.keepProgram.length()) writeFile(kProgramFile, ota.keepProgram.c_str(), ota.keepProgram.length());
    if (ota.keepRunFlag.length()) writeFile(kRunFlagFile, ota.keepRunFlag.c_str(), ota.keepRunFlag.length());
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
    ota.busy = true;
    ota.ok = false;
    ota.req = r;
    ota.fs = data[0] != 0xE9;
    ota.wasRunning = engineRunning();
    engineSetRunning(false);  // outputs to safe state while flashing
    if (ota.fs) {
      ota.keepProgram = readFile(kProgramFile);
      ota.keepConfig = readFile(kConfigFile);
      ota.keepRunFlag = readFile(kRunFlagFile);
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
  if (!r->_tempObject) return sendResult(r, false, ota.busy ? "Another update is in progress" : "Update rejected");
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
    if (g == kNeedAuth) return r->requestAuthentication(AsyncAuthType::AUTH_BASIC, "EspressOS");
    if (g == kForbidden) {
      JsonDocument d;
      d["ok"] = false;
      d["err"] = why;
      String s;
      serializeJson(d, s);
      return sendJson(r, 403, s);
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
    d["sda"] = cfg.sda;
    d["scl"] = cfg.scl;
    d["hasAdminPass"] = !setupMode();
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
        int sda = d["sda"].is<int>() ? d["sda"].as<int>() : cfg.sda;
        int scl = d["scl"].is<int>() ? d["scl"].as<int>() : cfg.scl;
        if (!validI2cPins(sda, scl)) return sendResult(r, false, "I2C pins must be two different output-capable GPIOs (not 6-11 or 34-39)");
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
        saveConfig();
        sendResult(r, true, "");
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
  if (readFile(kConfigFile).indexOf("\"adminPass\"") >= 0) saveConfig();  // migrate plain-text password away
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
  wifiTick();
  static uint32_t lastPush = 0;
  if (millis() - lastPush >= 250) {
    lastPush = millis();
    ws.cleanupClients();
    if (ws.count() && ws.availableForWriteAll()) ws.textAll(monitorJson());
  }
  delay(5);
}
