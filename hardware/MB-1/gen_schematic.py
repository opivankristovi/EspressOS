#!/usr/bin/env python3
"""Generates MB-1.kicad_sch from the parts and nets below (the design in README.md).

    python gen_schematic.py [path to KiCad's share/kicad folder]

Every part uses a symbol from KiCad's own libraries, copied into the schematic.
Pins are connected with net labels (power nets with power symbols), so the
schematic is the netlist below, drawn: change a net here and generate again.
Pins not listed get a no-connect flag. Then check it with
    kicad-cli sch erc MB-1.kicad_sch
"""
import glob
import os
import re
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'MB-1.kicad_sch')

# --------------------------------------------------------------------- the design
# A part: (ref, lib:symbol, value, footprint, {pin number or name: net}, extra fields)
# Pins named in the map connect to that net; a name matches every pin with that name.
POWER = {'GND', '+5V', '+3V3'}

FP = {
    'R': 'Resistor_SMD:R_0603_1608Metric',
    'C': 'Capacitor_SMD:C_0603_1608Metric',
    'C0805': 'Capacitor_SMD:C_0805_2012Metric',
    'CP': 'Capacitor_SMD:CP_Elec_6.3x7.7',
    'LED': 'LED_SMD:LED_0603_1608Metric',
    'SOT23': 'Package_TO_SOT_SMD:SOT-23',
    'SOD123': 'Diode_SMD:D_SOD-123',
    'SOD323': 'Diode_SMD:D_SOD-323',
    'SMA': 'Diode_SMD:D_SMA',
    'PTC1812': 'Fuse:Fuse_1812_4532Metric',
    'PTC1206': 'Fuse:Fuse_1206_3216Metric',
    'TR5': 'Fuse:Fuseholder_TR5_Littelfuse_No560_No460',
    # Not in the KiCad library: MB-1.pretty (drawn from Omron's G3MB data sheet, standard pinout)
    'G3MB': 'MB-1:Omron_G3MB-202P_SIP4',
    'MKDS3': 'TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-3-5.08_1x03_P5.08mm_Horizontal',
    'MKDS4': 'TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-4-5.08_1x04_P5.08mm_Horizontal',
    'PT3': 'TerminalBlock_Phoenix:TerminalBlock_Phoenix_PT-1,5-3-3.5-H_1x03_P3.50mm_Horizontal',
    'PT4': 'TerminalBlock_Phoenix:TerminalBlock_Phoenix_PT-1,5-4-3.5-H_1x04_P3.50mm_Horizontal',
    'PT8': 'TerminalBlock_Phoenix:TerminalBlock_Phoenix_PT-1,5-8-3.5-H_1x08_P3.50mm_Horizontal',
    'SW': 'Button_Switch_SMD:SW_SPST_TL3342',
}

PARTS = []  # filled by the blocks below; each block is a titled group on the sheet
BLOCKS = []


COLUMNS = [(15, 185), (215, 170), (400, 180)]  # x, width of the three columns on the A2 sheet (mm)


def block(title, col):
    x, w = COLUMNS[col]
    BLOCKS.append({'title': title, 'col': col, 'x': x, 'w': w, 'parts': []})


def part(ref, sym, value, fp, pins, **fields):
    p = {'ref': ref, 'sym': sym, 'value': value, 'fp': FP.get(fp, fp), 'pins': pins, 'fields': fields}
    BLOCKS[-1]['parts'].append(p)
    PARTS.append(p)


def R(ref, value, a, b, **f): part(ref, 'Device:R', value, 'R', {'1': a, '2': b}, **f)
def C(ref, value, a, b, fp='C', **f): part(ref, 'Device:C', value, fp, {'1': a, '2': b}, **f)


# Power: USB-C 5 V in, 3.3 V LDO
block('Power: USB-C 5 V, 3.3 V regulator', 0)
part('J1', 'Connector:USB_C_Receptacle_USB2.0_16P', 'USB-C', 'Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12',
     {'VBUS': 'VBUS_IN', 'GND': 'GND', 'SHIELD': 'GND', 'CC1': 'CC1', 'CC2': 'CC2', 'D+': 'USB_DP', 'D-': 'USB_DM'},
     MPN='HRO TYPE-C-31-M-12')
