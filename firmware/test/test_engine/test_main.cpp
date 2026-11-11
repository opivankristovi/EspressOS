// Native engine tests: pio test -e native
#include <unity.h>

#include <ArduinoJson.h>
#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "Board.h"
#include "Engine.h"

using namespace eos;

struct FakeHal : Hal {
  std::map<int, bool> din, dout;
  std::map<int, float> vin;
  std::map<int, bool> setupLevel;  // level an output was configured with
  int safeCalls = 0;
  void setupOutput(int pin, bool level) override { setupLevel[pin] = level; dout[pin] = level; }
  bool readDigital(int pin) override { return din[pin]; }
  void writeDigital(int pin, bool v) override { dout[pin] = v; }
  float readVirtual(int i) override { return vin[i]; }
  void safeOutputs() override { safeCalls++; dout.clear(); }
  // MQTT: topics by handle, like the firmware's slot tables
  std::vector<std::string> subs, pubs;
  std::map<std::string, float> msg;                        // last message per topic
  std::vector<std::pair<std::string, std::string>> sent;   // (topic, payload)
  int beginCalls = 0;
  void beginProgram() override { beginCalls++; subs.clear(); pubs.clear(); }
  int mqttSubscribe(const char* t) override { subs.push_back(t); return (int)subs.size() - 1; }
  bool mqttValue(int h, float* v) override {
    auto it = msg.find(subs[h]);
    if (it == msg.end()) return false;
    *v = it->second;
    return true;
  }
  int mqttAdvertise(const char* t, bool) override { pubs.push_back(t); return (int)pubs.size() - 1; }
  void mqttPublish(int h, const char* p) override { sent.push_back({pubs[h], p}); }
  const char* pinProblem(int pin, PinUse use) override {
    if (pin == 7) return "belongs to the flash chip";
    if (pin == 34 && use == PinUse::DigitalOut) return "is input-only";
    return nullptr;
  }
};

static FakeHal hal;
static Engine* eng;

static void load(const char* json) {
  std::string err;
  bool ok = eng->load(json, err);
  if (!ok) TEST_FAIL_MESSAGE(err.c_str());
  eng->run();
}

void setUp() { hal = FakeHal(); eng = new Engine(hal); }
void tearDown() { delete eng; }

// VIN 0,1 -> AND/OR/XOR/NAND/NOR
static const char* kGates =
    R"({"blocks":[{"id":1,"type":"VIN","p":{"idx":0}},{"id":2,"type":"VIN","p":{"idx":1}},
    {"id":3,"type":"AND"},{"id":4,"type":"OR"},{"id":5,"type":"XOR"},{"id":6,"type":"NAND"},{"id":7,"type":"NOR"},{"id":8,"type":"NOT"}],
    "wires":[[1,0,3,0],[2,0,3,1],[1,0,4,0],[2,0,4,1],[1,0,5,0],[2,0,5,1],[1,0,6,0],[2,0,6,1],[1,0,7,0],[2,0,7,1],[1,0,8,0]]})";

void test_gates_truth_table() {
  load(kGates);
  for (int a = 0; a < 2; a++)
    for (int b = 0; b < 2; b++) {
      hal.vin[0] = a; hal.vin[1] = b;
      eng->scan(0);
      TEST_ASSERT_EQUAL_FLOAT(a && b, eng->output(3, 0));
      TEST_ASSERT_EQUAL_FLOAT(a || b, eng->output(4, 0));
      TEST_ASSERT_EQUAL_FLOAT(a ^ b, eng->output(5, 0));
      TEST_ASSERT_EQUAL_FLOAT(!(a && b), eng->output(6, 0));
      TEST_ASSERT_EQUAL_FLOAT(!(a || b), eng->output(7, 0));
      TEST_ASSERT_EQUAL_FLOAT(!a, eng->output(8, 0));
    }
}

