#pragma once
// Hardware abstraction used by the logic engine.
// The firmware provides an ESP32 implementation; tests provide a fake.
#include <stdint.h>

namespace eos {

class Hal {
 public:
  virtual ~Hal() {}
  virtual void setupInput(int pin, bool pullup) { (void)pin; (void)pullup; }
  // Configure pin as output, driving `level` from the very first instant
  // (so active-low relays never see a glitch).
  virtual void setupOutput(int pin, bool level) { (void)pin; (void)level; }
  virtual bool readDigital(int pin) { (void)pin; return false; }
  virtual void writeDigital(int pin, bool v) { (void)pin; (void)v; }
  // Returns raw ADC reading (ESP32: 0..4095).
  virtual float readAnalog(int pin) { (void)pin; return 0; }
  virtual void setupPwm(int pin, int freq) { (void)pin; (void)freq; }
  // duty in percent 0..100
  virtual void writePwm(int pin, float duty) { (void)pin; (void)duty; }
  // Cached value of a sensor device channel; ok=false when not available.
  virtual float readSensor(int dev, int channel, bool* ok) { (void)dev; (void)channel; *ok = false; return 0; }
  // Local time; returns false when clock not synced. dow: 0=Sunday..6
  virtual bool timeOfDay(int* dow, int* minuteOfDay) { (void)dow; (void)minuteOfDay; return false; }
  // Virtual inputs (switches in the web UI).
  virtual float readVirtual(int idx) { (void)idx; return 0; }
  // Put every output that was set up into its safe (off) state.
  virtual void safeOutputs() {}
};

}  // namespace eos