R('R1', '5.1k 1%', 'CC1', 'GND')
R('R2', '5.1k 1%', 'CC2', 'GND')
part('F1', 'Device:Polyfuse', '1.5A hold', 'PTC1812', {'1': 'VBUS_IN', '2': '+5V'}, MPN='Bourns MF-MSMF150-2')
part('D1', 'Diode:SMAJ5.0A', 'SMAJ5.0A', None, {'1': '+5V', '2': 'GND'}, MPN='Littelfuse SMAJ5.0A')
part('C1', 'Device:C_Polarized', '100u 10V', 'CP', {'1': '+5V', '2': 'GND'})
C('C2', '10u', '+5V', 'GND', 'C0805')
part('U2', 'Regulator_Linear:AP7361C-33E', 'AP7361C-33E', None, {'VI': '+5V', 'VO': '+3V3', 'GND': 'GND'},
     MPN='Diodes AP7361C-33E-13')
C('C3', '10u', '+5V', 'GND', 'C0805')
C('C4', '22u', '+3V3', 'GND', 'C0805')
C('C5', '100n', '+3V3', 'GND')
R('R3', '1k', '+3V3', 'LED1_A')
part('LED1', 'Device:LED', 'green', 'LED', {'2': 'LED1_A', '1': 'GND'})
part('#FLG01', 'power:PWR_FLAG', 'PWR_FLAG', None, {'1': '+5V'})
part('#FLG02', 'power:PWR_FLAG', 'PWR_FLAG', None, {'1': 'GND'})

# USB-serial and auto-reset
block('USB-serial (CH340C at 3.3 V) and auto-reset', 0)
part('U4', 'Power_Protection:USBLC6-2SC6', 'USBLC6-2SC6', None,
     {'I/O1': 'USB_DP', 'I/O2': 'USB_DM', 'VBUS': '+5V', 'GND': 'GND'}, MPN='ST USBLC6-2SC6')
part('U3', 'Interface_USB:CH340C', 'CH340C', None,
     {'UD+': 'USB_DP', 'UD-': 'USB_DM', 'VCC': '+3V3', 'V3': '+3V3', 'GND': 'GND',
      'TXD': 'RXD0', 'RXD': 'TXD0', '~{DTR}': 'DTR', '~{RTS}': 'RTS'}, MPN='WCH CH340C')
C('C6', '100n', '+3V3', 'GND')
R('R4', '10k', 'DTR', 'Q1_B')
part('Q1', 'Transistor_BJT:MMBT3904', 'MMBT3904', None, {'B': 'Q1_B', 'E': 'RTS', 'C': 'IO0'})
R('R5', '10k', 'RTS', 'Q2_B')
part('Q2', 'Transistor_BJT:MMBT3904', 'MMBT3904', None, {'B': 'Q2_B', 'E': 'DTR', 'C': 'EN'})
R('R6', '10k', 'EN', '+3V3')
C('C7', '1u', 'EN', 'GND')
part('SW1', 'Switch:SW_Push', 'RESET', 'SW', {'1': 'EN', '2': 'GND'})
R('R7', '10k', 'IO0', '+3V3')
part('SW2', 'Switch:SW_Push', 'BOOT', 'SW', {'1': 'IO0', '2': 'GND'})

# ESP32 module
block('ESP32-WROOM-32E (never WROVER: GPIO 16/17 are outputs)', 1)
part('U1', 'RF_Module:ESP32-WROOM-32E', 'ESP32-WROOM-32E-N4', None, {
    'GND': 'GND', 'VDD': '+3V3', 'EN': 'EN', 'IO0': 'IO0', 'TXD0/IO1': 'TXD0', 'RXD0/IO3': 'RXD0',
    'SENSOR_VP': 'AIN1', 'SENSOR_VN': 'AIN2', 'IO34': 'AIN3', 'IO35': 'AIN4', 'IO32': 'AIN5', 'IO33': 'AIN6',
    'IO16': 'OUT1', 'IO17': 'OUT2', 'IO18': 'OUT3', 'IO19': 'OUT4',
    'IO23': 'GP1', 'IO25': 'GP2', 'IO26': 'GP3', 'IO27': 'GP4', 'IO13': 'GP5', 'IO14': 'GP6',
    'IO21': 'SDA', 'IO22': 'SCL', 'IO4': 'DQ'}, MPN='Espressif ESP32-WROOM-32E-N4')
C('C8', '22u', '+3V3', 'GND', 'C0805')
C('C9', '100n', '+3V3', 'GND')
C('C10', '100n', '+3V3', 'GND')

