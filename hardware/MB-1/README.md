# MB-1: 6 analog in, 2 relays, 2 SSRs (rev A, design)

MB-1 is a 120 × 100 mm carrier board for an ESP32-WROOM-32E module. It is the hardware that the `eos-mb1` board profile in [web/js/boards.js](../../web/js/boards.js) describes. This document is the design: decisions, block diagram, pin map, terminal layout, circuits with values, the KiCad schematic and PCB, a BOM and layout rules.

**Status:** schematic done (generated, netlist-checked). PCB placed and routed (generated; DRC: no errors). Nothing has been ordered or built.

## Design decisions

| Topic | Choice | Why |
|---|---|---|
| Power | 5 V from USB-C only | One connector for power and programming; no supply on the board for 12/24 V. |
| Module | ESP32-WROOM-32E-N4 (PCB antenna) | GPIO 16 and 17 are relay outputs, so a WROVER module is ruled out: on WROVER those pins drive the PSRAM. Use the -32UE (external antenna) if the case sits in a metal cabinet. |
| Outputs | R1, R2: mechanical relays with NO and NC contacts. R3, R4: Omron G3MB-202P solid-state relays | Relays switch AC or DC and have a changeover contact. The SSRs switch AC silently and often (heaters, pumps). |
| Analog in | 6 × 0–10 V | The industrial standard; the same terminals also work as 12–24 V digital inputs. |
| Build | JLCPCB SMD assembly; through-hole parts (terminals, relays, SSRs, fuse holders) soldered by hand | |
| Enclosure | None: a bare board, 120 × 100 mm, five M3 holes | A 6-module DIN case (Camdenboss CNMB/6) has room for only 12 terminal poles per row at 3.5 mm and 9 at 5.08 mm; MB-1 needs 23 and 8. Mount it on standoffs inside a closed cabinet. |

> **Mains warning.** The relay contacts and the SSRs carry mains voltage on this PCB. Wiring and layout have to follow the creepage rules below. The board belongs in a closed enclosure, behind an upstream circuit breaker. Mains work must be done by someone qualified to do it.

## Block diagram

```mermaid
flowchart LR
  USB[USB-C<br/>5 V, data] --> PROT[PTC 1.5 A<br/>TVS 5 V<br/>ESD D+/D-]
  PROT -->|5V| LDO[AP7361C 3.3 V 1 A]
  PROT -->|5V| DRV
  PROT -->|D+/D-| UART[CH340C USB-serial<br/>auto-reset EN/IO0]
  LDO -->|3V3| ESP[ESP32-WROOM-32E]
  UART -->|TX/RX, EN, IO0| ESP
  AIN[AI1-AI6<br/>0-10 V] --> DIV[30k/10k divider<br/>clamp + 100 nF] --> ESP
  ESP -->|GPIO 16-19| DRV[4 × AO3400A low-side<br/>100k gate pull-down]
  DRV --> K12[K1, K2 relay SPDT<br/>COM / NO / NC]
  DRV --> K34[K3, K4 G3MB-202P SSR<br/>+ 2 A fuse]
  ESP <-->|GPIO 23,25,26,27,13,14| IO[IO1-IO6 3.3 V<br/>100 Ω + ESD]
  ESP <-->|GPIO 21/22| I2C[I2C terminals + Qwiic<br/>4.7k pull-ups]
  ESP <-->|GPIO 4| OW[1-Wire terminal<br/>4.7k pull-up]
```

## Pin map (must match the `eos-mb1` profile)