void test_order_independent_of_json_order() {
  // DO listed before its source: topo sort must still make it current in one scan.
  load(R"({"blocks":[{"id":3,"type":"DO","p":{"pin":2}},{"id":2,"type":"NOT"},{"id":1,"type":"VIN","p":{"idx":0}}],
          "wires":[[2,0,3,0],[1,0,2,0]]})");
  hal.vin[0] = 0;
  eng->scan(0);
  TEST_ASSERT_TRUE(hal.dout[2]);
  hal.vin[0] = 1;
  eng->scan(10);
  TEST_ASSERT_FALSE(hal.dout[2]);
}

void test_ton() {
  load(R"({"blocks":[{"id":1,"type":"VIN","p":{"idx":0}},{"id":2,"type":"TON","p":{"t":2}}],"wires":[[1,0,2,0]]})");
  hal.vin[0] = 1;
  eng->scan(1000);
  TEST_ASSERT_EQUAL_FLOAT(0, eng->output(2, 0));
  eng->scan(2999);
  TEST_ASSERT_EQUAL_FLOAT(0, eng->output(2, 0));
  eng->scan(3000);
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(2, 0));
  hal.vin[0] = 0;
  eng->scan(3010);
  TEST_ASSERT_EQUAL_FLOAT(0, eng->output(2, 0));
}

void test_tof_and_tp() {
  load(R"({"blocks":[{"id":1,"type":"VIN","p":{"idx":0}},{"id":2,"type":"TOF","p":{"t":1}},{"id":3,"type":"TP","p":{"t":0.5}}],
          "wires":[[1,0,2,0],[1,0,3,0]]})");
  hal.vin[0] = 1; eng->scan(0);
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(2, 0));
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(3, 0));
  hal.vin[0] = 0; eng->scan(100);
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(2, 0));
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(3, 0));  // pulse continues after input drops
  eng->scan(500);
  TEST_ASSERT_EQUAL_FLOAT(0, eng->output(3, 0));
  eng->scan(1099);
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(2, 0));
  eng->scan(1100);
  TEST_ASSERT_EQUAL_FLOAT(0, eng->output(2, 0));
}

void test_sr_latch_reset_priority() {
  load(R"({"blocks":[{"id":1,"type":"VIN","p":{"idx":0}},{"id":2,"type":"VIN","p":{"idx":1}},{"id":3,"type":"SR"}],
          "wires":[[1,0,3,0],[2,0,3,1]]})");
  hal.vin[0] = 1; eng->scan(0);
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(3, 0));
  hal.vin[0] = 0; eng->scan(1);
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(3, 0));
  hal.vin[0] = 1; hal.vin[1] = 1; eng->scan(2);
  TEST_ASSERT_EQUAL_FLOAT(0, eng->output(3, 0));
}

void test_feedback_loop_one_cycle_delay() {
  // NOT feeding itself = toggles every cycle.
  load(R"({"blocks":[{"id":1,"type":"NOT"}],"wires":[[1,0,1,0]]})");
  eng->scan(0);
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(1, 0));
  eng->scan(1);
  TEST_ASSERT_EQUAL_FLOAT(0, eng->output(1, 0));
  eng->scan(2);
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(1, 0));
}

void test_counter() {
  load(R"({"blocks":[{"id":1,"type":"VIN","p":{"idx":0}},{"id":2,"type":"VIN","p":{"idx":1}},{"id":3,"type":"CTR","p":{"preset":3}}],
          "wires":[[1,0,3,0],[2,0,3,2]]})");
  for (int i = 0; i < 3; i++) {
    hal.vin[0] = 1; eng->scan(i * 2);
    hal.vin[0] = 0; eng->scan(i * 2 + 1);
  }
  TEST_ASSERT_EQUAL_FLOAT(3, eng->output(3, 1));
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(3, 0));
  hal.vin[1] = 1; eng->scan(10);
  TEST_ASSERT_EQUAL_FLOAT(0, eng->output(3, 1));
}