# Outputs
block('Outputs: R1/R2 relays (COM/NO/NC), R3/R4 G3MB-202P SSRs; off at boot', 2)
for n in range(1, 5):
    R(f'R{10 + n}', '100', f'OUT{n}', f'G{n}')
    R(f'R{14 + n}', '100k', f'G{n}', 'GND')
    part(f'Q{n + 2}', 'Transistor_FET:AO3400A', 'AO3400A', None, {'G': f'G{n}', 'S': 'GND', 'D': f'DRV{n}'})
    part(f'LED{n + 1}', 'Device:LED', 'red', 'LED', {'2': '+5V', '1': f'LED{n + 1}_K'})
    R(f'R{18 + n}', '1k', f'LED{n + 1}_K', f'DRV{n}')
for n in (1, 2):
    # G2RL: coil and contacts at opposite ends (8 mm creepage, reinforced insulation), so the
    # coil side can stay 6 mm from mains copper. The SRD/HF3FF pinout has COM next to the coil.
    part(f'K{n}', 'Relay:G2RL-1', 'G2RL-1 DC5', None,
         {'A1': '+5V', 'A2': f'DRV{n}', '11': f'R{n}_COM', '14': f'R{n}_NO', '12': f'R{n}_NC'},
         MPN='Omron G2RL-1 DC5')
    part(f'D{n + 3}', 'Diode:1N4148W', '1N4148W', None, {'K': '+5V', 'A': f'DRV{n}'})
for n in (3, 4):
    # Symbol: Sharp S202S02 (same function: zero-cross triac SSR, input 3+/4-, output 1/2).
    part(f'K{n}', 'Relay_SolidState:S202S02', 'G3MB-202P DC5', 'G3MB',
         {'3': '+5V', '4': f'DRV{n}', '1': f'R{n}_LF', '2': f'R{n}_LOAD'}, MPN='Omron G3MB-202P DC5')
    part(f'F{n}', 'Device:Fuse', '2A T', 'TR5', {'1': 'SSR_L', '2': f'R{n}_LF'}, MPN='Littelfuse 372 series 2 A T')
part('J2', 'Connector:Screw_Terminal_01x03', 'R1 COM/NO/NC', 'MKDS3', {'1': 'R1_COM', '2': 'R1_NO', '3': 'R1_NC'},
     MPN='Phoenix MKDS 1,5/3-5,08 (1715734)')
part('J3', 'Connector:Screw_Terminal_01x03', 'R2 COM/NO/NC', 'MKDS3', {'1': 'R2_COM', '2': 'R2_NO', '3': 'R2_NC'},
     MPN='Phoenix MKDS 1,5/3-5,08 (1715734)')
# R3 and R4 share one L in (same phase and breaker); each SSR keeps its own fuse.
part('J4', 'Connector:Screw_Terminal_01x03', 'SSR L in, R3 load, R4 load', 'MKDS3',
     {'1': 'SSR_L', '2': 'R3_LOAD', '3': 'R4_LOAD'}, MPN='Phoenix MKDS 1,5/3-5,08 (1715734)')

# Analog inputs
block('Analog inputs AI1-AI6: 0-10 V, 30k/10k divider (10 V = 2.5 V)', 1)
for n in range(1, 7):
    R(f'R{22 + n}', '30k 1%', f'TAI{n}', f'AIN{n}')
    R(f'R{28 + n}', '10k 1%', f'AIN{n}', 'GND')
    C(f'C{10 + n}', '100n', f'AIN{n}', 'GND')
    part(f'D{5 + n}', 'Diode:BAT54S', 'BAT54S', None, {'1': 'GND', '2': '+3V3', '3': f'AIN{n}'})
part('J6', 'Connector:Screw_Terminal_01x08', 'AI1-AI6, GND', 'PT8',
     {**{str(n): f'TAI{n}' for n in range(1, 7)}, '7': 'GND', '8': 'GND'})

# GPIO, I2C, 1-Wire
block('GPIO IO1-IO6 (3.3 V), I2C, 1-Wire', 2)
for n in range(1, 7):
    R(f'R{34 + n}', '100', f'GP{n}', f'TIO{n}')
part('U5', 'Power_Protection:TPD4E05U06DQA', 'TPD4E05U06', None,
     {'D1+': 'TIO1', 'D1-': 'TIO2', 'D2+': 'TIO3', 'D2-': 'TIO4', 'GND': 'GND'}, MPN='TI TPD4E05U06DQAR')
