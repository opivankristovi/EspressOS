# MB-2: sensor node, 4 precise analog in, 6 touch, 4 relay channels (rev A, design)

MB-2 is a carrier board for a plugged-in **ESP32 DOIT DevKit V1 (30-pin)**. It is the hardware that the `eos-mb2` board profile in [web/js/boards.js](../../web/js/boards.js) describes. Where MB-1 is a controller with mains outputs, MB-2 is a monitoring node: precise analog inputs, capacitive touch, sensor buses, and a header that drives an external relay module. There is no mains voltage on MB-2.

**Status:** design agreed; the `eos-mb2` profile and the firmware's touch support are in place. No schematic, PCB or order yet.

## Design decisions

| Topic | Choice | Why |
|---|---|---|
| Module | ESP32 DOIT DevKit V1, 30-pin, in two 1×15 female headers (rows 25.4 mm apart) | Swappable; programming and serial console over the DevKit's own USB. No ESP32 or USB-serial on MB-2. |
| Power | 12–24 V DC terminal, *and* the DevKit's USB | Either works. The board's switching regulator feeds the DevKit's VIN through a diode, so both can be connected at once. Relays run only from 12–24 V. |
| Regulator | Traco TSR 1-2450 (5 V 1 A switching, SIP-3, 6.5–36 V in) | Efficient (about 90 %) and hand-solderable; a linear regulator would burn about 4 W at 24 V. |
| Analog in | 4 × 0–10 V or 4–20 mA, on an ADS1115 16-bit ADC (breakout module in a socket) | Far more accurate than the ESP32 ADC; ADS1115 is already supported by the firmware. A jumper per input selects 4–20 mA. |
| Extra inputs | GPIO 34, 35, 36, 39 as four 0–3.3 V analog/digital inputs | These ADC pins have no touch sensor, so they become plain inputs. |
| Touch | 6 capacitive touch inputs, GPIO 13, 14, 15, 27, 32, 33 | All touch-capable pins on the 30-pin DevKit except 4 (1-Wire) and the boot straps 2 and 12. Needs a new touch block in the firmware (part of this work). |
| Relays | No relays on MB-2: a 6-pin header for a common 5 V 4-channel relay module, each input driven by a MOSFET | Keeps mains off the board. The MOSFETs pull the module's active-low inputs, so any 5 V module switches reliably and nothing clicks while the ESP32 boots. |
| Buses | I2C (GPIO 21/22) on a terminal and a Qwiic socket; 1-Wire (GPIO 4) on a terminal | As MB-1. |
| Spare GPIO | IO1–IO3 on GPIO 23, 25, 26 (in, out, PWM) | The remaining free, non-strapping pins. |
| Build | Fully hand-soldered: 0805 passives, SOT-23 and SMA/SMB diodes, through-hole terminals and headers | No assembly order needed. |
| Enclosure | Bare board, 120 × 80 mm, four M3 holes; a 3D model for designing a case | As MB-1. |

## Pin map (must match the `eos-mb2` profile)

| GPIO | DevKit pin | Terminal | Profile uses | Circuit |
|---|---|---|---|---|
| 36 (VP) | left 2 | IN1 | ai, di | 1 kΩ series, clamp to 3V3/GND, 100 nF |
| 39 (VN) | left 3 | IN2 | ai, di | same |
| 34 | left 4 | IN3 | ai, di | same |
| 35 | left 5 | IN4 | ai, di | same |
| 32 | left 6 | T5 | touch | 1 kΩ series |
| 33 | left 7 | T6 | touch | same |
| 25 | left 8 | IO2 | di, do, pwm | 100 Ω series |
| 26 | left 9 | IO3 | di, do, pwm | 100 Ω series |
| 27 | left 10 | T4 | touch | 1 kΩ series |
| 14 | left 11 | T2 | touch | same (pulses at boot: touch only) |
| 13 | left 13 | T1 | touch | same |
| 15 | right 13 | T3 | touch | same (boot strap: touch only) |
| 23 | right 1 | IO1 | di, do, pwm | 100 Ω series |
| 22 | right 2 | SCL | I2C | 4.7 kΩ to 3V3 |
| 21 | right 5 | SDA | I2C | 4.7 kΩ to 3V3 |
| 19 | right 6 | R4 | do, active high | MOSFET → relay header IN4 |
| 18 | right 7 | R3 | do, active high | MOSFET → IN3 |
| 17 (TX2) | right 9 | R2 | do, active high | MOSFET → IN2 |
| 16 (RX2) | right 10 | R1 | do, active high | MOSFET → IN1 |
| 4 | right 11 | DQ | 1-Wire | 4.7 kΩ to 3V3 |
| 2, 5, 12 | | — | not connected | boot straps / on-board LED (GPIO 2) |
| 1, 3 | | — | serial console (DevKit USB) | |
| VIN | left 15 | — | 5 V in from the regulator, through a Schottky diode | |
| 3V3 | right 15 | — | 3.3 V out of the DevKit's regulator: ADS1115, pull-ups, sensor terminals | |