void test_thresh_hysteresis_and_math() {
  load(R"({"blocks":[{"id":1,"type":"VIN","p":{"idx":0}},{"id":2,"type":"MATH","p":{"op":"*","b":10}},
          {"id":3,"type":"THRESH","p":{"on":25,"off":20}}],"wires":[[1,0,2,0],[2,0,3,0]]})");
  hal.vin[0] = 2.4f; eng->scan(0);
  TEST_ASSERT_EQUAL_FLOAT(0, eng->output(3, 0));
  hal.vin[0] = 2.5f; eng->scan(1);
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(3, 0));
  hal.vin[0] = 2.1f; eng->scan(2);
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(3, 0));
  hal.vin[0] = 2.0f; eng->scan(3);
  TEST_ASSERT_EQUAL_FLOAT(0, eng->output(3, 0));
}

void test_invalid_programs_rejected_and_old_kept() {
  load(R"({"blocks":[{"id":1,"type":"CONST","p":{"value":7}}],"wires":[]})");
  std::string err;
  TEST_ASSERT_FALSE(eng->load(R"({"blocks":[{"id":1,"type":"BOGUS"}],"wires":[]})", err));
  TEST_ASSERT_FALSE(eng->load(R"({"blocks":[{"id":1,"type":"NOT"},{"id":1,"type":"NOT"}],"wires":[]})", err));
  TEST_ASSERT_FALSE(eng->load(R"({"blocks":[{"id":1,"type":"NOT"}],"wires":[[1,0,1,3]]})", err));
  TEST_ASSERT_FALSE(eng->load(R"({"blocks":[{"id":1,"type":"NOT"},{"id":2,"type":"NOT"},{"id":3,"type":"NOT"}],
                                  "wires":[[1,0,3,0],[2,0,3,0]]})", err));
  TEST_ASSERT_FALSE(eng->load("{not json", err));
  eng->scan(0);
  TEST_ASSERT_EQUAL_FLOAT(7, eng->output(1, 0));
}

void test_stop_sets_outputs_safe() {
  load(R"({"blocks":[{"id":1,"type":"CONST","p":{"value":1}},{"id":2,"type":"DO","p":{"pin":4}}],"wires":[[1,0,2,0]]})");
  eng->scan(0);
  TEST_ASSERT_TRUE(hal.dout[4]);
  int before = hal.safeCalls;
  eng->stop();
  TEST_ASSERT_EQUAL(before + 1, hal.safeCalls);
  TEST_ASSERT_FALSE(hal.dout[4]);
}

void test_inverted_output_pin_level_vs_state() {
  load(R"({"blocks":[{"id":1,"type":"VIN","p":{"idx":0}},{"id":2,"type":"DO","p":{"pin":5,"inv":1}}],"wires":[[1,0,2,0]]})");
  hal.vin[0] = 1; eng->scan(0);
  TEST_ASSERT_FALSE(hal.dout[5]);  // active-low: pin pulled low = relay on
  TEST_ASSERT_NOT_NULL(strstr(eng->snapshot().c_str(), "\"2\":[1]"));  // monitor shows logical on
  hal.vin[0] = 0; eng->scan(1);
  TEST_ASSERT_TRUE(hal.dout[5]);
}

void test_stop_then_run_restores_outputs_and_fresh_state() {
  load(R"({"blocks":[{"id":1,"type":"CONST","p":{"value":1}},{"id":2,"type":"DO","p":{"pin":4}},
          {"id":3,"type":"TON","p":{"t":2}}],"wires":[[1,0,2,0],[1,0,3,0]]})");
  eng->scan(0);
  eng->scan(1500);
  TEST_ASSERT_TRUE(hal.dout[4]);
  eng->stop();
  TEST_ASSERT_FALSE(hal.dout[4]);
  eng->run();
  eng->scan(10000);  // timer must restart, not fire from its old start time
  TEST_ASSERT_TRUE(hal.dout[4]);  // output re-armed and driven again
  TEST_ASSERT_EQUAL_FLOAT(0, eng->output(3, 0));
  eng->scan(12000);
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(3, 0));
}