part('U6', 'Power_Protection:TPD4E05U06DQA', 'TPD4E05U06', None,
     {'D1+': 'TIO5', 'D1-': 'TIO6', 'D2+': 'SDA', 'D2-': 'SCL', 'GND': 'GND'}, MPN='TI TPD4E05U06DQAR')
part('J7', 'Connector:Screw_Terminal_01x08', 'IO1-IO6, 3V3, GND', 'PT8',
     {**{str(n): f'TIO{n}' for n in range(1, 7)}, '7': '3V3_OUT', '8': 'GND'})
part('F2', 'Device:Polyfuse', '0.2A hold', 'PTC1206', {'1': '+3V3', '2': '3V3_OUT'}, MPN='Bourns MF-MSMF020-2')
R('R8', '4.7k', 'SDA', '+3V3')
R('R9', '4.7k', 'SCL', '+3V3')
R('R10', '4.7k', 'DQ', '+3V3')
part('D3', 'Device:D_TVS', 'PESD3V3L1BA', 'SOD323', {'1': 'DQ', '2': 'GND'}, MPN='Nexperia PESD3V3L1BA')
part('J8', 'Connector:Screw_Terminal_01x03', '1-Wire', 'PT3', {'1': '3V3_OUT', '2': 'DQ', '3': 'GND'})
part('J9', 'Connector:Screw_Terminal_01x04', 'I2C', 'PT4', {'1': '3V3_OUT', '2': 'SDA', '3': 'SCL', '4': 'GND'})
part('J5', 'Connector_Generic:Conn_01x04', 'Qwiic', 'Connector_JST:JST_SH_SM04B-SRSS-TB_1x04-1MP_P1.00mm_Horizontal',
     {'1': 'GND', '2': '3V3_OUT', '3': 'SDA', '4': 'SCL'}, MPN='JST SM04B-SRSS-TB')

# --------------------------------------------------------------------- s-expressions
def parse(text):
    tokens = re.findall(r'"(?:[^"\\]|\\.)*"|\(|\)|[^\s()"]+', text)
    stack = [[]]
    for t in tokens:
        if t == '(':
            stack.append([])
        elif t == ')':
            x = stack.pop()
            stack[-1].append(x)
        else:
            stack[-1].append(t)
    return stack[0][0]


def dump(x, ind=0):
    if not isinstance(x, list):
        return x
    if all(not isinstance(e, list) for e in x):
        return '(' + ' '.join(x) + ')'
    pad = '\n' + '  ' * (ind + 1)
    return '(' + ' '.join(e for e in x if not isinstance(e, list)) + ''.join(pad + dump(e, ind + 1) for e in x if isinstance(e, list)) + ')'


def q(s): return '"' + str(s).replace('\\', '\\\\').replace('"', '\\"') + '"'
def uq(s): return s[1:-1].replace('\\"', '"').replace('\\\\', '\\') if s.startswith('"') else s
def child(x, tag): return next((e for e in x if isinstance(e, list) and e and e[0] == tag), None)
def children(x, tag): return [e for e in x if isinstance(e, list) and e and e[0] == tag]


# --------------------------------------------------------------------- KiCad libraries
def kicad_share():
    if len(sys.argv) > 1:
        return sys.argv[1]
    pats = [os.path.expandvars(r'%LOCALAPPDATA%\Programs\KiCad\*\share\kicad'), r'C:\Program Files\KiCad\*\share\kicad',
            '/usr/share/kicad', '/Applications/KiCad/KiCad.app/Contents/SharedSupport']
    for p in pats:
        hits = sorted(glob.glob(p))
        if hits:
            return hits[-1]
    sys.exit('KiCad libraries not found: pass the path to share/kicad')


LIBS = {}


def lib(name):
    if name not in LIBS:
        path = os.path.join(SHARE, 'symbols', name + '.kicad_sym')
        folder = os.path.join(SHARE, 'symbols', name + '.kicad_symdir')  # KiCad 10: one file per symbol
        files = [path] if os.path.exists(path) else sorted(glob.glob(os.path.join(folder, '*.kicad_sym')))
        if not files:
            sys.exit(f'No symbol library {name} ({path} or {folder})')
        LIBS[name] = {}
        for fn in files:
            with open(fn, encoding='utf-8') as f:
                LIBS[name].update({uq(s[1]): s for s in children(parse(f.read()), 'symbol')})
    return LIBS[name]