The four analog inputs AI1–AI4 are not GPIOs: they are channels A0–A3 of the ADS1115 at I2C address 0x48. Programs read them with the *Sensor value* block (ADS1115, channels A0–A3, in volts at the ADC), so they are not profile terminals.

## Terminals

All terminals are low voltage. 3.5 mm pitch screw terminals along the top edge, power (5.08 mm) and the relay header on the left.

| Block | Positions |
|---|---|
| Power (2, 5.08 mm) | +12–24 V · GND |
| Analog (8) | AI1 · AI2 · AI3 · AI4 · +V · +V · GND · GND |
| Inputs (6) | IN1 · IN2 · IN3 · IN4 · 3V3 · GND |
| Touch (7) | T1 · T2 · T3 · T4 · T5 · T6 · GND |
| GPIO (5) | IO1 · IO2 · IO3 · 3V3 · GND |
| I2C (4) | 3V3 · SDA · SCL · GND, plus a Qwiic socket |
| 1-Wire (3) | 3V3 · DQ · GND |
| Relay module (1×6 pin header, 2.54 mm) | GND · IN1 · IN2 · IN3 · IN4 · VCC (5 V) |

**+V** is the 12–24 V supply through a 100 mA PTC, to power 2-wire 4–20 mA transmitters and 0–10 V sensors. The 3V3 positions share a 200 mA PTC.

## Circuits

### Power

* J1 12–24 V in → F1 PTC 1.1 A hold → D1 SS34 Schottky (reverse polarity) → D2 SMBJ30A TVS to GND → C1 47 µF/50 V → U1 TSR 1-2450 → **+5V**, C2 22 µF.
* **+5V** → relay header VCC. Budget: four relay coils about 4 × 75 mA = 300 mA.
* **+5V** → D3 SS14 Schottky → DevKit **VIN**. The diode stops the DevKit's USB from feeding the regulator's output. On USB alone the ESP32 and sensors run but the relay module has no supply.
* **3V3** comes from the DevKit's own regulator (about 500 mA spare after the ESP32). F2 PTC 200 mA feeds the 3V3 terminal positions and the Qwiic socket.
* F3 PTC 100 mA from the 12–24 V rail (after D1) to the **+V** terminals.

### Analog inputs AI1–AI4 (ADS1115)

Per channel: terminal → 30 kΩ 1 % → node → 10 kΩ 1 % to GND; node → 100 nF to GND; node → BAT54S clamp to 3V3/GND; node → ADS1115 A0–A3.

* **0–10 V** (no jumper): 10 V at the terminal = 2.5 V at the ADC, read in volts by the ADS1115 driver (default ±6.144 V range, 0.19 mV per count): about 13 000 counts over 0–10 V.
* **4–20 mA** (jumper JP1–JP4 fitted): the jumper connects a 150 Ω 0.5 W shunt from the terminal to GND. 20 mA gives 3.0 V at the terminal and 0.75 V at the ADC; 4–20 mA spans about 3 200 counts. Burden 3 V, fine for 12 V and 24 V loops.
* **Never fit the jumper with a voltage sensor**: the shunt would load it (a 10 V output into 150 Ω).
* ADS1115: a common 10-pin breakout module (VDD, GND, SCL, SDA, ADDR, ALRT, A0–A3) in a 1×10 female header, powered from 3V3, ADDR to GND (0x48).