void test_inverted_output_starts_at_off_level() {
  load(R"({"blocks":[{"id":1,"type":"DO","p":{"pin":5,"inv":1}}],"wires":[]})");
  TEST_ASSERT_TRUE(hal.setupLevel.count(5) && hal.setupLevel[5]);  // HIGH = active-low relay off
  eng->scan(0);
  TEST_ASSERT_TRUE(hal.dout[5]);
}

static std::string loadErr(const char* json) {
  std::string err;
  TEST_ASSERT_FALSE_MESSAGE(eng->load(json, err), "program should be rejected");
  return err;
}

void test_bad_pins_rejected() {
  TEST_ASSERT_EQUAL_STRING("Block 1: GPIO 7 belongs to the flash chip", loadErr(R"({"blocks":[{"id":1,"type":"DO","p":{"pin":7}}],"wires":[]})").c_str());
  TEST_ASSERT_EQUAL_STRING("Block 2: GPIO 34 is input-only", loadErr(R"({"blocks":[{"id":2,"type":"DO","p":{"pin":34}}],"wires":[]})").c_str());
  TEST_ASSERT_EQUAL_STRING("Block 3 has no GPIO pin", loadErr(R"({"blocks":[{"id":3,"type":"DI","p":{}}],"wires":[]})").c_str());
  TEST_ASSERT_EQUAL_STRING("GPIO 4 is used by block 1 and block 2",
                           loadErr(R"({"blocks":[{"id":1,"type":"DI","p":{"pin":4}},{"id":2,"type":"DO","p":{"pin":4}}],"wires":[]})").c_str());
  // two inputs may share a pin
  std::string err;
  TEST_ASSERT_TRUE(eng->load(R"({"blocks":[{"id":1,"type":"DI","p":{"pin":4}},{"id":2,"type":"DI","p":{"pin":4}}],"wires":[]})", err));
}

// MQTT in -> value and Q; value -> MQTT out (number), Q -> MQTT out (ON/OFF), every 1 s
static const char* kMqtt =
    R"({"blocks":[{"id":1,"type":"MQTTIN","p":{"topic":"t/in","def":0.75}},
    {"id":2,"type":"MQTTOUT","p":{"topic":"t/num","fmt":"num","dec":2,"every":1}},
    {"id":3,"type":"MQTTOUT","p":{"topic":"t/sw","fmt":"onoff","every":0}}],
    "wires":[[1,0,2,0],[1,1,3,0]]})";

void test_mqtt_in_out() {
  load(kMqtt);
  TEST_ASSERT_EQUAL(1, hal.subs.size());
  TEST_ASSERT_EQUAL(2, hal.pubs.size());
  eng->scan(0);  // no message yet: default value
  TEST_ASSERT_EQUAL_FLOAT(0.75f, eng->output(1, 0));
  TEST_ASSERT_EQUAL_FLOAT(1, eng->output(1, 1));
  TEST_ASSERT_EQUAL(2, hal.sent.size());
  TEST_ASSERT_EQUAL_STRING("0.75", hal.sent[0].second.c_str());
  TEST_ASSERT_EQUAL_STRING("ON", hal.sent[1].second.c_str());
  hal.msg["t/in"] = 21.5f;
  eng->scan(100);  // ON -> ON: nothing new on t/sw; t/num waits for its 1 s interval
  TEST_ASSERT_EQUAL(2, hal.sent.size());
  eng->scan(1000);
  TEST_ASSERT_EQUAL(3, hal.sent.size());
  TEST_ASSERT_EQUAL_STRING("t/num", hal.sent[2].first.c_str());
  TEST_ASSERT_EQUAL_STRING("21.5", hal.sent[2].second.c_str());
  hal.msg["t/in"] = 0;
  eng->scan(1100);
  TEST_ASSERT_EQUAL(4, hal.sent.size());  // the switch reacts at once
  TEST_ASSERT_EQUAL_STRING("OFF", hal.sent[3].second.c_str());
  eng->scan(2000);
  TEST_ASSERT_EQUAL_STRING("0", hal.sent[4].second.c_str());
  eng->scan(3000);
  TEST_ASSERT_EQUAL(5, hal.sent.size());  // unchanged values are not sent again
}

