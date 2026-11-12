#pragma once
#include <Arduino.h>

#include "Board.h"
#include "Engine.h"

// ESP32 implementation of the engine HAL.
class EspHal : public eos::Hal {
 public:
  static constexpr int kVirtual = 16;
  volatile float vin[kVirtual] = {};
  // Active board profile (narrows pinProblem); nullptr = chip rules only.
  const eos::BoardProfile* board = nullptr;

  void setupInput(int pin, bool pullup) override;
  void setupOutput(int pin, bool level) override;
  bool readDigital(int pin) override;
  void writeDigital(int pin, bool v) override;
  float readAnalog(int pin) override;
  float readTouch(int pin) override;
  void setupPwm(int pin, int freq) override;
  void writePwm(int pin, float duty) override;
  float readSensor(int dev, int channel, bool* ok) override;
  bool timeOfDay(int* dow, int* minuteOfDay) override;
  float readVirtual(int idx) override { return idx >= 0 && idx < kVirtual ? vin[idx] : 0; }
  void safeOutputs() override;
  const char* pinProblem(int pin, eos::PinUse use) override;
  void beginProgram() override;
  int mqttSubscribe(const char* topic) override;
  bool mqttValue(int handle, float* v) override;
  int mqttAdvertise(const char* topic, bool retain) override;
  void mqttPublish(int handle, const char* payload) override;

  static bool validPin(int pin);
  static bool outputCapable(int pin);
  static bool adcCapable(int pin);
  static bool touchCapable(int pin);
  static eos::ChipRules chipRules() { return {validPin, outputCapable, adcCapable, touchCapable}; }

 private:
  uint64_t outMask_ = 0;  // pins configured as digital outputs
  uint64_t pwmMask_ = 0;  // pins configured as PWM
};
