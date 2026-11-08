# EspressOS

A LOGO!-style logic controller for the ESP32. Flash it once over USB. After that you build programs in a web page the board serves itself: drag function blocks onto a sheet, wire them together, press **Deploy**, and watch signals light up live. You don't need the Arduino IDE or anything else installed on your computer.

## Features

- **Block editor in the browser.** Drag blocks from the palette, wire an output (right side) to an input (left side), then edit the block's settings in the side panel. Supports undo/redo, duplicate, zoom and pan. Drafts are saved in the browser.
- **Blocks:** digital in/out, analog in, PWM out, constant, web switch / push button / setpoint, AND, OR, NOT, NAND, NOR, XOR, SR latch, edge detect, on-delay, off-delay, pulse, blinker, weekly timer (NTP), up/down counter, compare, threshold with hysteresis, math, scale, select.
- **Sensors:** BME280, SHT3x, BH1750, ADS1115, DS18B20, plus a *generic I²C register* reader (address, register, byte count, endianness, scale and offset) for chips without a driver. An I²C bus scan suggests which driver fits each address it finds.
- **Live view:** digital wires turn green when high, analog values appear next to ports, and timers show elapsed time. The **Live** panel has your web switches and setpoints, output lamps and sensor readings.
- **Simulator:** with no board connected (or with `?sim` in the URL), the same engine runs in your browser. Click digital-input blocks to toggle them.
- **Board features:** setup access point with a captive portal on first boot, mDNS (`espressos.local`), optional admin password, run/stop, and firmware or web-UI updates from the browser (OTA). Outputs are released to a safe state on stop or redeploy.

## How it works

```
Browser ──HTTP/WebSocket──► ESP32
  editor + simulator           ├─ web server: UI from LittleFS (gzipped, ~30 KB)
  (web/)                       ├─ REST API  /api/program, /api/run, /api/stop, /api/vin, /api/i2c/scan, /api/config, /api/ota
                               ├─ WebSocket /ws  live values, 4×/s
                               ├─ engine task (core 1): scan cycle every 10 ms
                               └─ sensor task (core 0): polls sensors, caches values
```

A program is plain JSON: blocks, wires `[fromId, fromPort, toId, toPort]` and sensor devices. On deploy the board validates the program and sorts the blocks so each one runs after its inputs. If a program is rejected, the old one keeps running. Feedback loops are allowed and read the previous cycle's value, as on a PLC.

**Adding a sensor library:** the ESP32 can't compile code itself, so sensor drivers are built into the firmware. For a chip that isn't in the list, use the generic I²C block. To add a native driver, add a class in `firmware/src/Sensors.cpp`, add its entry to `DRIVERS` in `web/js/catalog.js`, rebuild, and upload `firmware.bin` from **Settings → Firmware update**. You never need the IDE on the board side.

## First flash

Requires [PlatformIO](https://platformio.org/) (`pip install platformio`) and an ESP32 dev board (ESP32-WROOM, 4 MB).

```bash
python tools/build_web.py
```

```bash
cd firmware && pio run -t upload && pio run -t uploadfs
```

1. The board starts an access point called `EspressOS-XXXX`. Join it and the setup page opens (or browse to `192.168.4.1`).
2. Under **Settings**, enter your Wi-Fi details, save, and reboot.
3. Open `http://espressos.local` (or the IP shown on the serial monitor at 115200 baud).

Default pins: I²C SDA 21 / SCL 22 (changeable in Settings). GPIO 6–11 are never offered because they're wired to flash. GPIO 34–39 are input-only. Analog inputs are limited to ADC1 pins, since ADC2 doesn't work while Wi-Fi is on.

## Development

| What | Command |
|---|---|
| UI against a fake board (no hardware) | `npm run mock`, then open http://localhost:8080 |
| UI in pure simulator mode | open http://localhost:8080/?sim |
| JS engine tests | `npm test` |
| C++ engine tests | `cd firmware && pio test -e native` (needs a host g++) |
| Bundle UI for the board | `npm run build:web` |

The engine exists twice: `firmware/lib/engine` (C++) and `web/js/sim.js` (JS, for the simulator). Both have the same test cases. `tools/test_sim.js` also checks that the block tables in `Blocks.cpp`, `sim.js` and `catalog.js` agree.

## Status

Tested: C++ engine (12 unit tests), JS engine (14 tests), the full editor flow in a browser against the mock board and simulator, and the firmware build (1.54 MB of the 1.9 MB app slot). **Not yet run on a real ESP32**, so the Wi-Fi/AP portal, OTA, and sensor drivers have only been compiled, not tested on hardware.

Ideas for later: Modbus RTU and UART blocks, an MQTT/HTTP output block, a CI build that publishes ready-to-upload `.bin` files, and retentive (power-fail-safe) counters.

## License

MIT, see [LICENSE](LICENSE).