void test_mqtt_topics_checked() {
  std::string err;
  TEST_ASSERT_FALSE(eng->load(R"({"blocks":[{"id":1,"type":"MQTTIN","p":{"topic":""}}],"wires":[]})", err));
  TEST_ASSERT_EQUAL_STRING("Block 1 has no MQTT topic", err.c_str());
  TEST_ASSERT_FALSE(eng->load(R"({"blocks":[{"id":1,"type":"MQTTOUT","p":{"topic":"a/#"}}],"wires":[]})", err));
  TEST_ASSERT_EQUAL_STRING("Block 1 MQTT topic must not contain the wildcards + or #", err.c_str());
  std::string many = R"({"wires":[],"blocks":[)";
  for (int i = 1; i <= 17; i++) many += (i > 1 ? "," : "") + std::string(R"({"id":)") + std::to_string(i) + R"(,"type":"MQTTIN","p":{"topic":"t)" + std::to_string(i) + R"("}})";
  many += "]}";
  TEST_ASSERT_FALSE(eng->load(many.c_str(), err));
  TEST_ASSERT_EQUAL_STRING("More than 16 MQTT topics in one direction", err.c_str());
  int before = hal.beginCalls;
  load(kMqtt);
  TEST_ASSERT_EQUAL(before + 2, hal.beginCalls);  // load + run each start the program fresh
}

void test_snapshot_json() {
  load(R"({"blocks":[{"id":5,"type":"CONST","p":{"value":2.5}}],"wires":[]})");
  eng->scan(0);
  TEST_ASSERT_EQUAL_STRING("{\"run\":1,\"cycle\":1,\"b\":{\"5\":[2.5,0]}}", eng->snapshot().c_str());
}

// ------------------------------------------------------------------ board profiles
// Repository files are found relative to this source (firmware/test/test_engine),
// with fallbacks for a relative __FILE__ and the usual working directory (firmware/).
static std::string readRepoFile(const std::string& rel) {
  std::string here = __FILE__;
  size_t slash = here.find_last_of("/\\");
  std::string dir = slash == std::string::npos ? "." : here.substr(0, slash);
  for (const std::string& path : {dir + "/../../../" + rel, "../" + rel, rel}) {
    std::ifstream f(path, std::ios::binary);
    if (!f) continue;
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
  }
  return "";
}

// The chip tables are read from EspHal.cpp itself so they stay single-sourced
// (tools/test_sim.js does the same for the editor's lists).
static std::vector<int> gOut, gInOnly, gAdc;

static std::vector<int> pinList(const std::string& src, const char* name) {
  std::vector<int> v;
  size_t at = src.find(std::string(name) + "[] = {");
  if (at == std::string::npos) return v;
  at = src.find('{', at) + 1;
  std::string body = src.substr(at, src.find('}', at) - at);
  for (const char* c = body.c_str(); *c;) {
    if (isdigit((unsigned char)*c)) {
      char* end;
      v.push_back((int)strtol(c, &end, 10));
      c = end;
    } else {
      c++;
    }
  }
  return v;
}

static bool inPins(const std::vector<int>& v, int pin) {
  for (int p : v)
    if (p == pin) return true;
  return false;
}
static bool chipOut(int pin) { return inPins(gOut, pin); }
static bool chipValid(int pin) { return chipOut(pin) || inPins(gInOnly, pin); }
static bool chipAdc(int pin) { return inPins(gAdc, pin); }
static const ChipRules kChip = {chipValid, chipOut, chipAdc};

static void loadChipTables() {
  if (!gOut.empty()) return;
  std::string src = readRepoFile("firmware/src/EspHal.cpp");
  gOut = pinList(src, "kOutPins");
  gInOnly = pinList(src, "kInOnlyPins");
  gAdc = pinList(src, "kAdcPins");
  TEST_ASSERT_TRUE_MESSAGE(gOut.size() == 19 && gInOnly.size() == 4 && gAdc.size() == 6, "pin tables not found in firmware/src/EspHal.cpp");
}

static std::string terminals41() {
  std::string s = R"({"schema":1,"id":"t-x","name":"X","terminals":[)";
  for (int i = 1; i <= 41; i++) s += (i > 1 ? "," : "") + std::string(R"({"label":"T)") + std::to_string(i) + R"(","gpio":23,"uses":["di"]})";
  return s + "]}";
}

static std::string oversize() {
  return R"({"schema":1,"id":"t-x","name":"X","terminals":[{"label":"IO1","gpio":23,"uses":["do"]}],"pad":")" + std::string(4100, 'x') + "\"}";
}

void test_board_vectors() {
  loadChipTables();
  std::string text = readRepoFile("tools/board_vectors.json");
  TEST_ASSERT_FALSE_MESSAGE(text.empty(), "tools/board_vectors.json not found");
  JsonDocument doc;
  TEST_ASSERT_FALSE_MESSAGE(deserializeJson(doc, text), "tools/board_vectors.json is not valid JSON");
  int n = 0;
  for (JsonObjectConst c : doc["cases"].as<JsonArrayConst>()) {
    std::string name = c["name"] | "?";
    std::string gen = c["generate"] | "";
    bool want = c["ok"] | false;
    std::string json;
    if (gen == "terminals41") json = terminals41();
    else if (gen == "oversize") json = oversize();
    else if (!gen.empty()) TEST_FAIL_MESSAGE(("unknown generator in case: " + name).c_str());
    else serializeJson(c["profile"], json);
    BoardProfile b;
    std::string err;
    bool got = b.parse(json.c_str(), err, kChip);
    std::string msg = name + (got ? ": accepted" : ": rejected (" + err + ")");
    TEST_ASSERT_TRUE_MESSAGE(got == want, msg.c_str());
    TEST_ASSERT_TRUE_MESSAGE(got || !err.empty(), msg.c_str());  // a rejection always says why
    n++;
  }
  TEST_ASSERT_TRUE_MESSAGE(n >= 40, "too few cases read from tools/board_vectors.json");
}

static const char* kMb1 = R"({"schema":1,"id":"eos-mb1","name":"MB-1 Analog + 4 SSR","rev":"A",
  "i2c":{"sda":21,"scl":22},"onewire":[4],"terminals":[
  {"label":"AI1","gpio":36,"uses":["ai","di"],"group":"Analog in","note":"0-3.3 V, divider on board"},
  {"label":"AI2","gpio":39,"uses":["ai","di"],"group":"Analog in"},
  {"label":"AI3","gpio":34,"uses":["ai","di"],"group":"Analog in"},
  {"label":"AI4","gpio":35,"uses":["ai","di"],"group":"Analog in"},
  {"label":"AI5","gpio":32,"uses":["ai","di"],"group":"Analog in"},
  {"label":"AI6","gpio":33,"uses":["ai","di"],"group":"Analog in"},
  {"label":"R1","gpio":16,"uses":["do"],"active":"high","group":"Relays","note":"G3MB-202P SSR, AC loads 0.1-2 A"},
  {"label":"R2","gpio":17,"uses":["do"],"active":"high","group":"Relays"},
  {"label":"R3","gpio":18,"uses":["do"],"active":"high","group":"Relays"},
  {"label":"R4","gpio":19,"uses":["do"],"active":"high","group":"Relays"},
  {"label":"IO1","gpio":23,"uses":["di","do","pwm"],"group":"GPIO"},
  {"label":"IO2","gpio":25,"uses":["di","do","pwm"],"group":"GPIO"},
  {"label":"IO3","gpio":26,"uses":["di","do","pwm"],"group":"GPIO"},
  {"label":"IO4","gpio":27,"uses":["di","do","pwm"],"group":"GPIO"},
  {"label":"IO5","gpio":13,"uses":["di","do","pwm"],"group":"GPIO"},
  {"label":"IO6","gpio":14,"uses":["di"],"group":"GPIO","note":"input only: pulses at boot"}]})";

