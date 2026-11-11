#include "Engine.h"

#include <ArduinoJson.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <map>

namespace eos {

namespace {

class JsonParams : public Params {
 public:
  explicit JsonParams(JsonObjectConst o) : o_(o) {}
  float num(const char* key, float def) const override {
    JsonVariantConst v = o_[key];
    if (v.is<float>()) return v.as<float>();
    if (v.is<const char*>()) return (float)atof(v.as<const char*>());
    if (v.is<bool>()) return v.as<bool>() ? 1.f : 0.f;
    return def;
  }
  std::string str(const char* key, const char* def) const override {
    JsonVariantConst v = o_[key];
    return v.is<const char*>() ? std::string(v.as<const char*>()) : std::string(def);
  }

 private:
  JsonObjectConst o_;
};

std::string fmt(const char* f, int a, int b = 0) {
  char buf[96];
  snprintf(buf, sizeof buf, f, a, b);
  return buf;
}

bool pinUseOf(const std::string& type, PinUse* use) {
  if (type == "DI") *use = PinUse::DigitalIn;
  else if (type == "DO") *use = PinUse::DigitalOut;
  else if (type == "AI") *use = PinUse::AnalogIn;
  else if (type == "AO") *use = PinUse::PwmOut;
  else return false;
  return true;
}

// Problem with an MQTT topic, or nullptr. Wildcards only make sense for
// subscriptions that collect several topics, which a block cannot represent.
const char* topicProblem(const std::string& t) {
  if (t.empty()) return "has no MQTT topic";
  if (t.size() > (size_t)kMaxTopicLen) return "MQTT topic is too long (max 96 characters)";
  if (t.find_first_of("+#") != std::string::npos) return "MQTT topic must not contain the wildcards + or #";
  return nullptr;
}

}  // namespace

bool Engine::load(const char* json, std::string& err) {
  JsonDocument doc;
  DeserializationError de = deserializeJson(doc, json);
  if (de) { err = std::string("JSON: ") + de.c_str(); return false; }

  JsonArrayConst jb = doc["blocks"].as<JsonArrayConst>();
  JsonArrayConst jw = doc["wires"].as<JsonArrayConst>();

  std::vector<std::unique_ptr<Block>> blocks;
  std::vector<const BlockType*> types;
  std::map<int, size_t> byId;
  std::map<int, std::pair<int, bool>> pinOwner;  // pin -> (block id, drives it)
  std::vector<std::string> mqttIn, mqttOut;       // distinct topics
  size_t nSig = 0;

  for (JsonObjectConst o : jb) {
    int id = o["id"] | 0;
    std::string type = o["type"] | "";
    const BlockType* bt = findBlockType(type);
    if (!bt) { err = "Unknown block type '" + type + "'"; return false; }
    if (id <= 0 || byId.count(id)) { err = fmt("Invalid or duplicate block id %d", id); return false; }
    JsonParams p(o["p"].as<JsonObjectConst>());
    PinUse use;
    if (pinUseOf(type, &use)) {
      int pin = (int)p.num("pin", -1);
      if (pin < 0) { err = fmt("Block %d has no GPIO pin", id); return false; }
      if (const char* why = hal_.pinProblem(pin, use)) { err = fmt("Block %d: GPIO %d ", id, pin) + why; return false; }
      bool drives = use == PinUse::DigitalOut || use == PinUse::PwmOut;
      auto it = pinOwner.find(pin);
      if (it != pinOwner.end() && (drives || it->second.second)) {
        err = fmt("GPIO %d is used by block %d", pin, it->second.first) + fmt(" and block %d", id);
        return false;
      }
      pinOwner[pin] = {id, drives || (it != pinOwner.end() && it->second.second)};
    }
    if (type == "MQTTIN" || type == "MQTTOUT") {
      std::string topic = p.str("topic", "");
      if (const char* why = topicProblem(topic)) { err = fmt("Block %d ", id) + why; return false; }
      auto& list = type == "MQTTIN" ? mqttIn : mqttOut;
      bool known = false;
      for (const auto& t : list) known |= t == topic;
      if (!known) list.push_back(topic);
      if (list.size() > (size_t)kMaxMqtt) { err = fmt("More than %d MQTT topics in one direction", kMaxMqtt); return false; }
    }
    Block* b = bt->create(p);
    if (!b) { err = "Cannot create " + type; return false; }
    b->id = id;
    for (int i = 0; i < bt->nOut; i++) b->out[i] = (int16_t)nSig++;
    byId[id] = blocks.size();
    blocks.emplace_back(b);
    types.push_back(bt);
  }

  // edges[src] -> list of dst block indices
  std::vector<std::vector<size_t>> edges(blocks.size());
  std::vector<int> indeg(blocks.size(), 0);

  for (JsonArrayConst w : jw) {
    if (w.size() != 4) { err = "Wire must be [fromId,fromPort,toId,toPort]"; return false; }
    int fid = w[0], fp = w[1], tid = w[2], tp = w[3];
    if (!byId.count(fid) || !byId.count(tid)) { err = fmt("Wire references missing block %d/%d", fid, tid); return false; }
    size_t fi = byId[fid], ti = byId[tid];
    if (fp < 0 || fp >= types[fi]->nOut) { err = fmt("Block %d has no output %d", fid, fp); return false; }
    if (tp < 0 || tp >= types[ti]->nIn) { err = fmt("Block %d has no input %d", tid, tp); return false; }
    if (blocks[ti]->in[tp] >= 0) { err = fmt("Input %d of block %d has two wires", tp, tid); return false; }
    blocks[ti]->in[tp] = blocks[fi]->out[fp];
    edges[fi].push_back(ti);
    indeg[ti]++;
  }

  // Kahn topological sort; blocks left over are in feedback loops and are
  // appended in diagram order (they then see last cycle's values).
  std::vector<Block*> order;
  std::vector<bool> done(blocks.size(), false);
  bool progress = true;
  while (progress) {
    progress = false;
    for (size_t i = 0; i < blocks.size(); i++) {
      if (done[i] || indeg[i] != 0) continue;
      done[i] = true;
      progress = true;
      order.push_back(blocks[i].get());
      for (size_t d : edges[i]) indeg[d]--;
    }
  }
  for (size_t i = 0; i < blocks.size(); i++)
    if (!done[i]) order.push_back(blocks[i].get());

  // Commit
  hal_.safeOutputs();
  blocks_ = std::move(blocks);
  order_ = std::move(order);
  sig_.assign(nSig, 0.f);
  cycleMs_ = doc["cycleMs"] | 10;
  if (cycleMs_ < 1) cycleMs_ = 1;
  if (cycleMs_ > 1000) cycleMs_ = 1000;
  cycles_ = 0;
  hal_.beginProgram();
  for (Block* b : order_) b->begin(hal_);
  if (src_.c_str() != json) src_ = json;
  err.clear();
  return true;
}

void Engine::clear() {
  hal_.safeOutputs();
  src_.clear();
  blocks_.clear();
  order_.clear();
  sig_.clear();
  running_ = false;
}

void Engine::run() {
  if (running_) return;
  if (!src_.empty()) {
    std::string err, src = src_;
    load(src.c_str(), err);  // fresh block state + outputs set up again
  }
  running_ = true;
}

void Engine::stop() {
  running_ = false;
  hal_.safeOutputs();
}

void Engine::scan(uint32_t nowMs) {
  if (!running_ || order_.empty()) return;
  Ctx c{sig_.data(), nowMs, &hal_};
  for (Block* b : order_) b->eval(c);
  cycles_++;
}

float Engine::output(int blockId, int port) const {
  for (const auto& b : blocks_)
    if (b->id == blockId && port < kMaxOut && b->out[port] >= 0) return sig_[b->out[port]];
  return NAN;
}

std::string Engine::snapshot() const {
  std::string s;
  s.reserve(32 + blocks_.size() * 24);
  char buf[48];
  snprintf(buf, sizeof buf, "{\"run\":%d,\"cycle\":%lu,\"b\":{", running_ ? 1 : 0, (unsigned long)cycles_);
  s += buf;
  bool first = true;
  for (const auto& b : blocks_) {
    snprintf(buf, sizeof buf, "%s\"%d\":[", first ? "" : ",", b->id);
    s += buf;
    first = false;
    for (int i = 0; i < kMaxOut && b->out[i] >= 0; i++) {
      snprintf(buf, sizeof buf, "%g,", sig_[b->out[i]]);
      s += buf;
    }
    snprintf(buf, sizeof buf, "%g]", b->extra);
    s += buf;
  }
  s += "}}";
  return s;
}

}  // namespace eos