| GPIO | Terminal | Profile uses | Circuit | Notes |
|---|---|---|---|---|
| 36 (SENSOR_VP) | AI1 | ai, di | 0–10 V divider | input only, no internal pull |
| 39 (SENSOR_VN) | AI2 | ai, di | 0–10 V divider | input only |
| 34 | AI3 | ai, di | 0–10 V divider | input only |
| 35 | AI4 | ai, di | 0–10 V divider | input only |
| 32 | AI5 | ai, di | 0–10 V divider | internal pull-up must stay off (`pull: false`) |
| 33 | AI6 | ai, di | 0–10 V divider | same |
| 16 | R1 | do, active high | AO3400A → K1 relay coil | high-Z at reset, so a 100k pull-down keeps it off |
| 17 | R2 | do, active high | AO3400A → K2 relay coil | same |
| 18 | R3 | do, active high | AO3400A → K3 SSR input | same |
| 19 | R4 | do, active high | AO3400A → K4 SSR input | same |
| 23 | IO1 | di, do, pwm | 100 Ω + ESD | 3.3 V logic |
| 25 | IO2 | di, do, pwm | 100 Ω + ESD | |
| 26 | IO3 | di, do, pwm | 100 Ω + ESD | |
| 27 | IO4 | di, do, pwm | 100 Ω + ESD | |
| 13 | IO5 | di, do, pwm | 100 Ω + ESD | |
| 14 | IO6 | di | 100 Ω + ESD | input only in the profile: GPIO 14 outputs PWM during boot |
| 21 | SDA | I2C bus | 4.7k to 3V3, ESD | terminal and Qwiic connector |
| 22 | SCL | I2C bus | 4.7k to 3V3, ESD | |
| 4 | DQ | 1-Wire | 4.7k to 3V3, ESD | DS18B20 |
| 0 | — | BOOT button, auto-reset | 10k pull-up | strapping pin, not a terminal |
| EN | — | RESET button, auto-reset | 10k + 1 µF | |
| 1 / 3 | — | U0TXD / U0RXD → CH340C | | serial console and flashing |
| 2, 5, 12, 15 | — | not connected | | strapping pins; leave them open |
| 6–11 | — | module flash | | never route |

## Terminals

Mains is on the lower edge (5.08 mm pitch, rated 250 V). Safety extra-low voltage (SELV) is on the upper edge (3.5 mm pitch). USB-C and the RESET and BOOT buttons are on the left edge.

**Upper edge (SELV), left to right**

| Block | Positions |
|---|---|
| I2C (4) | 3V3 · SDA · SCL · GND |
| 1-Wire (3) | 3V3 · DQ · GND |
| Analog (8) | AI1 · AI2 · AI3 · AI4 · AI5 · AI6 · GND · GND |
| GPIO (8) | IO1 · IO2 · IO3 · IO4 · IO5 · IO6 · 3V3 · GND |
| Qwiic | Qwiic/STEMMA QT socket, at the right end |

**Lower edge (mains), left to right**

