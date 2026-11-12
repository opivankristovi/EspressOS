# MB-2: sensor node, 4 precise analog in, 6 touch, 4 relay channels (rev A, design)

MB-2 is a carrier board for a plugged-in **ESP32 DOIT DevKit V1 (30-pin)**. It is the hardware that the `eos-mb2` board profile in [web/js/boards.js](../../web/js/boards.js) describes. Where MB-1 is a controller with mains outputs, MB-2 is a monitoring node: precise analog inputs, capacitive touch, sensor buses, and a header that drives an external relay module. There is no mains voltage on MB-2.

**Status:** design agreed; the `eos-mb2` profile and the firmware's touch support are in place; schematic done (generated, netlist-checked, ERC clean); PCB placed and routed (generated, DRC: no errors); Gerbers and a 3D model for the enclosure. Nothing ordered or built yet.

## Design decisions

| Topic | Choice | Why |
|---|---|---|
| Module | ESP32 DOIT DevKit V1, 30-pin, in two 1×15 female headers (rows 25.4 mm apart) | Swappable; programming and serial console over the DevKit's own USB. No ESP32 or USB-serial on MB-2. |
| Power | 12–24 V DC terminal, *and* the DevKit's USB | Either works. The board's switching regulator feeds the DevKit's VIN through a diode, so both can be connected at once. Relays run only from 12–24 V. |
| Regulator | Traco TSR 1-2450E (5 V 1 A switching, SIP-3, 7–36 V in) | Efficient (about 90 %) and hand-solderable; a linear regulator would burn about 4 W at 24 V. |
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

* J1 12–24 V in → F1 PTC 1.1 A hold → D1 SS34 Schottky (reverse polarity) → D2 SMAJ30A TVS to GND → C1 47 µF/50 V → U1 TSR 1-2450E → **+5V**, C2 22 µF.
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

## Schematic

[MB-2.kicad\_sch](MB-2.kicad_sch) is the schematic and [MB-2.pdf](MB-2.pdf) a print of it; open [MB-2.kicad\_pro](MB-2.kicad_pro) in KiCad. Like MB-1's, it is **generated**: [gen\_schematic.py](gen_schematic.py) holds every part, value, footprint and the net on each pin, so change the script and generate again rather than editing the sheet.

```bash
python gen_schematic.py
kicad-cli sch erc MB-2.kicad_sch
kicad-cli sch export netlist --format kicadsexpr -o MB-2.net MB-2.kicad_sch
python check_netlist.py MB-2.net
kicad-cli sch export pdf -o MB-2.pdf MB-2.kicad_sch
```

[check\_netlist.py](check_netlist.py) compares the netlist KiCad reads from the sheet with the nets in the script, pin by pin: 62 nets, 0 differences. ERC has no errors; on a KiCad install whose library tables were never set up, `kicad-cli` also lists "library not in the current configuration" warnings.

* **The DevKit** is two 1×15 female headers, J2 (left row) and J3 (right row), pin 1 at the antenna end. Unused DevKit pins (EN, GPIO 12, 2, 5, TX0, RX0) carry no-connect flags.
* **The ADS1115** is a 1×10 female header (J4) for the common breakout module: VDD, GND, SCL, SDA, ADDR (to GND, 0x48), ALRT (unused), A0–A3.
* **Footprints** are the hand-solder versions: 0805 passives, SMA diodes, 1812/1206 PTCs, 1210 shunts, through-hole terminals and headers.

Reference designators on the sheet:

|Function|Refs|
|-|-|
|Power|J1, F1–F3, D1–D3, C1, C2, U1|
|DevKit|J2, J3|
|Analog AI1–AI4|ADS1115 socket J4, series R1–R4 (30k), to GND R5–R8 (10k), C3–C6, clamps D4–D7, jumpers JP1–JP4, shunts R9–R12 (150 Ω), terminal J5|
|Inputs IN1–IN4|R13–R16, C7–C10, clamps D8–D11, terminal J6|
|Touch T1–T6|R17–R22, terminal J7|
|Relay header|gate R23–R26, pull-down R27–R30, MOSFETs Q1–Q4, header J8|
|GPIO, buses|R31–R33, pull-ups R34–R36, terminals J9 (IO), J10 (I2C), J12 (1-Wire), Qwiic J11|

## PCB

[MB-2.kicad\_pcb](MB-2.kicad_pcb): two layers, 120 × 80 mm, four M3 holes, all parts on top. Renders: [top](MB-2-top.png), [bottom](MB-2-bottom.png). Generated and routed by script, like MB-1:

```bash
"%LOCALAPPDATA%\Programs\KiCad\10.0\bin\python.exe" gen_pcb.py
"%LOCALAPPDATA%\Programs\KiCad\10.0\bin\python.exe" route.py
kicad-cli pcb drc MB-2.kicad_pcb
```

* **[gen\_pcb.py](gen_pcb.py)** reads the parts and nets from `gen_schematic.py`, places every footprint and writes the outline, holes, ground pours on both layers, silkscreen and net classes. `gen_pcb.py --silk` redoes only the part fields and silkscreen on a routed board.
* **[route.py](route.py)** is MB-1's: Freerouting (about a minute on this board), then loose vias and stubs removed, ground stitching vias, islands joined, and any track Freerouting necked below the 0.2 mm minimum widened back.

