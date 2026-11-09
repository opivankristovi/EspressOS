// Built-in function blocks. Keep names/ports in sync with web/js/blocks.js.
#include <math.h>
#include <string.h>

#include "Engine.h"

namespace eos {
namespace {

uint32_t secToMs(float s) { return s <= 0 ? 0 : (uint32_t)(s * 1000.f + 0.5f); }

// ---------------------------------------------------------------- I/O
struct DI : Block {
  int pin; bool pull, inv;
  explicit DI(const Params& p) : pin((int)p.num("pin", -1)), pull(p.num("pull", 0) != 0), inv(p.num("inv", 0) != 0) {}
  void begin(Hal& h) override { if (pin >= 0) h.setupInput(pin, pull); }
  void eval(Ctx& c) override { bool v = pin >= 0 && c.hal->readDigital(pin); set(c, 0, (v != inv) ? 1 : 0); }
};

struct DO : Block {
  int pin; bool inv; int last = -1;
  explicit DO(const Params& p) : pin((int)p.num("pin", -1)), inv(p.num("inv", 0) != 0) {}
  // off state: logic 0 -> pin level = inv
  void begin(Hal& h) override { if (pin >= 0) h.setupOutput(pin, inv); last = inv ? 1 : 0; }
  void eval(Ctx& c) override {
    bool on = inb(c, 0);
    int v = (on != inv) ? 1 : 0;  // pin level
    if (pin >= 0 && v != last) { c.hal->writeDigital(pin, v); last = v; }
    extra = on ? 1 : 0;  // logical state (relay energised), not pin level
  }
};

struct AI : Block {
  int pin; float lo, hi;
  explicit AI(const Params& p) : pin((int)p.num("pin", -1)), lo(p.num("min", 0)), hi(p.num("max", 100)) {}
  void eval(Ctx& c) override {
    float raw = pin >= 0 ? c.hal->readAnalog(pin) : 0;
    set(c, 0, lo + raw / 4095.f * (hi - lo));
    extra = raw;
  }
};

struct AO : Block {
  int pin, freq; float last = -1;
  explicit AO(const Params& p) : pin((int)p.num("pin", -1)), freq((int)p.num("freq", 1000)) {}
  void begin(Hal& h) override { if (pin >= 0) h.setupPwm(pin, freq); last = -1; }
  void eval(Ctx& c) override {
    float d = inp(c, 0);
    if (d < 0) d = 0;
    if (d > 100) d = 100;
    if (pin >= 0 && fabsf(d - last) > 0.05f) { c.hal->writePwm(pin, d); last = d; }
    extra = d;
  }
};

struct Const : Block {
  float v;
  explicit Const(const Params& p) : v(p.num("value", 0)) {}
  void eval(Ctx& c) override { set(c, 0, v); }
};

struct VIn : Block {
  int idx;
  explicit VIn(const Params& p) : idx((int)p.num("idx", 0)) {}
  void eval(Ctx& c) override { set(c, 0, c.hal->readVirtual(idx)); }
};

struct Sensor : Block {
  int dev, ch;
  explicit Sensor(const Params& p) : dev((int)p.num("dev", 0)), ch((int)p.num("ch", 0)) {}
  void eval(Ctx& c) override {
    bool ok = false;
    float v = c.hal->readSensor(dev, ch, &ok);
    if (ok) set(c, 0, v);  // hold last good value
    set(c, 1, ok ? 1 : 0);
  }
};

// ---------------------------------------------------------------- logic
enum class Op { And, Or, Xor, Nand, Nor };
template <Op op>
struct Gate : Block {
  explicit Gate(const Params&) {}
  void eval(Ctx& c) override {
    int n = 0, ones = 0;
    for (int i = 0; i < kMaxIn; i++)
      if (in[i] >= 0) { n++; ones += inb(c, i) ? 1 : 0; }
    bool r = false;
    switch (op) {
      case Op::And: r = n > 0 && ones == n; break;
      case Op::Or: r = ones > 0; break;
      case Op::Xor: r = (ones & 1) != 0; break;
      case Op::Nand: r = !(n > 0 && ones == n); break;
      case Op::Nor: r = ones == 0; break;
    }
    set(c, 0, r ? 1 : 0);
  }
};

struct Not : Block {
  explicit Not(const Params&) {}
  void eval(Ctx& c) override { set(c, 0, inb(c, 0) ? 0 : 1); }
};

// S, R -> Q. Reset has priority unless prio == "S".
struct SR : Block {
  bool setPrio; bool q = false;
  explicit SR(const Params& p) : setPrio(p.str("prio", "R") == "S") {}
  void eval(Ctx& c) override {
    bool s = inb(c, 0), r = inb(c, 1);
    if (s && r) q = setPrio;
    else if (s) q = true;
    else if (r) q = false;
    set(c, 0, q ? 1 : 0);
  }
};

// Outputs a one-cycle pulse on rising (out0) and falling (out1) edge.
struct Edge : Block {
  bool prev = false;
  explicit Edge(const Params&) {}
  void eval(Ctx& c) override {
    bool v = inb(c, 0);
    set(c, 0, (v && !prev) ? 1 : 0);
    set(c, 1, (!v && prev) ? 1 : 0);
    prev = v;
  }
};

// ---------------------------------------------------------------- timers
// On-delay: Q goes high t seconds after IN went high.
struct TON : Block {
  uint32_t t; bool active = false; uint32_t start = 0;
  explicit TON(const Params& p) : t(secToMs(p.num("t", 1))) {}
  void eval(Ctx& c) override {
    bool v = inb(c, 0);
    if (!v) { active = false; extra = 0; set(c, 0, 0); return; }
    if (!active) { active = true; start = c.now; }
    uint32_t el = c.now - start;
    extra = el / 1000.f;
    set(c, 0, el >= t ? 1 : 0);
  }
};

// Off-delay: Q follows IN high immediately, stays high t seconds after IN fell.
struct TOF : Block {
  uint32_t t; bool q = false; bool timing = false; uint32_t start = 0;
  explicit TOF(const Params& p) : t(secToMs(p.num("t", 1))) {}
  void eval(Ctx& c) override {
    bool v = inb(c, 0);
    if (v) { q = true; timing = false; extra = 0; }
    else if (q) {
      if (!timing) { timing = true; start = c.now; }
      uint32_t el = c.now - start;
      extra = el / 1000.f;
      if (el >= t) { q = false; timing = false; extra = 0; }
    }
    set(c, 0, q ? 1 : 0);
  }
};

// Pulse: rising edge on IN gives a Q pulse of exactly t seconds.
struct TP : Block {
  uint32_t t; bool prev = false, q = false; uint32_t start = 0;
  explicit TP(const Params& p) : t(secToMs(p.num("t", 1))) {}
  void eval(Ctx& c) override {
    bool v = inb(c, 0);
    if (v && !prev && !q) { q = true; start = c.now; }
    prev = v;
    if (q) {
      uint32_t el = c.now - start;
      extra = el / 1000.f;
      if (el >= t) { q = false; extra = 0; }
    }
    set(c, 0, q ? 1 : 0);
  }
};

// Blinker: while EN (default on), Q alternates tOn / tOff seconds.
struct Blink : Block {
  uint32_t tOn, tOff; bool q = false, active = false; uint32_t start = 0;
  explicit Blink(const Params& p) : tOn(secToMs(p.num("on", 0.5f))), tOff(secToMs(p.num("off", 0.5f))) {}
  void eval(Ctx& c) override {
    if (!inb(c, 0, true)) { active = false; q = false; set(c, 0, 0); return; }
    if (!active) { active = true; q = true; start = c.now; }
    uint32_t el = c.now - start;
    if (el >= (q ? tOn : tOff)) { q = !q; start = c.now; }
    set(c, 0, q ? 1 : 0);
  }
};

// Weekly timer: days bitmask (bit0 = Sunday), on/off as minutes of day.
struct Week : Block {
  int days, on, off;
  explicit Week(const Params& p) : days((int)p.num("days", 127)), on((int)p.num("on", 480)), off((int)p.num("off", 1020)) {}
  void eval(Ctx& c) override {
    int dow, m;
    if (!c.hal->timeOfDay(&dow, &m)) { set(c, 0, 0); return; }
    bool q;
    if (on <= off) q = (days >> dow & 1) && m >= on && m < off;
    else {  // crosses midnight: on-day is the day the window started
      int prev = (dow + 6) % 7;
      q = ((days >> dow & 1) && m >= on) || ((days >> prev & 1) && m < off);
    }
    set(c, 0, q ? 1 : 0);
  }
};

// ---------------------------------------------------------------- counter
// UP, DOWN, RESET (rising edges count) -> Q (count >= preset), COUNT
struct Counter : Block {
  float preset; long n = 0; bool pu = false, pd = false;
  explicit Counter(const Params& p) : preset(p.num("preset", 10)) {}
  void eval(Ctx& c) override {
    bool u = inb(c, 0), d = inb(c, 1);
    if (inb(c, 2)) n = 0;
    else {
      if (u && !pu) n++;
      if (d && !pd) n--;
    }
    pu = u; pd = d;
    set(c, 0, n >= preset ? 1 : 0);
    set(c, 1, (float)n);
  }
};

// ---------------------------------------------------------------- analog
struct Cmp : Block {
  int op; float b;
  explicit Cmp(const Params& p) : b(p.num("b", 0)) {
    std::string s = p.str("op", ">");
    const char* ops[] = {">", ">=", "<", "<=", "==", "!="};
    op = 0;
    for (int i = 0; i < 6; i++) if (s == ops[i]) op = i;
  }
  void eval(Ctx& c) override {
    float x = inp(c, 0), y = inp(c, 1, b);
    bool r = false;
    switch (op) {
      case 0: r = x > y; break;
      case 1: r = x >= y; break;
      case 2: r = x < y; break;
      case 3: r = x <= y; break;
      case 4: r = fabsf(x - y) < 1e-6f; break;
      case 5: r = fabsf(x - y) >= 1e-6f; break;
    }
    set(c, 0, r ? 1 : 0);
  }
};

// Threshold with hysteresis. on > off: Q on when x >= on, off when x <= off.
// on < off: inverted (e.g. heating: on below 'on', off above 'off').
struct Thresh : Block {
  float on, off; bool q = false;
  explicit Thresh(const Params& p) : on(p.num("on", 25)), off(p.num("off", 23)) {}
  void eval(Ctx& c) override {
    float x = inp(c, 0);
    if (on >= off) { if (x >= on) q = true; else if (x <= off) q = false; }
    else { if (x <= on) q = true; else if (x >= off) q = false; }
    set(c, 0, q ? 1 : 0);
  }
};

struct Math : Block {
  char op; float b;
  explicit Math(const Params& p) : b(p.num("b", 0)) {
    std::string s = p.str("op", "+");
    op = s.empty() ? '+' : s[0];
    if (s == "min") op = 'm';
    if (s == "max") op = 'M';
  }
  void eval(Ctx& c) override {
    float x = inp(c, 0), y = inp(c, 1, b), r = 0;
    switch (op) {
      case '+': r = x + y; break;
      case '-': r = x - y; break;
      case '*': r = x * y; break;
      case '/': r = y == 0 ? 0 : x / y; break;
      case 'm': r = fminf(x, y); break;
      case 'M': r = fmaxf(x, y); break;
    }
    set(c, 0, r);
  }
};

struct Scale : Block {
  float i0, i1, o0, o1; bool clamp;
  explicit Scale(const Params& p)
      : i0(p.num("inMin", 0)), i1(p.num("inMax", 4095)), o0(p.num("outMin", 0)), o1(p.num("outMax", 100)),
        clamp(p.num("clamp", 1) != 0) {}
  void eval(Ctx& c) override {
    float x = inp(c, 0);
    float r = i1 == i0 ? o0 : o0 + (x - i0) * (o1 - o0) / (i1 - i0);
    if (clamp) {
      float lo = fminf(o0, o1), hi = fmaxf(o0, o1);
      r = fminf(fmaxf(r, lo), hi);
    }
    set(c, 0, r);
  }
};

// Selector: S ? B : A
struct Sel : Block {
  explicit Sel(const Params&) {}
  void eval(Ctx& c) override { set(c, 0, inb(c, 2) ? inp(c, 1) : inp(c, 0)); }
};

template <class T>
Block* make(const Params& p) { return new T(p); }

const std::vector<BlockType> kTypes = {
    {"DI", 0, 1, make<DI>},          {"DO", 1, 0, make<DO>},          {"AI", 0, 1, make<AI>},
    {"AO", 1, 0, make<AO>},          {"CONST", 0, 1, make<Const>},    {"VIN", 0, 1, make<VIn>},
    {"SENSOR", 0, 2, make<Sensor>},  {"AND", 4, 1, make<Gate<Op::And>>}, {"OR", 4, 1, make<Gate<Op::Or>>},
    {"XOR", 4, 1, make<Gate<Op::Xor>>}, {"NAND", 4, 1, make<Gate<Op::Nand>>}, {"NOR", 4, 1, make<Gate<Op::Nor>>},
    {"NOT", 1, 1, make<Not>},        {"SR", 2, 1, make<SR>},          {"EDGE", 1, 2, make<Edge>},
    {"TON", 1, 1, make<TON>},        {"TOF", 1, 1, make<TOF>},        {"TP", 1, 1, make<TP>},
    {"BLINK", 1, 1, make<Blink>},    {"WEEK", 0, 1, make<Week>},      {"CTR", 3, 2, make<Counter>},
    {"CMP", 2, 1, make<Cmp>},        {"THRESH", 1, 1, make<Thresh>},  {"MATH", 2, 1, make<Math>},
    {"SCALE", 1, 1, make<Scale>},    {"SEL", 3, 1, make<Sel>},
};

}  // namespace

const std::vector<BlockType>& blockTypes() { return kTypes; }

const BlockType* findBlockType(const std::string& name) {
  for (const auto& t : kTypes)
    if (name == t.name) return &t;
  return nullptr;
}

}  // namespace eos