| Block | Positions | Rating on this board |
|---|---|---|
| R1 (3) | COM · NO · NC | 250 V AC / 30 V DC, 5 A (derated from the relay's 10 A for PCB and terminals) |
| R2 (3) | COM · NO · NC | same |
| R3, R4 (3) | SSR L in · R3 Load · R4 Load | 100–240 V AC, 0.1–2 A each, AC only; a 2 A fuse per SSR on board |

The two SSRs share one L input (J4 pin 1); each has its own fuse after that terminal. Wire both loads from the same phase.

The 3V3 terminal positions share a 200 mA PTC, so a shorted sensor cable cannot reset the ESP32.

## Circuits

### Power: USB-C 5 V
- J1: USB-C receptacle (USB 2.0, 16-pin). CC1 and CC2 each go to GND through their own 5.1 kΩ (R1, R2). Without those the C-to-C charger gives no power.
- F1: PTC, 1.5 A hold, on VBUS. D1: SMAJ5.0A TVS from VBUS to GND. C1 100 µF/16 V and C2 10 µF on the 5V rail.
- U2: AP7361C-33E (1 A, about 0.36 V dropout) from 5V to 3V3. Input C3 10 µF, output C4 22 µF + C5 100 nF. Do not use AMS1117: its 1.1 V dropout leaves no margin when USB VBUS sags.
- D2 + R3 1 kΩ: green power LED on 3V3.
- **Budget:** ESP32 Wi-Fi peaks at about 500 mA; each relay coil draws about 72 mA; each SSR input about 10–20 mA; LEDs about 10 mA. The total peak is about 0.75 A. Use a USB-C charger or a USB 3 port rated for at least 1 A. A USB 2 port (500 mA) may brown out when Wi-Fi transmits with both relays on.

### USB-serial and auto-reset
- U3: CH340C (internal oscillator), powered from **3V3**: VCC and V3 tied to 3V3, C6 100 nF. At 3.3 V its TXD cannot over-drive the ESP32's RX pin, which is not 5 V tolerant.
- U4: USBLC6-2SC6 on D+/D− at the connector.
- U3 TXD → ESP32 RXD0 (GPIO 3); U3 RXD → ESP32 TXD0 (GPIO 1).
- Auto-reset is the classic two-transistor circuit (Q1, Q2 MMBT3904, R4/R5 10 kΩ bases):
  - DTR → R4 → Q1 base. Q1 emitter goes to RTS and its collector to IO0.
  - RTS → R5 → Q2 base. Q2 emitter goes to DTR and its collector to EN.
- EN: R6 10 kΩ to 3V3 and C7 1 µF to GND (Espressif's RC delay); SW1 RESET to GND.
- IO0: R7 10 kΩ to 3V3; SW2 BOOT to GND. **Both buttons must be reachable through the front of the case:** the node firmware (mesh) uses BOOT at power-up to reopen its setup network.

### ESP32 module
- U1: ESP32-WROOM-32E-N4. 3V3 decoupling at the module: C8 22 µF + C9 100 nF + C10 100 nF.
- The antenna sits at a board edge with no copper on any layer under or next to it (see Espressif's keep-out drawing), as far as possible from the relays and the mains area.

### Outputs R1–R4 (×4, n = 1…4)
Each output is a low-side N-MOSFET with its gate held low, so the output is off while the ESP32 boots (GPIO 16–19 float at reset).

- GPIO → Rg(n) 100 Ω → gate Qn (AO3400A). Rpd(n) 100 kΩ from gate to GND.
- **R1, R2 (relays K1, K2, Omron G2RL-1 DC5):** coil between 5V and the drain. Flyback diode D(n) 1N4148W across the coil (cathode to 5V). Indicator LED + 1 kΩ from 5V to the drain.
- **R3, R4 (SSRs K3, K4, G3MB-202P):** input + to 5V, input − to the drain. Indicator LED + 1 kΩ from 5V to the drain. Load side: terminal "SSR L in" (shared) → fuse F3/F4 (2 A time-lag, TR5) → SSR terminal; the other SSR terminal goes to terminal "R3 Load" / "R4 Load". Pin order from the Omron data sheet: 1 and 2 load, 3 input +, 4 input −.
- G3MB-202P notes for the user:
  - It switches AC only; it never turns a DC load off.
  - Its built-in snubber passes a small leakage current, so a very small load such as an LED lamp under about 0.1 A can glow while the output is off. The profile note says 0.1–2 A for that reason.

### Analog inputs AI1–AI6 (×6)
Terminal → Rs 30 kΩ 1 % → node → ESP32 pin; node → Rb 10 kΩ 1 % to GND; node → C 100 nF to GND; node → BAT54S common pin. BAT54S pin 1 goes to GND and pin 2 to 3V3.

- Divider ratio 4: **10 V at the terminal = 2.5 V at the ADC**, inside the ESP32's useful 12 dB range. Full scale is reached at about 13 V.
- Input impedance is 40 kΩ, as 0–10 V sensors expect.
- Protected up to 30 V continuous: the clamp current is (30 − 3.6) / 30k ≈ 0.9 mA per input, well below what the ESP32 draws from 3V3.
- **As digital inputs** (`di`): high above about 10 V and low below about 3.3 V at the terminal. That works for 12 V and 24 V signals, but not for 5 V logic: use an IO terminal for that.
- **Scaling in the editor:** the AI block maps raw 0…4095 to min…max, and "Value at 3.3 V" is 13.2 V at the terminal. For a 0–10 V sensor that should read 0–100 %, set min 0 and max 132. The ESP32 ADC is not linear near both ends, so expect ±2–3 % without calibration (see Follow-ups).

### GPIO IO1–IO6 (×6)
- GPIO ← 100 Ω → terminal; ESD: U5 TPD4E05U06 (IO1–IO4), U6 TPD4E05U06 (IO5, IO6, SDA, SCL).
- These are 3.3 V logic pins, without isolation or level shifting. Inputs must stay within 0–3.3 V. Outputs give at most about 12 mA, enough for an LED, an external relay module input or a MOSFET module.

### I2C and 1-Wire
- SDA (GPIO 21) and SCL (GPIO 22): R 4.7 kΩ each to 3V3. Wired to the I2C terminal and J5 (JST SM04B-SRSS-TB, Qwiic pinout GND · 3V3 · SDA · SCL).
- DQ (GPIO 4): R 4.7 kΩ to 3V3. ESD: D (PESD3V3L1BA).
- F2: PTC 200 mA hold between 3V3 and the "3V3 out" net that feeds every 3V3 terminal position and J5.

## Schematic

[MB-1.kicad_sch](MB-1.kicad_sch) is the schematic (KiCad 8 format; it opens in KiCad 8, 9 and 10), and [MB-1.pdf](MB-1.pdf) is a print of it. Open [MB-1.kicad_pro](MB-1.kicad_pro) in KiCad.

**It is generated.** [gen_schematic.py](gen_schematic.py) holds every part, its value, footprint and part number, and the net on each pin. The script copies the symbols from KiCad's own libraries and draws the sheet:
- six blocks, matching the sections above;
- net labels at the pins and power symbols for GND, +5V and +3V3;
- a no-connect flag on every pin that isn't used.

To change the circuit, edit the script and generate again, rather than editing the sheet by hand:

```bash
python gen_schematic.py
kicad-cli sch erc MB-1.kicad_sch
kicad-cli sch export netlist --format kicadsexpr -o MB-1.net MB-1.kicad_sch
python check_netlist.py MB-1.net
kicad-cli sch export pdf -o MB-1.pdf MB-1.kicad_sch
```

[check_netlist.py](check_netlist.py) compares the netlist KiCad reads from the sheet with the nets in the script, pin by pin. A label that lands on the wrong pin would short or split a net without any ERC error. The current sheet gives 72 nets and 0 differences.

**ERC:** the electrical check has one expected error: "power output connected to power output" between U2 VO and U3 V3. The CH340C datasheet ties V3 to VCC when the chip runs at 3.3 V. Exclude it in KiCad's ERC dialog. On a KiCad install whose library tables were never set up, `kicad-cli` also lists "library not in the current configuration" warnings; those go away once KiCad has been started once.

**Parts that needed care:**
- *K3/K4 symbol:* KiCad has no Omron G3MB. The sheet uses the Sharp S202S02 symbol, which does the same job: input 3 (+) and 4 (−), output 1 and 2.
- *K3/K4 footprint:* `MB-1:Omron_G3MB-202P_SIP4` lives in the project library [MB-1.pretty](MB-1.pretty), drawn from Omron's G3MB data sheet (Cat. No. GC RLY8, page 3). It has four 1.0 mm holes on 1.8 mm pads, at 0, 7.62, 17.78 and 20.32 mm from pin 1 (top view). Pins 1 and 2 are the load and 3 (+) and 4 (−) the input. The body is 24.5 × 5.5 mm, with pin 4 1.69 mm from the body end. The [fp-lib-table](fp-lib-table) next to the project points KiCad to it. This is the standard G3MB-202P only: the "-4" variant has a different hole layout.
- *F3/F4:* these use TR5 fuse sockets (Littelfuse 560/460 series), so a blown fuse can be swapped.
- *K1/K2:* Omron G2RL-1 rather than the common HF3FF/SRD cube: on the cube footprint COM sits 6.3 mm from a coil pin, which leaves no room for 6 mm creepage after pads. The G2RL has its coil and contacts at opposite ends (KiCad footprint `Relay_THT:Relay_SPDT_Omron_G2RL-1`).

Reference designators on the sheet:

| Function | Refs |
|---|---|
| Power | J1, R1–R3, F1, D1, C1–C5, LED1, U2 |
| USB-serial, reset | U3, U4, Q1, Q2, R4–R7, C6, C7, SW1 (RESET), SW2 (BOOT) |
| ESP32 | U1, C8–C10 |
| Outputs (n = 1…4) | gate resistor R11–R14, gate pull-down R15–R18, MOSFET Q3–Q6, LED2–LED5 with R19–R22, relays K1/K2 with flyback D4/D5, SSRs K3/K4 with fuses F3/F4, terminals J2–J4 |
| Analog in (n = 1…6) | series R23–R28 (30k), to GND R29–R34 (10k), C11–C16, clamp D6–D11, terminal J6 |
| GPIO, buses | series R35–R40, ESD U5/U6 and D3, I2C pull-ups R8/R9, 1-Wire pull-up R10, PTC F2, terminals J7–J9, Qwiic J5 |

## PCB

[MB-1.kicad\_pcb](MB-1.kicad_pcb): two layers, 120 × 100 mm, all parts on top. Renders: [top](MB-1-top.png), [bottom](MB-1-bottom.png). Like the schematic it is generated, and then routed by a script:

```bash
"%LOCALAPPDATA%\Programs\KiCad.0in\python.exe" gen_pcb.py
"%LOCALAPPDATA%\Programs\KiCad.0in\python.exe" route.py
kicad-cli pcb drc MB-1.kicad_pcb
```

* **[gen\_pcb.py](gen_pcb.py)** reads the parts and nets from `gen_schematic.py`, places every footprint, and writes the outline, mounting holes, silkscreen labels, ground pours and design rules. Footprints keep their schematic links, so *Update PCB from Schematic* in KiCad still works. Ground pads that tracks would fence in (U4, U5, U6, the AI filter caps, each output driver's MOSFET source and gate pull-down) get a locked via before routing. Strips 0.5 mm wide along the board edge keep tracks off it. `gen_pcb.py --silk` copies the part fields (values, MPN, LCSC) from `gen_schematic.py` and redoes the silkscreen on the routed board, without touching copper.
* **[route.py](route.py)** exports the board to Freerouting, routes it (about 15 minutes), reads the result back and cleans up after it: it removes loose vias and dead-end stubs, fills the pours, adds ground stitching vias on a 4 mm grid (0.5 mm from any other hole), joins every piece of ground pour that is cut off from the main ground with a via, and widens the few tracks Freerouting necks below 0.13 mm. Freerouting's router is deterministic and can stall with a net open; route.py then retries with a slightly larger clearance margin. It needs the Freerouting 2.5 jar (from its GitHub releases) and Java 25; the native `freerouting-cli` 2.5.0 build crashes and then hangs. Freerouting's log goes to `MB-1.route.log`.

**Layout.** SELV parts fill the top 65 mm: terminals along the top edge, the ESP32 at the right edge with its antenna past the copper, USB-C and the power and USB-serial parts on the left, the four output drivers in a row above the keep-out. A 6 mm keep-out band across the board (y 65.6–71.6 mm) carries no copper on either layer. Below it are only mains parts: K1/K2 above J2/J3 on the left, K3/K4 with F3/F4 and J4 on the right. Relay coils and SSR inputs are the only things that bridge the band, through the parts themselves.

**Rules** ([MB-1.kicad\_dru](MB-1.kicad_dru) and the net classes in the project):

|Net class / rule|Clearance|Track|
|-|-|-|
|Default|0.2 mm|0.25 mm|
|Power (GND, +5V, +3V3, VBUS, 3V3 out, relay drivers)|0.2 mm|0.6 mm|
|Mains (relay contacts, SSR load side)|2.0 mm|2.0 mm|
|Mains to anything not mains|6.0 mm| |
|Mains to a mounting hole|6.0 mm| |

Mains tracks are 2 mm wide on both layers. That carries 5 A with about 20 °C rise on 1 oz copper; order 2 oz copper, or tin the mains tracks, if the relays will switch close to 5 A continuously.

**DRC:** no errors and no unconnected items. The warnings left are "footprint library not in the current configuration" (as with ERC, until KiCad has been started once) and 8 places in the driver row where reference text touches a pad; the fab clips silkscreen off pads.

**Open before ordering:**

* Milled slots between relay coil and contact pins, and between SSR input and load pins (the layout rules ask for them; the 6 mm clearance already holds without them).
* Gerbers, and a check of the part rotations in JLCPCB's placement preview (see *Ordering at JLCPCB*).
* A look at the board in KiCad's 3D viewer and a printout at 1:1 to check the terminal and relay footprints against real parts.

## BOM (one board)

Every part has an LCSC number (the `LCSC` field in the schematic and PCB, set in the `ORDER` table of [gen\_schematic.py](gen_schematic.py)). They were looked up in JLCPCB's parts catalogue on 12 November 2026; stock changes, so check the numbers again when ordering. **Basic** parts carry no setup fee at JLCPCB; every other (extended) SMD part costs $3 per order. MB-1 has 15 extended SMD parts.

**SMD, placed by JLCPCB**

| Ref | Qty | Part | MPN | LCSC | Type |
|---|---|---|---|---|---|
| U1 | 1 | ESP32 module, 4 MB | Espressif ESP32-WROOM-32E-N4 | C701341 | extended |
| U2 | 1 | LDO 3.3 V 1 A, SOT-223 | Diodes AP7361C-33E-13 | C500795 | extended (low stock, about 2,500) |
| U3 | 1 | USB-serial, SOP-16 | WCH CH340C | C84681 | extended |
| U4 | 1 | USB ESD, SOT-23-6 | ST USBLC6-2SC6 | C7519 | extended |
| U5, U6 | 2 | 4-ch ESD, USON-10 | TI TPD4E05U06DQAR | C138714 | extended |
| Q1, Q2 | 2 | NPN, SOT-23 | MMBT3904 | C20526 | basic |
| Q3–Q6 | 4 | N-MOSFET logic level, SOT-23 | AOS AO3400A | C20917 | basic |
| D1 | 1 | TVS 5 V, SMA | Littelfuse SMAJ5.0A | C83329 | extended |
| D3 | 1 | ESD diode for DQ, SOD-323 | Nexperia PESD3V3L1BA,115 | C51450 | extended |
| D4, D5 | 2 | Flyback diode, SOD-123 | 1N4148W | C81598 | basic |
| D6–D11 | 6 | Schottky pair, SOT-23 | Nexperia BAT54S,215 | C47546 | extended |
| F1 | 1 | PTC 1.5 A hold, 1812 | Bourns MF-MSMF150-2 | C89648 | extended |
| F2 | 1 | PTC 0.2 A hold, 1206 | Bourns MF-NSMF020-2 | C185112 | extended |
| J1 | 1 | USB-C 16-pin receptacle | HRO TYPE-C-31-M-12 | C165948 | extended |
| J5 | 1 | Qwiic socket | JST SM04B-SRSS-TB(LF)(SN) | C160404 | extended |
| SW1, SW2 | 2 | Tact switch 5.2 mm | E-Switch TL3342F450QG | C2886897 | extended (about 600 in stock) |
| LED1 | 1 | LED green 0603 | KENTO KT-0603G | C12624 | extended |
| LED2–LED5 | 4 | LED red 0603 | KENTO KT-0603R | C2286 | basic |
| C1 | 1 | 100 µF 16 V electrolytic, 6.3 × 5.4 mm | KNSCHA RVT100UF16V67RV0016 | C2887276 | extended |
| C2, C3 | 2 | 10 µF 25 V X5R 0805 | Samsung CL21A106KAYNNNE | C15850 | basic |
| C4, C8 | 2 | 22 µF 25 V X5R 0805 | Samsung CL21A226MAQNNNE | C45783 | basic |
| C5, C6, C9–C16 | 10 | 100 nF 50 V X7R 0603 | Yageo CC0603KRX7R9BB104 | C14663 | basic |
| C7 | 1 | 1 µF 50 V X5R 0603 | Samsung CL10A105KB8NNNC | C15849 | basic |
| R1, R2 | 2 | 5.1 kΩ 1 % 0603 | Uniroyal 0603WAF5101T5E | C23186 | basic |
| R3, R19–R22 | 5 | 1 kΩ 1 % 0603 | Uniroyal 0603WAF1001T5E | C21190 | basic |
| R4–R7, R29–R34 | 10 | 10 kΩ 1 % 0603 | Uniroyal 0603WAF1002T5E | C25804 | basic |
| R8–R10 | 3 | 4.7 kΩ 1 % 0603 | Uniroyal 0603WAF4701T5E | C23162 | basic |
| R11–R14, R35–R40 | 10 | 100 Ω 1 % 0603 | Uniroyal 0603WAF1000T5E | C22775 | basic |
| R15–R18 | 4 | 100 kΩ 1 % 0603 | Uniroyal 0603WAF1003T5E | C25803 | basic |
| R23–R28 | 6 | 30 kΩ 1 % 0603 | Uniroyal 0603WAF3002T5E | C22984 | basic |

Notes:

* *C1* is 5.4 mm tall rather than 7.7 mm: no 100 µF part in the 6.3 × 7.7 mm size was in stock. Its pads are 0.1 mm further in than the board's 6.3 × 7.7 mm land pattern, which takes it without change.
* *F2* is the 1206 version (MF-**N**SMF020-2). The MSMF series that the first BOM named is 1812 and would not fit the footprint.

**Through-hole, soldered by hand** (order from LCSC or any distributor)

| Ref | Qty | Part | MPN | LCSC | Stock at LCSC |
|---|---|---|---|---|---|
| K1, K2 | 2 | Relay SPDT 5 V 12 A | Omron G2RL-1 DC5 | C1524672 | about 1,100 |
| K3, K4 | 2 | SSR 2 A AC, zero-cross, SIP-4 | Omron G3MB-202P DC5 | C19591980 | **none**: buy elsewhere (Mouser, DigiKey, Farnell) |
| F3, F4 | 2 | TR5 fuse socket | Littelfuse 56000001009 | C142909 | yes |
| (in F3, F4) | 2 | Fuse 2 A time-lag, TR5 | Littelfuse 37212000001 | C142854 | about 1,400 |
| J2–J4 | 3 | Screw terminal 3-pos 5.08 mm | Phoenix MKDS 1,5/ 3-5,08 (1715734) | C480520 | about 1,100 |
| J6, J7 | 2 | Screw terminal 8-pos 3.5 mm | Phoenix PT 1,5/ 8-3,5-H (1984675) | C5484501 | **none**: buy elsewhere |
| J8 | 1 | Screw terminal 3-pos 3.5 mm | Phoenix PT 1,5/ 3-3,5-H (1984620) | C3816291 | about 500 |
| J9 | 1 | Screw terminal 4-pos 3.5 mm | Phoenix PT 1,5/ 4-3,5-H (1984633) | C5144867 | about 200 |
| — | 5 | M3 standoffs and screws | any | | |

### Ordering at JLCPCB

```bash
"%LOCALAPPDATA%\Programs\KiCad.0in\python.exe" jlc.py
```

[jlc.py](jlc.py) writes [jlcpcb/MB-1-bom.csv](jlcpcb/MB-1-bom.csv) and [jlcpcb/MB-1-cpl.csv](jlcpcb/MB-1-cpl.csv) from the routed board: the 89 SMD parts with their LCSC numbers, positions in mm from the board's lower-left corner, and rotations. Upload them with the Gerbers (KiCad: *File → Fabrication Outputs*, or `kicad-cli pcb export gerbers` and `kicad-cli pcb export drill`). JLCPCB's library sometimes turns a part differently from KiCad, so check each part in the placement preview, above all the SOT-23 and SOT-223 parts, the CH340C, the USB-C socket and the ESP32, and turn any that are wrong there.

## Layout rules

- **Mains area** (K1–K4 load side, F3/F4, J2–J4) on the lower part of the board.
  - At least **6 mm creepage and clearance** between any mains net and any SELV net.
  - Milled slots under the relays and SSRs between coil/input pins and contact/load pins.
  - At least 3 mm between different mains channels.
  - Load traces at least 3 mm wide on 1 oz copper, or 2 mm on 2 oz, both layers, for 5 A.
  - No ground pour inside the mains area.
- **SELV area:** one solid GND plane. The ESP32, the LDO and the CH340C sit away from the relay coil current loops.
- Antenna keep-out at the right board edge, away from the relays; keep the cabinet wall near that edge non-metallic.
- Each analog divider sits close to its ESP32 pin, with the 100 nF capacitor right at the pin.
- Silkscreen: terminal labels exactly as the profile names them (AI1…AI6, R1…R4, IO1…IO6), plus "MB-1 rev A".

## Bring-up checklist

1. With no module fitted: power on USB-C and check 5V and 3V3. Measure that DRV1–4 are high (outputs off).
2. Fit the module and flash `pio run -t upload && pio run -t uploadfs` over USB with no button presses. That tests the auto-reset circuit.
3. In the editor, choose Settings → Board → **MB-1** and let it restart. Deploy a program with one DO per output and check that each relay and SSR clicks or switches on its own channel. Power-cycle and confirm that nothing switches during boot.
4. Feed 0, 5 and 10 V to each AI and check the readings (expect raw about 0, 1550 and 3100).
5. Scan I2C with a sensor on the Qwiic socket, and read a DS18B20 on the 1-Wire terminal.

## Follow-ups (not part of rev A)

- **Analog in volts.** Let the firmware read the ADC with `analogReadMilliVolts` (Espressif's calibration), and give a profile terminal an optional scale (here ×4). The AI block would then show terminal volts, so users wouldn't need the "max 132" rule above. That needs a profile schema change in both validators.
- **Power option.** A 24 V version (buck converter to 5 V) for cabinets where USB power is unusual.