**Layout.**
* **Top edge:** the analog (J5), input (J6) and touch (J7) terminals, wires entering from the top, each terminal's parts in a column underneath it.
* **Analog block:** the 4–20 mA jumpers and their shunts sit left of the analog columns, with the ADS1115 socket (J4) below them.
* **Right:** the DevKit sockets with the antenna pointing right. Pin 1 sits 6 mm from the edge, so the antenna end overhangs the board, and a copper-free strip keeps the board's copper away from it.
* **Left edge:** the relay-module header (J8) with its four MOSFET drivers.
* **Bottom:** the power chain, with power (J1), GPIO (J9), I2C (J10), 1-Wire (J12) and the Qwiic socket along the bottom edge.
* **Under the DevKit:** low SMD parts and tracks; it sits about 8.5 mm up on its sockets.

**Rules** (net classes in the project):

|Net class|Nets|Clearance|Track|
|-|-|-|-|
|Default|signals|0.2 mm|0.3 mm|
|Power|GND, +5V, +3V3, +VS, VIN\_RAW, VIN\_F, VIN\_DK, 3V3\_OUT, VLOOP|0.2 mm|0.6 mm|
|Touch|TCH1–6 (GPIO side), TT1–6 (terminal side)|0.5 mm|0.35 mm|

The Touch class keeps other tracks, and the ground pour on both layers, 0.5 mm away from the touch traces. That lowers the idle capacitance the ESP32 measures, so a finger changes the reading more. The longest touch trace (T4) is 47 mm; T1 and T2 are the shortest. If one pad reads less clearly than the others, it is probably T3 or T4 and its threshold can be set a little higher in the Touch block.

**DRC:** no errors and no unconnected items. The only warnings are "footprint library not in the current configuration" (they go away once KiCad has been started once).

**Before ordering:** print the board at 1:1 and check the DevKit sockets against your DevKit (rows 25.4 mm apart) and the ADS1115 socket against your module's pinout.

## Ordering the board

```bash
"%LOCALAPPDATA%\Programs\KiCad\10.0\bin\python.exe" gerbers.py
```

[gerbers.py](gerbers.py) writes [fab/MB-2-gerbers.zip](fab/MB-2-gerbers.zip): copper, mask, paste and silkscreen on both sides, the outline, and plated and non-plated drill files in mm. Upload it at any PCB fab as a 2-layer, 1.6 mm, 120 × 80 mm board. MB-2 is hand-soldered, so there is no assembly BOM or placement file. The zip was checked against the board: 475 plated holes (383 vias, 92 pads) and 4 non-plated M3 holes, outline 120.00 × 80.00 mm.

## 3D model for an enclosure

```bash
"%LOCALAPPDATA%\Programs\KiCad\10.0\bin\python.exe" make_3d.py
```

[3d/MB-2.stl](3d/MB-2.stl) is the assembled board as one mesh (binary STL, mm) for Fusion, TinkerCAD or any CAD. The origin is the board's lower-left corner with the analog, input and touch terminals at the top; Z runs up from the bottom of the board (top surface at z = 1.6). The Traco regulator and the 1812 fuse have no KiCad model and are blocks from their data sheets. **The plugged-in DevKit and ADS1115 module are envelopes** measured from common boards, since they decide the enclosure's height: check them against your own modules.

|Item|Where (mm)|Height (z, mm)|
|-|-|-|
|Board|0–120 × 0–80, 1.6 thick, 2 mm corner radius|0–1.6|
|Mounting holes, M3 (3.2 mm)|(3.5, 3.5), (116.5, 3.5), (3.5, 76.5), (116.5, 76.5)| |
|Pins and solder below the board|x 2.7–114.3|down to −2.9: standoffs of 5 mm or more|
|ESP32 DevKit (plugged in)|x 73.9–125.4 (antenna end 5.4 mm past the right edge), y 25.2–53.5|10.1–15.0|
|DevKit USB plug|left end of the DevKit, x ≈ 74, y ≈ 39|≈ 11.5–14.5; leave room for the cable|
|ADS1115 module (plugged in)|x 21.4–49.4, y 41.5–59.3|10.1–13.5|
|Power terminal J1 (5.08 mm, tallest part)|x 8.7–20.2, y 1.0–8.6|up to 15.4|
|Bottom terminals J9, J10, J12 (wires in from the bottom edge)|x 21.7–69.3, y 1.0–8.6|up to 10.8|
|Qwiic J11 (opening to the bottom edge)|x 73–79, y 1.5–6.5|up to 4.6|
|Top terminals J5–J7 (wires in from the top edge)|x 8.2–87.2, y 71.4–79.0|up to 10.8|
|Relay-module header J8 (cable to the module)|x 1.7–4.3, y 30–45|up to 10.1|
|Traco regulator U1|x 30.3–38.7, y 13.4–25.5|up to 12.0|

Keep the enclosure non-metallic around the DevKit's antenna end (right edge).

## BOM sketch (to be finalised with the schematic)

| Part | Qty | MPN |
|---|---|---|
| ESP32 DOIT DevKit V1, 30-pin | 1 | (plugged in, not soldered) |
| Female header 1×15, 2.54 mm | 2 | |
| ADS1115 breakout module + female header 1×10 | 1 | |
| Switching regulator 5 V 1 A, SIP-3 | 1 | Traco TSR 1-2450E |
| N-MOSFET SOT-23 | 4 | 2N7002 or AO3400A |
| Schottky 40 V 3 A / 1 A, SMA | 1 / 1 | SS34 / SS14 |
| TVS 30 V, SMA | 1 | Littelfuse SMAJ30A |
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
