#include "EspHal.h"

#include <driver/gpio.h>
#include <time.h>

#include "Sensors.h"

// Pins 6-11 are wired to the SPI flash on ESP32-WROOM modules; never touch them.
bool EspHal::validPin(int pin) { return pin >= 0 && pin <= 39 && !(pin >= 6 && pin <= 11) && pin != 20 && pin != 24 && !(pin >= 28 && pin <= 31); }
// 34-39 are input only.
bool EspHal::outputCapable(int pin) { return validPin(pin) && pin < 34; }

void EspHal::setupInput(int pin, bool pullup) {
  if (!validPin(pin)) return;
  pinMode(pin, pullup && pin < 34 ? INPUT_PULLUP : INPUT);
}

void EspHal::setupOutput(int pin, bool level) {
  if (!outputCapable(pin)) return;
  // Latch the off level before the driver is enabled: an active-low relay
  // must not see LOW (= on) even for a moment.
  gpio_set_level((gpio_num_t)pin, level ? 1 : 0);
  pinMode(pin, OUTPUT);
  digitalWrite(pin, level ? HIGH : LOW);
  outMask_ |= 1ULL << pin;
}

bool EspHal::readDigital(int pin) { return validPin(pin) && digitalRead(pin) == HIGH; }

void EspHal::writeDigital(int pin, bool v) {
  if (outMask_ & (1ULL << pin)) digitalWrite(pin, v ? HIGH : LOW);
}

float EspHal::readAnalog(int pin) { return validPin(pin) ? (float)analogRead(pin) : 0; }

void EspHal::setupPwm(int pin, int freq) {
  if (!outputCapable(pin)) return;
  if (freq < 1) freq = 1000;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(pin, freq, 10);
#else
  // Core 2.x: one LEDC channel per pin, picked from the pin number.
  int ch = pin % 16;
  ledcSetup(ch, freq, 10);
  ledcAttachPin(pin, ch);
#endif
  pwmMask_ |= 1ULL << pin;
}

void EspHal::writePwm(int pin, float duty) {
  if (!(pwmMask_ & (1ULL << pin))) return;
  uint32_t v = (uint32_t)(duty / 100.f * 1023.f + 0.5f);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(pin, v);
#else
  ledcWrite(pin % 16, v);
#endif
}

float EspHal::readSensor(int dev, int channel, bool* ok) { return Sensors::value(dev, channel, ok); }

bool EspHal::timeOfDay(int* dow, int* minuteOfDay) {
  time_t now = time(nullptr);
  if (now < 1700000000) return false;  // NTP not synced yet
  struct tm t;
  localtime_r(&now, &t);
  *dow = t.tm_wday;
  *minuteOfDay = t.tm_hour * 60 + t.tm_min;
  return true;
}

// Safe state = outputs released to high impedance. This de-energises both
// active-high and (pulled-up) active-low relay boards.
void EspHal::safeOutputs() {
  for (int pin = 0; pin < 40; pin++) {
    uint64_t bit = 1ULL << pin;
    if (pwmMask_ & bit) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
      ledcDetach(pin);
#else
      ledcDetachPin(pin);
#endif
    }
    if ((outMask_ | pwmMask_) & bit) {
      digitalWrite(pin, LOW);
      pinMode(pin, INPUT);
    }
  }
  outMask_ = pwmMask_ = 0;
}