void test_board_preset_queries() {
  loadChipTables();
  BoardProfile b;
  std::string err;
  TEST_ASSERT_TRUE_MESSAGE(b.parse(kMb1, err, kChip), err.c_str());
  TEST_ASSERT_FALSE(b.bare());
  TEST_ASSERT_EQUAL_STRING("eos-mb1", b.id());
  TEST_ASSERT_EQUAL_STRING("MB-1 Analog + 4 SSR", b.name());
  // allows(): only the listed uses of wired terminals
  TEST_ASSERT_TRUE(b.allows(16, PinUse::DigitalOut));
  TEST_ASSERT_FALSE(b.allows(16, PinUse::DigitalIn));
  TEST_ASSERT_FALSE(b.allows(16, PinUse::PwmOut));
  TEST_ASSERT_TRUE(b.allows(36, PinUse::AnalogIn));
  TEST_ASSERT_TRUE(b.allows(36, PinUse::DigitalIn));
  TEST_ASSERT_FALSE(b.allows(36, PinUse::DigitalOut));
  TEST_ASSERT_TRUE(b.allows(23, PinUse::PwmOut));
  TEST_ASSERT_FALSE(b.allows(23, PinUse::AnalogIn));
  TEST_ASSERT_TRUE(b.allows(14, PinUse::DigitalIn));
  TEST_ASSERT_FALSE(b.allows(14, PinUse::DigitalOut));
  TEST_ASSERT_FALSE(b.allows(2, PinUse::DigitalOut));   // chip-valid but not wired
  TEST_ASSERT_FALSE(b.allows(21, PinUse::DigitalIn));   // I2C bus
  TEST_ASSERT_FALSE(b.allows(4, PinUse::DigitalOut));   // 1-Wire
  TEST_ASSERT_FALSE(b.allows(-1, PinUse::DigitalIn));
  TEST_ASSERT_EQUAL(0, b.uses(2));
  TEST_ASSERT_EQUAL(BoardProfile::kDI | BoardProfile::kAI, b.uses(36));
  // fixedInv(): relays are active-high, everything else is free
  TEST_ASSERT_EQUAL(0, b.fixedInv(16));
  TEST_ASSERT_EQUAL(0, b.fixedInv(19));
  TEST_ASSERT_EQUAL(-1, b.fixedInv(23));
  TEST_ASSERT_EQUAL(-1, b.fixedInv(2));
  TEST_ASSERT_EQUAL(-1, b.fixedInv(99));
  // buses
  TEST_ASSERT_TRUE(b.hasI2c());
  TEST_ASSERT_EQUAL(21, b.sda());
  TEST_ASSERT_EQUAL(22, b.scl());
  TEST_ASSERT_TRUE(b.oneWireOk(4));
  TEST_ASSERT_FALSE(b.oneWireOk(23));
  TEST_ASSERT_FALSE(b.oneWireOk(-1));
  TEST_ASSERT_TRUE(b.reservedBus(21));
  TEST_ASSERT_TRUE(b.reservedBus(22));
  TEST_ASSERT_TRUE(b.reservedBus(4));
  TEST_ASSERT_FALSE(b.reservedBus(16));
  TEST_ASSERT_FALSE(b.reservedBus(-1));
}

