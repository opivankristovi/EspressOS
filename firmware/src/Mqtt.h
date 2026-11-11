#pragma once
// MQTT client: topics for the MQTT in/out blocks, web controls as MQTT topics,
// and Home Assistant discovery for those web controls.
//
// The client runs in its own task. The engine only touches small in-memory
// slots (under a mutex), so a slow or missing broker never delays a scan.
#include <Arduino.h>

#include <vector>

class EspHal;

namespace Mqtt {

struct Settings {
  String host;              // empty = MQTT off
  int port = 1883;
  String user, pass;
  String base;              // topic prefix for web controls; empty = "espressos/<hostname>"
  bool ha = true;           // Home Assistant discovery
  String haPrefix = "homeassistant";
};

// A web control (VIN block) published as an MQTT topic and HA entity.
struct Entity {
  int idx;
  char kind;  // 's' switch, 'b' push button, 'n' number (setpoint)
  String name;
  float min = 0, max = 100, step = 1;
};

// hostname: device name in Home Assistant and default base topic.
void begin(EspHal* hal, const String& hostname, const Settings& s);
void configure(const Settings& s);              // takes effect right away (reconnects)
void setEntities(const std::vector<Entity>& e);
void setCycleMs(uint32_t ms);                   // push buttons pressed from HA stay on for 2 cycles (min 300 ms)
String statusText();                            // "off", "connecting", "connected", or an error
bool connected();

// Engine side (through EspHal).
void resetTopics();
int subscribe(const char* topic);
bool value(int h, float* v);
int advertise(const char* topic, bool retain);
void publish(int h, const char* payload);

// Payload text -> number, like parsePayload() in web/js/sim.js. False if not understood.
bool parsePayload(const char* text, float* v);

}  // namespace Mqtt
