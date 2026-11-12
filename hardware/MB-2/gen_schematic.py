#!/usr/bin/env python3
"""Generates MB-2.kicad_sch from the parts and nets below (the design in README.md).

    python gen_schematic.py [path to KiCad's share/kicad folder]

Every part uses a symbol from KiCad's own libraries, copied into the schematic.
Pins are connected with net labels (power nets with power symbols), so the
schematic is the netlist below, drawn: change a net here and generate again.
Pins not listed get a no-connect flag. Then check it with
    kicad-cli sch erc MB-2.kicad_sch
"""
import glob
import os
import re
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'MB-2.kicad_sch')

# --------------------------------------------------------------------- the design
# A part: (ref, lib:symbol, value, footprint, {pin number or name: net}, extra fields)
# Pins named in the map connect to that net; a name matches every pin with that name.
POWER = {'GND', '+5V', '+3V3'}

# Hand-soldered build: 0805 passives with the hand-solder land patterns, through-hole connectors.
FP = {
    'R': 'Resistor_SMD:R_0805_2012Metric_Pad1.20x1.40mm_HandSolder',
    'R1210': 'Resistor_SMD:R_1210_3225Metric_Pad1.30x2.65mm_HandSolder',
    'C': 'Capacitor_SMD:C_0805_2012Metric_Pad1.18x1.45mm_HandSolder',
    'CP': 'Capacitor_SMD:CP_Elec_6.3x7.7',
    'SMA': 'Diode_SMD:D_SMA_Handsoldering',
    'PTC1812': 'Fuse:Fuse_1812_4532Metric_Pad1.30x3.40mm_HandSolder',
    'PTC1206': 'Fuse:Fuse_1206_3216Metric_Pad1.42x1.75mm_HandSolder',
    'SOCK15': 'Connector_PinSocket_2.54mm:PinSocket_1x15_P2.54mm_Vertical',
    'SOCK10': 'Connector_PinSocket_2.54mm:PinSocket_1x10_P2.54mm_Vertical',
    'HDR6': 'Connector_PinHeader_2.54mm:PinHeader_1x06_P2.54mm_Vertical',
    'JMP': 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical',
    'MKDS2': 'TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-2-5.08_1x02_P5.08mm_Horizontal',
    **{f'PT{n}': f'TerminalBlock_Phoenix:TerminalBlock_Phoenix_PT-1,5-{n}-3.5-H_1x0{n}_P3.50mm_Horizontal' for n in (3, 4, 5, 6, 7, 8)},
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


def R(ref, value, a, b, fp='R', **f): part(ref, 'Device:R', value, fp, {'1': a, '2': b}, **f)
def C(ref, value, a, b, fp='C', **f): part(ref, 'Device:C', value, fp, {'1': a, '2': b}, **f)


# Power: 12-24 V in, 5 V switching regulator, DevKit VIN through a diode
block('Power: 12-24 V in, 5 V 1 A switching regulator', 0)
part('J1', 'Connector:Screw_Terminal_01x02', '12-24 V DC', 'MKDS2', {'1': 'VIN_RAW', '2': 'GND'},
     MPN='Phoenix MKDS 1,5/2-5,08 (1715721)')
part('F1', 'Device:Polyfuse', '1.1A hold', 'PTC1812', {'1': 'VIN_RAW', '2': 'VIN_F'}, MPN='Bourns MF-MSMF110-2')
part('D1', 'Diode:SS34', 'SS34', 'SMA', {'A': 'VIN_F', 'K': '+VS'}, MPN='SS34 (40 V 3 A Schottky)')
part('D2', 'Diode:SMAJ30A', 'SMAJ30A', 'SMA', {'1': '+VS', '2': 'GND'}, MPN='Littelfuse SMAJ30A')
part('C1', 'Device:C_Polarized', '47u 50V', 'CP', {'1': '+VS', '2': 'GND'})
part('U1', 'Converter_DCDC:TSR1-2450E', 'TSR 1-2450E', None, {'Vin': '+VS', 'GND': 'GND', 'Vout': '+5V'},
     MPN='Traco TSR 1-2450E')
C('C2', '22u', '+5V', 'GND')
part('D3', 'Diode:SS14', 'SS14', 'SMA', {'A': '+5V', 'K': 'VIN_DK'}, MPN='SS14 (40 V 1 A Schottky)')
part('F2', 'Device:Polyfuse', '0.2A hold', 'PTC1206', {'1': '+3V3', '2': '3V3_OUT'}, MPN='Bourns MF-NSMF020-2')
part('F3', 'Device:Polyfuse', '0.1A hold', 'PTC1206', {'1': '+VS', '2': 'VLOOP'}, MPN='Bourns MF-NSMF010-2')
part('#FLG01', 'power:PWR_FLAG', 'PWR_FLAG', None, {'1': '+3V3'})
part('#FLG02', 'power:PWR_FLAG', 'PWR_FLAG', None, {'1': 'GND'})
part('#FLG03', 'power:PWR_FLAG', 'PWR_FLAG', None, {'1': '+VS'})

# ESP32 DevKit sockets (DOIT DevKit V1, 30 pins, rows 25.4 mm apart). Pin 1 at the antenna end.
block('ESP32 DOIT DevKit V1 (30-pin) in two 1x15 sockets', 1)
part('J2', 'Connector_Generic:Conn_01x15', 'DevKit left', 'SOCK15', {
    # 1 EN, 12 GPIO12 (boot strap): not used
    '2': 'IN1', '3': 'IN2', '4': 'IN3', '5': 'IN4',          # GPIO 36 (VP), 39 (VN), 34, 35
    '6': 'TCH5', '7': 'TCH6', '8': 'GP2', '9': 'GP3',        # GPIO 32, 33, 25, 26
    '10': 'TCH4', '11': 'TCH2', '13': 'TCH1',                # GPIO 27, 14, 13
    '14': 'GND', '15': 'VIN_DK'}, MPN='Female header 1x15, 2.54 mm')
part('J3', 'Connector_Generic:Conn_01x15', 'DevKit right', 'SOCK15', {
    # 3 TX0, 4 RX0, 8 GPIO5, 12 GPIO2: not used
    '1': 'GP1', '2': 'SCL', '5': 'SDA',                      # GPIO 23, 22, 21
    '6': 'OUT4', '7': 'OUT3', '9': 'OUT2', '10': 'OUT1',     # GPIO 19, 18, 17, 16
    '11': 'DQ', '13': 'TCH3', '14': 'GND', '15': '+3V3'},    # GPIO 4, 15
    MPN='Female header 1x15, 2.54 mm')

# Precise analog inputs on an ADS1115 module
block('Analog AI1-AI4: 0-10 V (30k/10k) or 4-20 mA (jumper: 150R shunt) -> ADS1115', 1)
part('J4', 'Connector_Generic:Conn_01x10', 'ADS1115 module', 'SOCK10', {
    '1': '+3V3', '2': 'GND', '3': 'SCL', '4': 'SDA', '5': 'GND',  # VDD GND SCL SDA ADDR (0x48)
    '7': 'AIN1', '8': 'AIN2', '9': 'AIN3', '10': 'AIN4'},         # 6 ALRT: not used
    MPN='ADS1115 breakout (VDD GND SCL SDA ADDR ALRT A0-A3) + female header 1x10')
for n in range(1, 5):
    R(f'R{n}', '30k 1%', f'TAI{n}', f'AIN{n}')
    R(f'R{4 + n}', '10k 1%', f'AIN{n}', 'GND')
    C(f'C{2 + n}', '100n', f'AIN{n}', 'GND')
    part(f'D{3 + n}', 'Diode:BAT54S', 'BAT54S', None, {'A': 'GND', 'K': '+3V3', 'COM': f'AIN{n}'})
    part(f'JP{n}', 'Jumper:Jumper_2_Open', 'mA', 'JMP', {'A': f'TAI{n}', 'B': f'SH{n}'})
    R(f'R{8 + n}', '150 0.5W', f'SH{n}', 'GND', 'R1210')
part('J5', 'Connector:Screw_Terminal_01x08', 'AI1-AI4, +V, GND', 'PT8',
     {'1': 'TAI1', '2': 'TAI2', '3': 'TAI3', '4': 'TAI4', '5': 'VLOOP', '6': 'VLOOP', '7': 'GND', '8': 'GND'})

# Extra inputs IN1-IN4 (input-only ADC pins)
block('Inputs IN1-IN4: 0-3.3 V on GPIO 36, 39, 34, 35', 2)
for n in range(1, 5):
    R(f'R{12 + n}', '1k', f'TIN{n}', f'IN{n}')
    C(f'C{6 + n}', '100n', f'IN{n}', 'GND')
    part(f'D{7 + n}', 'Diode:BAT54S', 'BAT54S', None, {'A': 'GND', 'K': '+3V3', 'COM': f'IN{n}'})
part('J6', 'Connector:Screw_Terminal_01x06', 'IN1-IN4, 3V3, GND', 'PT6',
     {'1': 'TIN1', '2': 'TIN2', '3': 'TIN3', '4': 'TIN4', '5': '3V3_OUT', '6': 'GND'})

# Touch pads
block('Touch T1-T6: GPIO 13, 14, 15, 27, 32, 33', 2)
for n in range(1, 7):
    R(f'R{16 + n}', '1k', f'TT{n}', f'TCH{n}')
part('J7', 'Connector:Screw_Terminal_01x07', 'T1-T6, GND', 'PT7', {**{str(n): f'TT{n}' for n in range(1, 7)}, '7': 'GND'})

# Relay-module header
block('Relay module header R1-R4: MOSFET pulls the module input low (on)', 0)
for n in range(1, 5):
    R(f'R{22 + n}', '100', f'OUT{n}', f'G{n}')
    R(f'R{26 + n}', '100k', f'G{n}', 'GND')
    part(f'Q{n}', 'Transistor_FET:2N7002', '2N7002', None, {'G': f'G{n}', 'S': 'GND', 'D': f'RIN{n}'})
part('J8', 'Connector_Generic:Conn_01x06', 'Relay module', 'HDR6',
     {'1': 'GND', '2': 'RIN1', '3': 'RIN2', '4': 'RIN3', '5': 'RIN4', '6': '+5V'})

# GPIO, I2C, 1-Wire
block('GPIO IO1-IO3 (3.3 V), I2C + Qwiic, 1-Wire', 2)
for n in range(1, 4):
    R(f'R{30 + n}', '100', f'GP{n}', f'TIO{n}')
part('J9', 'Connector:Screw_Terminal_01x05', 'IO1-IO3, 3V3, GND', 'PT5',
     {'1': 'TIO1', '2': 'TIO2', '3': 'TIO3', '4': '3V3_OUT', '5': 'GND'})
R('R34', '4.7k', 'SDA', '+3V3')
R('R35', '4.7k', 'SCL', '+3V3')
R('R36', '4.7k', 'DQ', '+3V3')
part('J10', 'Connector:Screw_Terminal_01x04', 'I2C', 'PT4', {'1': '3V3_OUT', '2': 'SDA', '3': 'SCL', '4': 'GND'})
part('J11', 'Connector_Generic:Conn_01x04', 'Qwiic', 'Connector_JST:JST_SH_SM04B-SRSS-TB_1x04-1MP_P1.00mm_Horizontal',
     {'1': 'GND', '2': '3V3_OUT', '3': 'SDA', '4': 'SCL'}, MPN='JST SM04B-SRSS-TB')
part('J12', 'Connector:Screw_Terminal_01x03', '1-Wire', 'PT3', {'1': '3V3_OUT', '2': 'DQ', '3': 'GND'})

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
NS = uuid.UUID('6d8e2a8c-5b1f-4c7e-9a52-0e05b1c0de02')
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
            out.append(f'  (instances (project "MB-2" (path {q("/" + root)} (reference {q(p["ref"])}) (unit 1))))')
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
                        f'  (instances (project "MB-2" (path {q("/" + root)} (reference {q(ref)}) (unit 1)))))')
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
            if net not in POWER:  # a labelled rail (e.g. +VS behind the input diode): the label joins the flag to it
                items.append(f'(label {q(net)} (at {fmt(X)} {fmt(Y)} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid {q(U())}))')
                continue
            sym_name = {'GND': 'power:GND', '+5V': 'power:+5V', '+3V3': 'power:+3V3'}[net]
            syms.setdefault(sym_name, flat_symbol(sym_name))
            ref = '#PWR' + str(len(items))
            rot = 0
            items.append(
                f'(symbol (lib_id {q(sym_name)}) (at {fmt(X)} {fmt(Y)} {rot}) (unit 1) (exclude_from_sim no) '
                f'(in_bom no) (on_board no) (dnp no) (uuid {q(U())})\n'
                f'  (property "Reference" {q(ref)} (at {fmt(X)} {fmt(Y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))\n'
                f'  (property "Value" {q(net)} (at {fmt(X + (2.54 if net == "GND" else 6.35))} {fmt(Y + (3.81 if net == "GND" else -1.27))} 0) (effects (font (size 1.27 1.27))))\n'
                f'  (property "Footprint" "" (at {fmt(X)} {fmt(Y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))\n'
                f'  (property "Datasheet" "" (at {fmt(X)} {fmt(Y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))\n'
                f'  (pin "1" (uuid {q(U())}))\n'
                f'  (instances (project "MB-2" (path {q("/" + root)} (reference {q(ref)}) (unit 1)))))')
    single = [n for n, v in nets_seen.items() if len(v) < 2 and n not in POWER]
    for n in single:
        issues.append(f'net {n} has only one pin: {nets_seen[n]}')
    if issues:
        print('\n'.join(issues))
        sys.exit(1)
    head = ('(kicad_sch (version 20231120) (generator "eeschema") (generator_version "8.0")\n'
            f'  (uuid {q(root)})\n  (paper "A2")\n'
            '  (title_block (title "MB-2: sensor node, 4 analog in, 6 touch, relay-module header") (rev "A") (company "EspressOS")\n'
            '    (comment 1 "Generated by gen_schematic.py from the design in README.md; edit the script, not this file")\n'
            '    (comment 2 "Board profile eos-mb2 (web/js/boards.js): keep GPIOs and terminal labels in step"))\n')
    body = '  (lib_symbols\n' + '\n'.join('    ' + dump(s, 2) for s in syms.values()) + '\n  )\n'
    body += '\n'.join(items)
    body += f'\n  (sheet_instances (path "/" (page "1")))\n)\n'
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(head + body)
    print(f'{OUT}: {len(PARTS)} parts, {len(nets_seen)} nets')


if __name__ == '__main__':
    main()
