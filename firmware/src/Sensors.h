#pragma once
#include <ArduinoJson.h>

// Sensor device manager. Devices are declared in the program JSON:
//   "devices":[{"id":1,"driver":"BME280","addr":118,"poll":2}]
// A background task polls each device and caches its channel values; the
// SENSOR block reads those cached values every scan cycle.
namespace Sensors {

constexpr int kMaxDevices = 12;
constexpr int kMaxChannels = 4;

void begin(int sda, int scl);
// Checks drivers/limits without touching running devices.
bool validate(JsonArrayConst devices, String& err);
// True if any device talks over the I2C bus (everything except 1-Wire).
bool usesI2c(JsonArrayConst devices);
// Replaces all devices (call validate() first). The caller must make sure the
// engine is not scanning (value() is lock-free).
void configure(JsonArrayConst devices);
float value(int devId, int channel, bool* ok);

// JSON: [{"id":1,"driver":"BME280","ok":true,"v":[21.5,40.2,1013.1]}]
String statusJson();
// JSON array of compiled-in driver ids.
String driversJson();
// JSON: {"sda":21,"scl":22,"found":[118,35]}, plus "error" if the bus is stuck
String i2cScanJson();

}  // namespace Sensors
