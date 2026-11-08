#pragma once
// EspressOS logic engine: loads a block diagram (JSON) and executes it as a
// PLC-style scan cycle. Platform independent (no Arduino headers).
#include <stdint.h>
#include <string>
#include <vector>
#include <memory>

#include "Hal.h"

namespace eos {

constexpr int kMaxIn = 4;
constexpr int kMaxOut = 2;

class Engine;

struct Ctx {
  float* sig;        // signal table (all block outputs)
  uint32_t now;      // ms since boot
  Hal* hal;
};

class Block {
 public:
  virtual ~Block() {}
  int id = 0;
  int16_t in[kMaxIn] = {-1, -1, -1, -1};   // signal index or -1 (unconnected)
  int16_t out[kMaxOut] = {-1, -1};          // signal index
  float extra = 0;                          // monitor detail (e.g. timer elapsed s)

  // Value of input i, or def when unconnected.
  float inp(const Ctx& c, int i, float def = 0) const { return in[i] < 0 ? def : c.sig[in[i]]; }
  bool inb(const Ctx& c, int i, bool def = false) const { return in[i] < 0 ? def : c.sig[in[i]] >= 0.5f; }
  void set(Ctx& c, int o, float v) { if (out[o] >= 0) c.sig[out[o]] = v; }

  virtual void begin(Hal& hal) { (void)hal; }   // called once after load
  virtual void eval(Ctx& c) = 0;                // called every scan cycle
};

// Parameter accessor handed to block factories (decoupled from JSON lib).
class Params {
 public:
  virtual ~Params() {}
  virtual float num(const char* key, float def) const = 0;
  virtual std::string str(const char* key, const char* def) const = 0;
};

struct BlockType {
  const char* name;
  uint8_t nIn;
  uint8_t nOut;
  Block* (*create)(const Params& p);
};

// Registry of all built-in block types (Blocks.cpp).
const BlockType* findBlockType(const std::string& name);
const std::vector<BlockType>& blockTypes();

class Engine {
 public:
  explicit Engine(Hal& hal) : hal_(hal) {}

  // Parse + validate + build. On failure the old program keeps running and
  // err describes the problem.
  bool load(const char* json, std::string& err);
  void clear();

  void run() { running_ = true; }
  void stop();
  bool running() const { return running_; }

  // One scan cycle. Feedback loops read the previous cycle's value.
  void scan(uint32_t nowMs);

  // Monitor snapshot as JSON: {"run":1,"cycle":n,"b":{"id":[outs..,extra]}}
  std::string snapshot() const;

  uint32_t cycleMs() const { return cycleMs_; }
  uint32_t cycles() const { return cycles_; }
  size_t blockCount() const { return order_.size(); }
  // Test helpers
  float output(int blockId, int port) const;

 private:
  Hal& hal_;
  std::vector<std::unique_ptr<Block>> blocks_;
  std::vector<Block*> order_;  // evaluation order
  std::vector<float> sig_;
  bool running_ = false;
  uint32_t cycleMs_ = 10;
  uint32_t cycles_ = 0;
};

}  // namespace eos
