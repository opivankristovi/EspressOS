#pragma once
#include <Arduino.h>

#include "Engine.h"

// ESP32 implementation of the engine HAL.
class EspHal : public eos::Hal {
 public:
  static constexpr int kVirtual = 16;
  volatile float vin[kVirtual] = {};

  void setupInput(int pin, bool pullup) override;
  void setupOutput(int pin) override;
  bool readDigital(int pin) override;
  void writeDigital(int pin, bool v) override;
  float readAnalog(int pin) override;
  void setupPwm(int pin, int freq) override;
  void writePwm(int pin, float duty) override;
  float readSensor(int dev, int channel, bool* ok) override;
  bool timeOfDay(int* dow, int* minuteOfDay) override;
  float readVirtual(int idx) override { return idx >= 0 && idx < kVirtual ? vin[idx] : 0; }
  void safeOutputs() override;

  static bool validPin(int pin);
  static bool outputCapable(int pin);

 private:
  uint64_t outMask_ = 0;  // pins configured as digital outputs
  uint64_t pwmMask_ = 0;  // pins configured as PWM
};
