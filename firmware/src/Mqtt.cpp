#include "Mqtt.h"

#include <ArduinoJson.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <ctype.h>

#include <algorithm>
#include <math.h>
#include <string.h>

#include "Engine.h"
#include "EspHal.h"

#ifndef EOS_VERSION
#define EOS_VERSION "dev"
#endif

namespace Mqtt {
namespace {

// ---------------------------------------------------------------- shared state (under `lock`)
struct InSlot {
  char topic[eos::kMaxTopicLen + 1] = "";
  float v = 0;
  bool has = false, used = false;
};
struct OutSlot {
  char topic[eos::kMaxTopicLen + 1] = "";
  char payload[24] = "";
  bool retain = true, dirty = false, used = false;
};

SemaphoreHandle_t lock;
InSlot ins[eos::kMaxMqtt];
OutSlot outs[eos::kMaxMqtt];
bool topicsChanged = false;
Settings want;
bool settingsChanged = false;
std::vector<Entity> wantEntities;
bool entitiesChanged = false;

struct Lock {
  Lock() { xSemaphoreTake(lock, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(lock); }
};

// ---------------------------------------------------------------- task state
enum State { kOff, kNoWifi, kConnecting, kConnected, kFailed };
volatile State state = kOff;
volatile int lastRc = 0;
volatile uint32_t pulseMs = 300;

EspHal* hal = nullptr;
String hostName, nodeId;
WiFiClient net;
PubSubClient client(net);
Settings cur;
std::vector<Entity> entities;
std::vector<String> subscribed;
std::vector<String> announced;  // discovery topics published by us
bool subsDirty = true;
float lastVin[EspHal::kVirtual];
uint32_t pulseUntil[EspHal::kVirtual];
uint32_t lastAttempt = 0;

String base() { return cur.base.length() ? cur.base : "espressos/" + hostName; }
String vinTopic(int idx) { return base() + "/v" + idx; }

const Entity* entityFor(int idx) {
  for (const auto& e : entities)
    if (e.idx == idx) return &e;
  return nullptr;
}

void fmtNum(char* buf, size_t n, float x) {
  snprintf(buf, n, "%.3f", (double)x);
  char* e = buf + strlen(buf) - 1;
  while (*e == '0') *e-- = 0;
  if (*e == '.') *e = 0;
  if (!strcmp(buf, "-0")) snprintf(buf, n, "0");
}

void onMessage(char* topic, byte* payload, unsigned int len) {
  char text[64];
  if (len >= sizeof text) len = sizeof text - 1;
  memcpy(text, payload, len);
  text[len] = 0;
  float v;
  bool ok = parsePayload(text, &v);
  {
    Lock l;
    for (auto& s : ins)
      if (s.used && ok && !strcmp(s.topic, topic)) {
        s.v = v;
        s.has = true;
      }
  }
  // Web controls: <base>/v<idx>/set
  String prefix = base() + "/v";
  String t(topic);
  if (!t.startsWith(prefix) || !t.endsWith("/set")) return;
  int idx = t.substring(prefix.length(), t.length() - 4).toInt();
  const Entity* e = entityFor(idx);
  if (!e || !ok) return;
  if (e->kind == 'b') {
    bool press = !strcasecmp(text, "press");
    hal->vin[idx] = v >= 0.5f ? 1 : 0;
    pulseUntil[idx] = press ? (millis() + pulseMs) | 1 : 0;  // PRESS = short pulse, ON/OFF = hold/release
  } else if (e->kind == 's') {
    hal->vin[idx] = v >= 0.5f ? 1 : 0;
  } else {
    hal->vin[idx] = fminf(fmaxf(v, e->min), e->max);
  }
}

// ---------------------------------------------------------------- broker side
void syncSubscriptions() {
  std::vector<String> desired;
  {
    Lock l;
    for (const auto& s : ins)
      if (s.used) desired.push_back(s.topic);
  }
  for (const auto& e : entities) desired.push_back(vinTopic(e.idx) + "/set");
  bool ok = true;
  for (const auto& t : subscribed)
    if (std::find(desired.begin(), desired.end(), t) == desired.end()) client.unsubscribe(t.c_str());
  std::vector<String> now;
  for (const auto& t : desired) {
    if (std::find(now.begin(), now.end(), t) != now.end()) continue;
    bool had = std::find(subscribed.begin(), subscribed.end(), t) != subscribed.end();
    if (had || client.subscribe(t.c_str())) now.push_back(t);
    else ok = false;
  }
  subscribed = now;
  subsDirty = !ok;  // retry the ones that failed
}

String discoveryTopic(const Entity& e) {
  const char* comp = e.kind == 's' ? "switch" : e.kind == 'b' ? "button" : "number";
  return cur.haPrefix + "/" + comp + "/" + nodeId + "/v" + e.idx + "/config";
}

String discoveryPayload(const Entity& e) {
  JsonDocument d;
  String v = "~/v" + String(e.idx);
  d["~"] = base();
  d["name"] = e.name.length() ? e.name : "V" + String(e.idx);
  d["uniq_id"] = nodeId + "_v" + e.idx;
  d["avty_t"] = "~/status";
  d["cmd_t"] = v + "/set";
  if (e.kind == 'b') {
    d["pl_prs"] = "PRESS";
  } else {
    d["stat_t"] = v;
  }
  if (e.kind == 'n') {
    d["min"] = e.min;
    d["max"] = e.max;
    d["step"] = e.step > 0 ? e.step : 1;
    d["mode"] = "slider";
  }
  JsonObject dev = d["dev"].to<JsonObject>();
  dev["ids"].add(nodeId);
  dev["name"] = hostName;
  dev["mf"] = "EspressOS";
  dev["mdl"] = "ESP32";
  dev["sw"] = EOS_VERSION;
  dev["cu"] = "http://" + WiFi.localIP().toString() + "/";
  String s;
  serializeJson(d, s);
  return s;
}

void syncDiscovery() {
  std::vector<String> desired;
  if (cur.ha)
    for (const auto& e : entities) {
      String t = discoveryTopic(e);
      if (std::find(desired.begin(), desired.end(), t) != desired.end()) continue;  // two blocks, one slot
      desired.push_back(t);
      client.publish(t.c_str(), discoveryPayload(e).c_str(), true);
    }
  for (const auto& t : announced)
    if (std::find(desired.begin(), desired.end(), t) == desired.end()) client.publish(t.c_str(), "", true);  // removes the entity
  announced = desired;
}

void publishVins(bool force) {
  for (const auto& e : entities) {
    float v = hal->vin[e.idx];
    if (!force && v == lastVin[e.idx]) continue;
    char buf[24];
    if (e.kind == 'n') fmtNum(buf, sizeof buf, v);
    else snprintf(buf, sizeof buf, "%s", v >= 0.5f ? "ON" : "OFF");
    if (client.publish(vinTopic(e.idx).c_str(), buf, true)) lastVin[e.idx] = v;
  }
}

void flushOuts() {
  for (int i = 0; i < eos::kMaxMqtt; i++) {
    char topic[eos::kMaxTopicLen + 1], payload[24];
    bool retain;
    {
      Lock l;
      OutSlot& s = outs[i];
      if (!s.used || !s.dirty) continue;
      memcpy(topic, s.topic, sizeof topic);
      memcpy(payload, s.payload, sizeof payload);
      retain = s.retain;
      s.dirty = false;
    }
    if (!client.publish(topic, payload, retain)) {
      Lock l;
      if (!strcmp(outs[i].payload, payload)) outs[i].dirty = true;  // try again unless a newer value came
    }
  }
}

bool connectNow() {
  state = kConnecting;
  client.setServer(cur.host.c_str(), cur.port);
  String will = base() + "/status";
  bool ok = client.connect(nodeId.c_str(), cur.user.length() ? cur.user.c_str() : nullptr,
                           cur.user.length() ? cur.pass.c_str() : nullptr, will.c_str(), 0, true, "offline", true);
  lastRc = client.state();
  if (!ok) {
    state = kFailed;
    return false;
  }
  client.publish(will.c_str(), "online", true);
  subscribed.clear();  // clean session: the broker forgot them
  {
    Lock l;
    for (auto& s : outs)
      if (s.used && s.payload[0]) s.dirty = true;
  }
  state = kConnected;
  Serial.printf("MQTT connected to %s:%d\n", cur.host.c_str(), cur.port);
  return true;
}

void dropConnection() {
  if (client.connected()) {
    for (const auto& t : announced) client.publish(t.c_str(), "", true);
    client.publish((base() + "/status").c_str(), "offline", true);
    client.disconnect();
  }
  announced.clear();
  subscribed.clear();
}

void task(void*) {
  for (;;) {
    bool reconfig = false, ents = false, tops = false;
    Settings s;
    std::vector<Entity> e;
    {
      Lock l;
      if (settingsChanged) { s = want; settingsChanged = false; reconfig = true; }
      if (entitiesChanged) { e = wantEntities; entitiesChanged = false; ents = true; }
      if (topicsChanged) { topicsChanged = false; tops = true; }
    }
    if (reconfig) {
      dropConnection();
      cur = s;
      lastAttempt = 0;
    }
    if (ents) {
      entities = e;
      for (float& v : lastVin) v = NAN;
    }
    if (cur.host.isEmpty()) {
      state = kOff;
      delay(500);
      continue;
    }
    if (WiFi.status() != WL_CONNECTED) {
      state = kNoWifi;
      if (client.connected()) client.disconnect();
      delay(500);
      continue;
    }
    bool fresh = false;
    if (!client.connected()) {
      if (state == kConnected) { state = kConnecting; lastRc = client.state(); }
      if (lastAttempt && millis() - lastAttempt < 5000) { delay(100); continue; }
      lastAttempt = millis() | 1;
      if (!connectNow()) { delay(100); continue; }
      fresh = true;
    }
    client.loop();
    if (fresh || tops || ents || subsDirty) syncSubscriptions();
    if (fresh || ents || reconfig) syncDiscovery();
    flushOuts();
    publishVins(fresh);
    for (int i = 0; i < EspHal::kVirtual; i++)
      if (pulseUntil[i] && (int32_t)(millis() - pulseUntil[i]) >= 0) {
        pulseUntil[i] = 0;
        hal->vin[i] = 0;
      }
    delay(20);
  }
}

}  // namespace

// ---------------------------------------------------------------- public
void begin(EspHal* h, const String& hostname, const Settings& s) {
  hal = h;
  hostName = hostname;
  char id[20];
  snprintf(id, sizeof id, "eos_%012llx", (unsigned long long)ESP.getEfuseMac());
  nodeId = id;
  for (float& v : lastVin) v = NAN;
  lock = xSemaphoreCreateMutex();
  want = s;
  settingsChanged = true;
  client.setBufferSize(1024);
  client.setKeepAlive(30);
  client.setSocketTimeout(5);
  client.setCallback(onMessage);
  xTaskCreatePinnedToCore(task, "mqtt", 8192, nullptr, 1, nullptr, 0);
}

void configure(const Settings& s) {
  Lock l;
  want = s;
  settingsChanged = true;
}

void setEntities(const std::vector<Entity>& e) {
  Lock l;
  wantEntities = e;
  entitiesChanged = true;
}

void setCycleMs(uint32_t ms) { pulseMs = ms * 2 > 300 ? ms * 2 : 300; }

bool connected() { return state == kConnected; }

String statusText() {
  switch (state) {
    case kOff: return "off";
    case kNoWifi: return "waiting for Wi-Fi";
    case kConnecting: return "connecting";
    case kConnected: return "connected";
    case kFailed: break;
  }
  switch (lastRc) {
    case -4: return "broker does not answer (retrying)";
    case -2: return "cannot reach the broker (retrying)";
    case 1: return "broker refused the protocol version";
    case 2: return "broker refused the client id";
    case 3: return "broker unavailable (retrying)";
    case 4: return "wrong user name or password";
    case 5: return "not authorised by the broker";
    default: return "not connected (retrying)";
  }
}

void resetTopics() {
  Lock l;
  for (auto& s : ins) s.used = false;
  for (auto& s : outs) s.used = false;
  topicsChanged = true;
}

int subscribe(const char* topic) {
  Lock l;
  for (int i = 0; i < eos::kMaxMqtt; i++)
    if (!strcmp(ins[i].topic, topic)) {  // same topic as before: keep its last value
      ins[i].used = true;
      return i;
    }
  for (int i = 0; i < eos::kMaxMqtt; i++)
    if (!ins[i].used) {
      InSlot& s = ins[i];
      snprintf(s.topic, sizeof s.topic, "%s", topic);
      s.has = false;
      s.v = 0;
      s.used = true;
      return i;
    }
  return -1;
}

bool value(int h, float* v) {
  if (h < 0 || h >= eos::kMaxMqtt) return false;
  Lock l;
  if (!ins[h].used || !ins[h].has) return false;
  *v = ins[h].v;
  return true;
}

int advertise(const char* topic, bool retain) {
  Lock l;
  int pick = -1;
  for (int i = 0; i < eos::kMaxMqtt && pick < 0; i++)
    if (!strcmp(outs[i].topic, topic)) pick = i;
  for (int i = 0; i < eos::kMaxMqtt && pick < 0; i++)
    if (!outs[i].used) pick = i;
  if (pick < 0) return -1;
  OutSlot& s = outs[pick];
  if (strcmp(s.topic, topic)) {
    snprintf(s.topic, sizeof s.topic, "%s", topic);
    s.payload[0] = 0;
    s.dirty = false;
  }
  s.retain = retain;
  s.used = true;
  return pick;
}

void publish(int h, const char* payload) {
  if (h < 0 || h >= eos::kMaxMqtt) return;
  Lock l;
  snprintf(outs[h].payload, sizeof outs[h].payload, "%s", payload);
  outs[h].dirty = true;
}

bool parsePayload(const char* text, float* v) {
  char b[40];
  while (isspace((unsigned char)*text)) text++;
  size_t n = strlen(text);
  while (n && isspace((unsigned char)text[n - 1])) n--;
  if (n == 0 || n >= sizeof b) return false;
  for (size_t i = 0; i < n; i++) b[i] = (char)tolower((unsigned char)text[i]);
  b[n] = 0;
  static const char* kOn[] = {"on", "true", "open", "yes", "press"};
  static const char* kOff[] = {"off", "false", "closed", "no"};
  for (const char* w : kOn)
    if (!strcmp(b, w)) { *v = 1; return true; }
  for (const char* w : kOff)
    if (!strcmp(b, w)) { *v = 0; return true; }
  // [-+]digits[.digits][e[-+]digits], same as the JS check
  const char* p = b;
  if (*p == '+' || *p == '-') p++;
  int digits = 0;
  while (isdigit((unsigned char)*p)) { p++; digits++; }
  if (*p == '.') {
    p++;
    while (isdigit((unsigned char)*p)) { p++; digits++; }
  }
  if (!digits) return false;
  if (*p == 'e') {
    p++;
    if (*p == '+' || *p == '-') p++;
    if (!isdigit((unsigned char)*p)) return false;
    while (isdigit((unsigned char)*p)) p++;
  }
  if (*p) return false;
  *v = strtof(b, nullptr);
  return true;
}

}  // namespace Mqtt
