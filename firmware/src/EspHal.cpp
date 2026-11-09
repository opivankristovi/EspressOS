#include "EspHal.h"

#include <driver/gpio.h>
#include <time.h>

#include "Sensors.h"

// Usable pins; keep in sync with OUT_PINS / IN_PINS / ADC_PINS in web/js/catalog.js.
// Left out: 0, 1, 3 (boot strap and serial), 6-11 (SPI flash on WROOM modules).
static const int kOutPins[] = {2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33};
static const int kInOnlyPins[] = {34, 35, 36, 39};
static const int kAdcPins[] = {32, 33, 34, 35, 36, 39};  // ADC1 only: ADC2 is unusable while Wi-Fi is on

template <size_t N>
static bool inList(const int (&list)[N], int pin) {
  for (int p : list)
    if (p == pin) return true;
  return false;
}

bool EspHal::outputCapable(int pin) { return inList(kOutPins, pin); }
bool EspHal::validPin(int pin) { return outputCapable(pin) || inList(kInOnlyPins, pin); }

const char* EspHal::pinProblem(int pin, eos::PinUse use) {
  if (!validPin(pin)) return "cannot be used (0, 1 and 3 are boot/serial pins, 6-11 belong to the flash chip)";
  if ((use == eos::PinUse::DigitalOut || use == eos::PinUse::PwmOut) && !outputCapable(pin)) return "is input-only";
  if (use == eos::PinUse::AnalogIn && !inList(kAdcPins, pin)) return "has no usable ADC (use 32-36 or 39)";
  return nullptr;
}

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