def flat_symbol(full):
    """The library symbol, with `extends` resolved, renamed to lib:name for the schematic."""
    libname, name = full.split(':')
    syms = lib(libname)
    if name not in syms:
        close = [n for n in syms if name.lower()[:6] in n.lower()][:8]
        sys.exit(f'No symbol {full}. Similar: {close}')
    s = syms[name]
    ext = child(s, 'extends')
    if ext:
        base = flat_symbol(libname + ':' + uq(ext[1]))
        bname = uq(base[1]).split(':')[1]
        props = {uq(p[1]): p for p in children(s, 'property')}
        head, subs = [base[0], q(full)], []
        for e in base[2:]:
            if isinstance(e, list) and e[0] == 'property' and uq(e[1]) in props:
                head.append(props.pop(uq(e[1])))  # the derived symbol's value wins
            elif isinstance(e, list) and e[0] == 'symbol':
                subs.append(['symbol', q(uq(e[1]).replace(bname, name, 1))] + e[2:])
            else:
                head.append(e)
        return head + list(props.values()) + subs
    out = [s[0], q(full)] + [e for e in s[2:]]
    return out


def pins_of(sym):
    """[(number, name, x, y, angle, type)] in symbol coordinates (y up), unit 1 / common."""
    res = []
    for sub in children(sym, 'symbol'):
        unit = uq(sub[1]).rsplit('_', 2)[-2]
        if unit not in ('0', '1'):
            continue
        for p in children(sub, 'pin'):
            at = child(p, 'at')
            res.append((uq(child(p, 'number')[1]), uq(child(p, 'name')[1]), float(at[1]), float(at[2]),
                        int(float(at[3])) if len(at) > 3 else 0, p[1]))
    return res


def bbox(sym):
    xs, ys = [], []
    for sub in children(sym, 'symbol'):
        for g in sub[2:]:
            if not isinstance(g, list):
                continue
            for pt in [e for e in g if isinstance(e, list) and e[0] in ('start', 'end', 'at', 'center')] + \
                      [xy for pts in children(g, 'pts') for xy in children(pts, 'xy')]:
                try:
                    xs.append(float(pt[1])); ys.append(float(pt[2]))
                except (ValueError, IndexError):
                    pass
    return (min(xs), min(ys), max(xs), max(ys)) if xs else (-2.54, -2.54, 2.54, 2.54)


# --------------------------------------------------------------------- layout and output
def snap(v, g=2.54): return round(v / g) * g
def fmt(v): return ('%.4f' % v).rstrip('0').rstrip('.')
# Stable ids: the same design gives the same file (clean diffs), and the PCB stays linked to its symbols.
NS = uuid.UUID('6d8e2a8c-5b1f-4c7e-9a52-0e05b1c0de01')
_count = [0]


def U(key=None):
    if key is None:
        _count[0] += 1
        key = 'item%d' % _count[0]
    return str(uuid.uuid5(NS, key))


SHARE = kicad_share()


