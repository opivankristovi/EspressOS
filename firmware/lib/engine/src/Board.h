#pragma once
// Board profiles: data that names and narrows the ESP32's pins for one carrier
// board. A profile never remaps or inverts anything; programs keep raw GPIO
// numbers and their own `inv`. Platform independent (no Arduino headers).
#include <stddef.h>
#include <stdint.h>
#include <string>

#include "Hal.h"

namespace eos {

// What the chip itself allows. Passed in so this module stays free of EspHal
// (the pin tables live in firmware/src/EspHal.cpp, single-sourced).
struct ChipRules {
  bool (*validPin)(int pin);       // usable at all (input or output)
  bool (*outputCapable)(int pin);  // can drive a level
  bool (*adcCapable)(int pin);     // ADC1 (ADC2 is unusable while Wi-Fi is on)
  bool (*touchCapable)(int pin);   // has a capacitive touch sensor
};

class BoardProfile {
 public:
  static constexpr int kPins = 40;
  static constexpr size_t kMaxJson = 4096;  // serialized size limit
  static constexpr int kMaxTerminals = 40;
  // Bits of uses()
  static constexpr uint8_t kDI = 1, kDO = 2, kAI = 4, kPWM = 8, kTouch = 16;

  BoardProfile() { setBare(); }

  // Validates a schema-1 profile (or {"id":"bare"}) and takes it over. On
  // failure nothing changes and err says why; the whole profile is rejected,
  // never silently narrowed.
  bool parse(const char* json, std::string& err, const ChipRules& chip);
  void setBare();

  bool bare() const { return bare_; }
  const char* id() const { return id_; }
  const char* name() const { return name_; }

  // Pin may be used by a block this way. Bare: always true (chip rules are
  // checked separately by the HAL).
  bool allows(int pin, PinUse use) const;
  // Use bits (kDI..kTouch) of the terminal on `pin`; 0 = not wired.
  uint8_t uses(int pin) const { return pin >= 0 && pin < kPins ? use_[pin] : 0; }
  // Required `inv` of DI/DO blocks on this pin: -1 none, 0 active-high, 1 active-low.
  int fixedInv(int pin) const { return pin >= 0 && pin < kPins ? inv_[pin] : -1; }
  // Bare: true (the bus pins come from Settings). Profile: has an i2c object.
  bool hasI2c() const { return bare_ || sda_ >= 0; }
  int sda() const { return sda_; }  // -1 when bare or no bus
  int scl() const { return scl_; }
  // DS18B20 data pin allowed. Bare: true (chip rule checked by the caller).
  bool oneWireOk(int pin) const;
  // Pin belongs to the profile's I2C bus or 1-Wire list (bare: never).
  bool reservedBus(int pin) const;

 private:
  bool bare_ = true;
  char id_[25] = "bare";
  char name_[41] = "";
  uint8_t use_[kPins];
  int8_t inv_[kPins];
  uint64_t oneWire_ = 0;
  int8_t sda_ = -1, scl_ = -1;
};

}  // namespace eos