### Extra inputs IN1–IN4

Terminal → 1 kΩ → GPIO; BAT54S clamp to 3V3/GND and 100 nF at the pin. 0–3.3 V signals; the clamp survives a short to 24 V for a moment (24 mA through the 1 kΩ) but not continuously.

### Touch T1–T6

Terminal → 1 kΩ → GPIO (ESD limiting). A wire to a metal plate, foil or a pad behind plastic works as the electrode; keep the wires short and away from the relay-module wiring. GND next to them for a shielded cable.

### Relay header R1–R4

GPIO → 100 Ω → gate of Q1–Q4 (2N7002 / AO3400A, SOT-23), 100 kΩ gate to GND; drain → header INn, source → GND. A typical 5 V module (Songle relays, PC817 inputs, active-low) switches on when INn is pulled low: GPIO high = relay on. The 100 kΩ keeps the inputs released while GPIO 16–19 float at reset.

### Buses

* I2C: 4.7 kΩ pull-ups to 3V3 (the ADS1115 module has its own 10 kΩ; together about 3.2 kΩ). Qwiic: JST SM04B-SRSS-TB, GND · 3V3 · SDA · SCL.
* 1-Wire: 4.7 kΩ to 3V3.

## Layout

* Board 120 × 80 mm, two layers, four M3 holes in the corners.
* DevKit socket in the middle-right with the module's antenna end over the board edge (or a copper-free area under it).
* Analog front ends close to the ADS1115 socket; touch wiring as short as possible and away from the relay header and the regulator.
* One solid GND pour on both layers.

## BOM sketch (to be finalised with the schematic)

| Part | Qty | MPN |
|---|---|---|
| ESP32 DOIT DevKit V1, 30-pin | 1 | (plugged in, not soldered) |
| Female header 1×15, 2.54 mm | 2 | |
| ADS1115 breakout module + female header 1×10 | 1 | |
| Switching regulator 5 V 1 A, SIP-3 | 1 | Traco TSR 1-2450 |
| N-MOSFET SOT-23 | 4 | 2N7002 or AO3400A |
| Schottky 40 V 3 A / 1 A, SMA | 1 / 1 | SS34 / SS14 |
| TVS 30 V, SMB | 1 | SMBJ30A |
| Schottky pair SOT-23 (clamps) | 8 | BAT54S |
| PTC 1.1 A / 200 mA / 100 mA | 1 / 1 / 1 | |
| Resistors 0805 | | 30 k 1 % ×4, 10 k 1 % ×4, 1 k ×10, 100 Ω ×7, 100 k ×4, 4.7 k ×3, 150 Ω 0.5 W (1210) ×4 |
| Capacitors 0805 / electrolytic | | 100 nF ×8, 22 µF, 47 µF 50 V |
| Jumpers 1×2 + shunts | 4 | |
| Screw terminals 3.5 mm | 8+6+7+5+4+3 | |
| Screw terminal 5.08 mm, 2-pos | 1 | |
| Pin header 1×6 male | 1 | |
| Qwiic socket | 1 | JST SM04B-SRSS-TB |

## Firmware and editor support

* **Touch input block** (`TOUCH`): reads a pad with the ESP32's touch sensor. Output Q is on while the raw reading is below the block's threshold (default 30) and goes off again 10 % above it; the second output is the raw reading, to find a good threshold in the live view. In the simulator, click the block to touch it.
* **`touch` terminal use** in board profiles, checked the same way by the editor ([web/js/boards.js](../../web/js/boards.js)) and the firmware (`firmware/lib/engine/src/Board.cpp`): only pins with a touch sensor (GPIO 2, 4, 12–15, 27, 32, 33), and no fixed active level.
* The `eos-mb2` profile replaces an earlier placeholder (8 DI, 2 AI, 4 relays, 2 DC outputs) that no hardware matched.
* Analog inputs AI1–AI4: add an ADS1115 sensor at address 0x48 on the Sensors page and use *Sensor value* blocks. The value is the voltage at the ADC: multiply by 4 for terminal volts, or (V × 4 / 150 × 1000) for mA with the jumper fitted.