def main():
    root = U('root')
    syms, items = {}, []
    nets_seen = {}
    issues = []
    col_y = {c: 30 for c in range(len(COLUMNS))}
    for blk in BLOCKS:
        blk['y'] = col_y[blk['col']]
        items.append(f'(text {q(blk["title"])} (exclude_from_sim no) (at {fmt(blk["x"])} {fmt(blk["y"] - 6)} 0) '
                     f'(effects (font (size 2.54 2.54) (thickness 0.4) bold) (justify left bottom)) (uuid {q(U())}))')
        cx, cy, row_h = blk['x'], blk['y'], 0
        for p in blk['parts']:
            sym = syms.setdefault(p['sym'], flat_symbol(p['sym']))
            pins = pins_of(sym)
            x0, y0, x1, y1 = bbox(sym)
            for _, _, px, py, _, _ in pins:
                x0, x1, y0, y1 = min(x0, px), max(x1, px), min(y0, py), max(y1, py)
            power = p['sym'].startswith('power:')
            # room around the body for the labels and power symbols at its pins
            side = {0: 6.0, 90: 4.0, 180: 6.0, 270: 4.0}  # outward direction -> mm
            for num, name, px, py, ang, _ in pins:
                net = p['pins'].get(num, p['pins'].get(name))
                need = 8 if net in POWER or power else (len(net) * 1.1 + 3 if net else 3)
                o = (ang + 180) % 360
                side[o] = max(side[o], need)
            L, R_, T, B = side[180], side[0] + 8, side[90], side[270]  # +8: reference and value text
            w, h = (x1 - x0) + L + R_, (y1 - y0) + T + B
            if cx + w > blk['x'] + blk['w'] and cx > blk['x']:
                cx, cy, row_h = blk['x'], cy + row_h, 0
            X, Y = snap(cx + L - x0), snap(cy + T + y1)
            cx += w
            row_h = max(row_h, h)
            p['at'] = (X, Y)
            # pin -> net
            want = dict(p['pins'])
            conn = {}
            for num, name, px, py, ang, ptype in pins:
                net = want.get(num, want.get(name))
                if net is None:
                    continue
                conn[(num, px, py, ang)] = net
            used = {k for k in want if any(k in (num, name) for num, name, *_ in pins)}
            for k in set(want) - used:
                issues.append(f'{p["ref"]}: no pin {k!r} on {p["sym"]} (pins: {sorted({n for _, n, *_ in pins})})')
            props = {uq(e[1]): e for e in children(sym, 'property')}
            lib_fp = uq(props['Footprint'][2]) if 'Footprint' in props else ''
            fields = {'Reference': p['ref'], 'Value': p['value'], 'Footprint': p['fp'] or lib_fp,
                      'Datasheet': uq(props['Datasheet'][2]) if 'Datasheet' in props else '~'}
            if not power and not fields['Footprint']:
                issues.append(f'{p["ref"]}: no footprint')
            fields.update(p['fields'])
            out = [f'(symbol (lib_id {q(p["sym"])}) (at {fmt(X)} {fmt(Y)} 0) (unit 1) (exclude_from_sim no) '
                   f'(in_bom {"no" if power else "yes"}) (on_board {"no" if power else "yes"}) (dnp no) (uuid {q(p.setdefault("uuid", U("sym:" + p["ref"])))})']
            for i, (k, v) in enumerate(fields.items()):
                lp = props.get(k)
                at = child(lp, 'at') if lp else None
                fx, fy = (X + float(at[1]), Y - float(at[2])) if at else (X, Y + 2.54 * i)
                rot = at[3] if at and len(at) > 3 else '0'
                hide = k not in ('Reference', 'Value') or bool(lp and ('hide' in str(child(lp, 'effects')) or child(lp, 'hide')))
                if k == 'Reference' and p['ref'].startswith('#'):
                    hide = True
                eff = child(lp, 'effects') if lp else None
                just = child(eff, 'justify') if eff else None
                out.append(f'  (property {q(k)} {q(v)} (at {fmt(fx)} {fmt(fy)} {rot}) '
                           f'(effects (font (size 1.27 1.27)){" " + dump(just) if just else ""}{" (hide yes)" if hide else ""}))')
            for num, *_ in pins:
                out.append(f'  (pin {q(num)} (uuid {q(U())}))')
            out.append(f'  (instances (project "MB-1" (path {q("/" + root)} (reference {q(p["ref"])}) (unit 1))))')
            out.append(')')
            items.append('\n'.join(out))
            # labels, power symbols, no-connects at the pin ends
            seen_pos = set()
            for num, name, px, py, ang, ptype in pins:
                sx, sy = X + px, Y - py
                if (sx, sy) in seen_pos:
                    continue  # stacked pins (several GND on one spot)
                seen_pos.add((sx, sy))
                net = conn.get((num, px, py, ang))
                if power:
                    continue
                if net is None:
                    if ptype not in ('no_connect',) and not name.startswith('NC'):
                        pass
                    items.append(f'(no_connect (at {fmt(sx)} {fmt(sy)}) (uuid {q(U())}))')
                    continue
                nets_seen.setdefault(net, []).append(f'{p["ref"]}.{num}')
                out_ang = (ang + 180) % 360  # the side away from the body
                if net in POWER:
                    sym_name = {'GND': 'power:GND', '+5V': 'power:+5V', '+3V3': 'power:+3V3'}[net]
                    psym = syms.setdefault(sym_name, flat_symbol(sym_name))
                    down = net == 'GND'
                    rot = {0: 90, 180: 270, 90: 180, 270: 0}[out_ang] if down else {0: 270, 180: 90, 90: 0, 270: 180}[out_ang]
                    ref = '#PWR' + str(len(items))
                    vx, vy, vj = {0: (5.6, 0, 'left'), 180: (-5.6, 0, 'right'), 90: (0, -5.6, 'bottom'), 270: (0, 5.6, 'top')}[out_ang]
                    items.append(
                        f'(symbol (lib_id {q(sym_name)}) (at {fmt(sx)} {fmt(sy)} {rot}) (unit 1) (exclude_from_sim no) '
                        f'(in_bom no) (on_board no) (dnp no) (uuid {q(U())})\n'
                        f'  (property "Reference" {q(ref)} (at {fmt(sx)} {fmt(sy)} 0) (effects (font (size 1.27 1.27)) (hide yes)))\n'
                        f'  (property "Value" {q(net)} (at {fmt(sx + vx)} {fmt(sy + vy)} 0) '
                        f'(effects (font (size 1.016 1.016)) (justify {vj})))\n'
                        f'  (property "Footprint" "" (at {fmt(sx)} {fmt(sy)} 0) (effects (font (size 1.27 1.27)) (hide yes)))\n'
                        f'  (property "Datasheet" "" (at {fmt(sx)} {fmt(sy)} 0) (effects (font (size 1.27 1.27)) (hide yes)))\n'
                        f'  (pin "1" (uuid {q(U())}))\n'
                        f'  (instances (project "MB-1" (path {q("/" + root)} (reference {q(ref)}) (unit 1)))))')
                else:
                    just = {0: 'left bottom', 180: 'right bottom', 90: 'left bottom', 270: 'right bottom'}[out_ang]
                    items.append(f'(label {q(net)} (at {fmt(sx)} {fmt(sy)} {out_ang}) '
                                 f'(effects (font (size 1.27 1.27)) (justify {just})) (uuid {q(U())}))')
        col_y[blk['col']] = cy + row_h + 24
    # power flags connect by being on the net: give them a power symbol too
    for p in PARTS:
        if p['sym'] == 'power:PWR_FLAG':
            X, Y = p['at']
            net = p['pins']['1']
            nets_seen.setdefault(net, []).append(p['ref'])
            sym_name = {'GND': 'power:GND', '+5V': 'power:+5V', '+3V3': 'power:+3V3'}[net]
            syms.setdefault(sym_name, flat_symbol(sym_name))
            ref = '#PWR' + str(len(items))
            rot = 0
            items.append(
                f'(symbol (lib_id {q(sym_name)}) (at {fmt(X)} {fmt(Y)} {rot}) (unit 1) (exclude_from_sim no) '
                f'(in_bom no) (on_board no) (dnp no) (uuid {q(U())})\n'
                f'  (property "Reference" {q(ref)} (at {fmt(X)} {fmt(Y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))\n'
                f'  (property "Value" {q(net)} (at {fmt(X + 2.54)} {fmt(Y + (3.81 if net == "GND" else -3.81))} 0) (effects (font (size 1.27 1.27))))\n'
                f'  (property "Footprint" "" (at {fmt(X)} {fmt(Y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))\n'
                f'  (property "Datasheet" "" (at {fmt(X)} {fmt(Y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))\n'
                f'  (pin "1" (uuid {q(U())}))\n'
                f'  (instances (project "MB-1" (path {q("/" + root)} (reference {q(ref)}) (unit 1)))))')
    single = [n for n, v in nets_seen.items() if len(v) < 2 and n not in POWER]
    for n in single:
        issues.append(f'net {n} has only one pin: {nets_seen[n]}')
    if issues:
        print('\n'.join(issues))
        sys.exit(1)
    head = ('(kicad_sch (version 20231120) (generator "eeschema") (generator_version "8.0")\n'
            f'  (uuid {q(root)})\n  (paper "A2")\n'
            '  (title_block (title "MB-1: 6 analog in, 2 relays, 2 SSRs") (rev "A") (company "EspressOS")\n'
            '    (comment 1 "Generated by gen_schematic.py from the design in README.md; edit the script, not this file")\n'
            '    (comment 2 "Board profile eos-mb1 (web/js/boards.js): keep GPIOs and terminal labels in step"))\n')
    body = '  (lib_symbols\n' + '\n'.join('    ' + dump(s, 2) for s in syms.values()) + '\n  )\n'
    body += '\n'.join(items)
    body += f'\n  (sheet_instances (path "/" (page "1")))\n)\n'
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(head + body)
    print(f'{OUT}: {len(PARTS)} parts, {len(nets_seen)} nets')


if __name__ == '__main__':
    main()