void test_board_active_low_and_no_bus() {
  loadChipTables();
  BoardProfile b;
  std::string err;
  TEST_ASSERT_TRUE_MESSAGE(b.parse(R"({"schema":1,"id":"t-opto","name":"Opto","i2c":null,"terminals":[
      {"label":"DI1","gpio":36,"uses":["di"],"active":"low","pull":false},{"label":"Q1","gpio":25,"uses":["do","pwm"]}]})", err, kChip), err.c_str());
  TEST_ASSERT_EQUAL(1, b.fixedInv(36));
  TEST_ASSERT_EQUAL(-1, b.fixedInv(25));
  TEST_ASSERT_FALSE(b.hasI2c());
  TEST_ASSERT_EQUAL(-1, b.sda());
  TEST_ASSERT_EQUAL(-1, b.scl());
  TEST_ASSERT_FALSE(b.oneWireOk(4));  // no onewire list = no DS18B20 anywhere
  TEST_ASSERT_FALSE(b.reservedBus(21));
}

void test_board_bare_and_failed_parse_keeps_old() {
  loadChipTables();
  BoardProfile b;
  TEST_ASSERT_TRUE(b.bare());  // a fresh profile is bare
  TEST_ASSERT_EQUAL_STRING("bare", b.id());
  TEST_ASSERT_TRUE(b.allows(2, PinUse::DigitalOut));  // bare: chip rules only (checked by the HAL)
  TEST_ASSERT_EQUAL(-1, b.fixedInv(16));
  TEST_ASSERT_TRUE(b.oneWireOk(23));
  TEST_ASSERT_FALSE(b.reservedBus(21));
  TEST_ASSERT_TRUE(b.hasI2c());  // bus pins come from Settings
  std::string err;
  TEST_ASSERT_TRUE_MESSAGE(b.parse(kMb1, err, kChip), err.c_str());
  TEST_ASSERT_FALSE(b.parse(R"({"schema":1,"id":"t-x","name":"X","terminals":[{"label":"IO1","gpio":6,"uses":["di"]}]})", err, kChip));
  TEST_ASSERT_FALSE(err.empty());
  TEST_ASSERT_EQUAL_STRING("eos-mb1", b.id());  // the rejected profile changed nothing
  TEST_ASSERT_TRUE(b.allows(16, PinUse::DigitalOut));
  TEST_ASSERT_FALSE(b.parse("{not json", err, kChip));
  TEST_ASSERT_TRUE(b.parse(R"({"id":"bare"})", err, kChip));
  TEST_ASSERT_TRUE(b.bare());
  TEST_ASSERT_EQUAL(-1, b.fixedInv(16));
  TEST_ASSERT_EQUAL(-1, b.sda());
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_gates_truth_table);
  RUN_TEST(test_order_independent_of_json_order);
  RUN_TEST(test_ton);
  RUN_TEST(test_tof_and_tp);
  RUN_TEST(test_sr_latch_reset_priority);
  RUN_TEST(test_feedback_loop_one_cycle_delay);
  RUN_TEST(test_counter);
  RUN_TEST(test_thresh_hysteresis_and_math);
  RUN_TEST(test_invalid_programs_rejected_and_old_kept);
  RUN_TEST(test_stop_sets_outputs_safe);
  RUN_TEST(test_inverted_output_pin_level_vs_state);
  RUN_TEST(test_stop_then_run_restores_outputs_and_fresh_state);
  RUN_TEST(test_inverted_output_starts_at_off_level);
  RUN_TEST(test_snapshot_json);
  RUN_TEST(test_bad_pins_rejected);
  RUN_TEST(test_mqtt_in_out);
  RUN_TEST(test_mqtt_topics_checked);
  RUN_TEST(test_board_vectors);
  RUN_TEST(test_board_preset_queries);
  RUN_TEST(test_board_active_low_and_no_bus);
  RUN_TEST(test_board_bare_and_failed_parse_keeps_old);
  return UNITY_END();
}
