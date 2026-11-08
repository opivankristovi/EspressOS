// Native engine tests: pio test -e native
#include <unity.h>

#include <string.h>

#include <map>
#include <string>

#include "Engine.h"

using namespace eos;

struct FakeHal : Hal {
  std::map<int, bool> din, dout;
  std::map<int, float> vin;
  int safeCalls = 0;
  bool readDigital(int pin) override { return din[pin]; }
  void writeDigital(int pin, bool v) override { dout[pin] = v; }
  float readVirtual(int i) override { return vin[i]; }
  void safeOutputs() override { safeCalls++; dout.clear(); }
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

void test_snapshot_json() {
  load(R"({"blocks":[{"id":5,"type":"CONST","p":{"value":2.5}}],"wires":[]})");
  eng->scan(0);
  TEST_ASSERT_EQUAL_STRING("{\"run\":1,\"cycle\":1,\"b\":{\"5\":[2.5,0]}}", eng->snapshot().c_str());
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
  RUN_TEST(test_snapshot_json);
  return UNITY_END();
}
