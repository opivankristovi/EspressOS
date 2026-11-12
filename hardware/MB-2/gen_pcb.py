#!/usr/bin/env python3
"""Generates MB-2.kicad_pcb: board outline, placement, rules and zones (no tracks).

Run it with KiCad's own Python, which has the pcbnew module:
    "%LOCALAPPDATA%\\Programs\\KiCad\\10.0\\bin\\python.exe" gen_pcb.py
Then route.py routes it with Freerouting. Parts and nets come from
gen_schematic.py, so the board always matches the schematic; footprints
keep the symbol ids, so KiCad's "Update PCB from schematic" sees no change.

Layout (top view, 120 x 80 mm, all parts on top, hand-soldered):
  top edge     terminals: analog AI1-AI4 (J5), inputs IN1-IN4 (J6), touch T1-T6 (J7)
  bottom edge  power 12-24 V (J1), GPIO (J9), I2C (J10), 1-Wire (J12), Qwiic (J11)
  left edge    relay-module header (J8) with its four MOSFET drivers
  right        ESP32 DevKit in two 1x15 sockets, antenna pointing right, past the board edge
  middle       analog front ends under their terminals, ADS1115 module socket (J4), power
"""
import json
import os
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_schematic as g  # noqa: E402  (parts, nets, symbol pins)

PCB = os.path.join(HERE, 'MB-2.kicad_pcb')
FPDIR = os.path.join(g.SHARE, 'footprints')
W, H = 120.0, 80.0
OX, OY = 100.0, 50.0  # board origin on the sheet (mm)

POWER = ['GND', '+5V', '+3V3', '+VS', 'VIN_RAW', 'VIN_F', 'VIN_DK', '3V3_OUT', 'VLOOP']
TOUCH = [f'TCH{n}' for n in range(1, 7)] + [f'TT{n}' for n in range(1, 7)]  # GPIO side and terminal side


def mm(v): return pcbnew.FromMM(v)
def pt(x, y): return pcbnew.VECTOR2I(mm(OX + x), mm(OY + y))


# ------------------------------------------------------------------ placement
# ref -> (x, y, rotation) in board mm, origin top-left, y down.
P = {}

# Top-edge terminals, wire entry to the top (rotated 180: pad 1 on the right, the rest to its left).
P['J5'] = (35.0, 5.5, 180)    # AI1..AI4, +V, +V, GND, GND: pads 35 .. 10.5
P['J6'] = (58.5, 5.5, 180)    # IN1..IN4, 3V3, GND: pads 58.5 .. 41
P['J7'] = (85.5, 5.5, 180)    # T1..T6, GND: pads 85.5 .. 64.5
TERM_TOP = {'J5': (35.0, ['AI1', 'AI2', 'AI3', 'AI4', '+V', '+V', 'GND', 'GND']),
            'J6': (58.5, ['IN1', 'IN2', 'IN3', 'IN4', '3V3', 'GND']),
            'J7': (85.5, ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'GND'])}

# Bottom-edge terminals, wire entry to the bottom (rotation 0: pad 1 on the left).
P['J1'] = (12.0, 74.4, 0)     # +12-24 V, GND (5.08 mm)
P['J9'] = (24.0, 74.5, 0)     # IO1..IO3, 3V3, GND: pads 24 .. 38
P['J10'] = (44.0, 74.5, 0)    # 3V3, SDA, SCL, GND: pads 44 .. 54.5
P['J12'] = (60.0, 74.5, 0)    # 3V3, DQ, GND: pads 60 .. 67
P['J11'] = (76.0, 76.0, 0)    # Qwiic, opening to the bottom edge
TERM_BOT = {'J9': (24.0, 3.5, ['IO1', 'IO2', 'IO3', '3V3', 'GND']),
            'J10': (44.0, 3.5, ['3V3', 'SDA', 'SCL', 'GND']), 'J12': (60.0, 3.5, ['3V3', 'DQ', 'GND'])}

# Analog front ends: one column per input under its terminal pad (30k, 10k, 100n, clamp).
for n in range(1, 5):
    x = 35.0 - 3.5 * (n - 1)
    P[f'R{n}'] = (x, 13.0, 90)                        # 30k
    P[f'R{4 + n}'] = (x, 17.5, 90)                    # 10k
    P[f'C{2 + n}'] = (x, 22.0, 90)                    # 100n
    P[f'D{3 + n}'] = (x, 27.0 if n % 2 else 31.5, 0)  # BAT54S, staggered
    P[f'JP{n}'] = (4.5 + 3.8 * (n - 1), 14.0, 0)      # 4-20 mA jumper (vertical, pads 14 / 16.54)
    P[f'R{8 + n}'] = (4.5 + 3.8 * (n - 1), 21.5, 90)  # 150 R shunt (1210)
# ADS1115 module socket, horizontal, pin 1 (VDD) on the left: A0..A3 end up near the analog columns.
P['J4'] = (24.0, 36.0, 90)    # pads 24 .. 46.86

# Extra inputs IN1-IN4: 1k, 100n, clamp under each terminal pad.
for n in range(1, 5):
    x = 58.5 - 3.5 * (n - 1)
    P[f'R{12 + n}'] = (x, 13.0, 90)
    P[f'C{6 + n}'] = (x, 17.5, 90)
    P[f'D{7 + n}'] = (x, 22.5 if n % 2 else 27.0, 0)

# Touch series resistors, under the touch terminals and close to the DevKit.
for n in range(1, 7):
    P[f'R{16 + n}'] = (85.5 - 3.5 * (n - 1), 14.0, 90)

# ESP32 DevKit (DOIT V1, 30 pin): antenna pointing right. Rotated 270, a socket's pads run to the
# left of pin 1. J2 (the DevKit's left row, antenna up) becomes the top row, J3 the bottom row.
DK_X = W - 6.0                # pin 1 column; the antenna section reaches past the board edge
P['J2'] = (DK_X, 28.0, 270)
P['J3'] = (DK_X, 53.4, 270)   # rows 25.4 mm apart

# Relay-module header on the left edge, MOSFET drivers next to it.
P['J8'] = (3.0, 36.0, 0)      # GND, IN1..IN4, VCC: pads 36 .. 48.7
for n in range(1, 5):
    y = 37.0 + 4.0 * (n - 1)
    P[f'Q{n}'] = (9.0, y, 0)       # 2N7002
    P[f'R{22 + n}'] = (13.5, y, 0)  # gate 100 R
    P[f'R{26 + n}'] = (18.0, y, 0)  # gate pull-down 100k

# Power, along the bottom above the terminals: fuse, reverse diode, TVS, bulk cap, regulator,
# output cap, DevKit VIN diode, then the 3V3 and loop PTCs.
P['F1'] = (5.0, 62.0, 90)
P['D1'] = (10.0, 62.0, 90)
P['D2'] = (15.0, 62.0, 90)
P['C1'] = (24.0, 62.0, 0)
P['U1'] = (33.0, 58.0, 0)     # TSR 1-2450E, pads vertical 58 / 60.54 / 63.08
P['C2'] = (42.0, 62.0, 90)
P['D3'] = (47.0, 62.0, 90)
P['F2'] = (60.0, 62.0, 0)     # 3V3 -> 3V3_OUT
P['F3'] = (30.0, 44.0, 90)    # +VS -> VLOOP (+V terminals)

# GPIO series resistors and bus pull-ups, left of the DevKit.
for n in range(1, 4):
    P[f'R{30 + n}'] = (52.0 + 3.5 * (n - 1), 50.0, 90)
P['R34'] = (62.5, 50.0, 90)   # SDA
P['R35'] = (66.0, 50.0, 90)   # SCL
P['R36'] = (69.5, 50.0, 90)   # DQ

HOLES = [(3.5, 3.5), (116.5, 3.5), (3.5, 76.5), (116.5, 76.5)]


# ------------------------------------------------------------------ helpers
def load_fp(fpid):
    lib, name = fpid.split(':')
    path = os.path.join(HERE, lib + '.pretty') if lib == 'MB-2' else os.path.join(FPDIR, lib + '.pretty')
    f = pcbnew.FootprintLoad(path, name)
    if f is None:
        sys.exit(f'No footprint {fpid}')
    f.SetFPID(pcbnew.LIB_ID(lib, name))
    return f


def pad_nets(p):
    """pad number -> net for one part, from the symbol's pins."""
    out = {}
    for num, name, *_ in g.pins_of(g.flat_symbol(p['sym'])):
        net = p['pins'].get(num, p['pins'].get(name))
        if net:
            for n in num.strip('[]').split(','):
                out[n] = net
    return out


def rule_area(board, x0, y0, x1, y1, name, tracks=True, vias=True, pour=True, pads=False, fps=False):
    z = pcbnew.ZONE(board)
    z.SetIsRuleArea(True)
    z.SetZoneName(name)
    z.SetDoNotAllowTracks(tracks)
    z.SetDoNotAllowVias(vias)
    z.SetDoNotAllowZoneFills(pour)
    z.SetDoNotAllowPads(pads)
    z.SetDoNotAllowFootprints(fps)
    ls = pcbnew.LSET()
    ls.AddLayer(pcbnew.F_Cu)
    ls.AddLayer(pcbnew.B_Cu)
    z.SetLayerSet(ls)
    o = z.Outline()
    o.NewOutline()
    for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        o.Append(pt(x, y))
    board.Add(z)


def pour(board, net, layer, x0, y0, x1, y1, prio=0):
    z = pcbnew.ZONE(board)
    z.SetNet(net)
    z.SetLayer(layer)
    z.SetAssignedPriority(prio)
    z.SetLocalClearance(mm(0.3))
    z.SetMinThickness(mm(0.25))
    z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)  # no floating copper
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_THT_THERMAL)  # SMD pads solid, THT pads with reliefs
    z.SetThermalReliefGap(mm(0.3))
    z.SetThermalReliefSpokeWidth(mm(0.4))
    o = z.Outline()
    o.NewOutline()
    for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        o.Append(pt(x, y))
    board.Add(z)


def touch_class():
    """Net class for the touch traces (GPIO side TCH1-6 and terminal side TT1-6), or None for
    the Default class. Returns (clearance, track width) in mm.

    A touch input measures the capacitance of everything on its net: the pad the user touches,
    and also its own trace and whatever copper runs next to it. Wider gaps to the ground pour
    and to other tracks lower that background capacitance, so a finger makes a bigger change.
    """
    # 0.5 mm keeps the ground pour and other tracks back without starving the router between the
    # touch terminals and the DevKit; 0.35 mm track is sturdy for hand rework at little extra area.
    return (0.5, 0.35)


def write_project():
    """Net classes and design rules in the project file (no custom rules file: no mains on MB-2)."""
    pro = os.path.join(HERE, 'MB-2.kicad_pro')
    with open(pro, encoding='utf-8') as f:
        d = json.load(f)

    def cls(name, clearance, track, via_d, via_drill, prio):
        return {'name': name, 'clearance': clearance, 'track_width': track, 'via_diameter': via_d, 'via_drill': via_drill,
                'diff_pair_gap': 0.25, 'diff_pair_via_gap': 0.25, 'diff_pair_width': 0.2, 'microvia_diameter': 0.3,
                'microvia_drill': 0.1, 'bus_width': 12, 'line_style': 0, 'wire_width': 6, 'priority': prio,
                'pcb_color': 'rgba(0, 0, 0, 0.000)', 'schematic_color': 'rgba(0, 0, 0, 0.000)'}
    classes = [cls('Default', 0.2, 0.3, 0.7, 0.35, 2147483647), cls('Power', 0.2, 0.6, 0.8, 0.4, 1)]
    patterns = [{'netclass': 'Power', 'pattern': n} for n in POWER]
    tc = touch_class()
    if tc:
        classes.append(cls('Touch', tc[0], tc[1], 0.7, 0.35, 2))
        patterns += [{'netclass': 'Touch', 'pattern': n} for n in TOUCH]
    d['net_settings'] = {'classes': classes, 'meta': {'version': 4}, 'netclass_assignments': None,
                         'netclass_patterns': patterns}
    # Hand-soldered and ordered as a bare board: generous minimums every PCB fab makes.
    d.setdefault('board', {}).setdefault('design_settings', {}).setdefault('rules', {}).update(
        {'min_clearance': 0.2, 'min_track_width': 0.2, 'min_via_diameter': 0.6, 'min_through_hole_diameter': 0.3,
         'min_copper_edge_clearance': 0.5, 'min_hole_clearance': 0.25})
    with open(pro, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(d, f, indent=2)
        f.write('\n')


# Parts whose reference would sit on a printed terminal label: the reference moves to the
# fabrication layer (assembly drawing) and the label stays on the silkscreen.
LABELLED = ['J1', 'J5', 'J6', 'J7', 'J8', 'J9', 'J10', 'J11', 'J12',
            # crowded groups: the printed labels (RELAY MODULE, mA) say what they are
            'Q1', 'Q2', 'Q3', 'Q4', 'JP1', 'JP2', 'JP3', 'JP4', 'R9', 'R10', 'R11', 'R12']


def silkscreen(board):
    """Silkscreen: terminal labels and board text; part values and MPNs only on the fabrication layer.
    Runs as part of main(), and alone with --silk on a routed board (silkscreen does not affect routing)."""
    for d in list(board.GetDrawings()):
        if d.GetClass() == 'PCB_TEXT' and d.GetLayer() == pcbnew.F_SilkS:
            board.Delete(d)
    for f in board.GetFootprints():
        for fld in f.GetFields():
            if fld.IsReference():
                if f.GetReference() in LABELLED:
                    fld.SetLayer(pcbnew.F_Fab)
            elif fld.GetLayer() != pcbnew.F_Fab or fld.IsVisible():
                fld.SetLayer(pcbnew.F_Fab)
                fld.SetVisible(fld.IsValue())

    def text(s, x, y, size=1.0, rot=0):
        t = pcbnew.PCB_TEXT(board)
        t.SetText(s); t.SetPosition(pt(x, y)); t.SetLayer(pcbnew.F_SilkS)
        t.SetTextSize(pcbnew.VECTOR2I(mm(size), mm(size))); t.SetTextThickness(mm(0.15)); t.SetTextAngleDegrees(rot)
        board.Add(t)
    for ref, (x0, labs) in TERM_TOP.items():
        for i, lab in enumerate(labs):
            text(lab, x0 - 3.5 * i, 10.0, 0.8, 90)
    for ref, (x0, pitch, labs) in TERM_BOT.items():
        for i, lab in enumerate(labs):
            text(lab, x0 + pitch * i, 69.2, 0.8, 90)
    text('RELAY', 4.2, 31.6, 0.8); text('MODULE', 4.6, 33.2, 0.8)
    for i, lab in enumerate(['GND', 'IN1', 'IN2', 'IN3', 'IN4', '5V']):
        text(lab, 5.4, 36.0 + 2.54 * i, 0.8)
    text('12-24V', 12.0, 68.0, 0.8); text('GND', 17.08, 68.0, 0.8)
    text('Qwiic', 76.0, 71.0, 0.8)
    for n in range(1, 5):
        text('mA', 4.5 + 3.8 * (n - 1), 9.5, 0.8)
    text('ESP32 DevKit V1 (30 pin)', 95.0, 40.7, 1.2)
    text('antenna  >', 106.0, 43.0, 0.8)
    text('ADS1115 module', 35.5, 39.6, 0.8)
    text('MB-2 rev A  EspressOS', 60.0, 66.6, 1.2)


# ------------------------------------------------------------------ build
def main():
    write_project()
    board = pcbnew.BOARD()
    board.SetCopperLayerCount(2)
    nets = {}

    def net(name):
        if name not in nets:
            nets[name] = pcbnew.NETINFO_ITEM(board, name)
            board.Add(nets[name])
        return nets[name]

    missing = [p['ref'] for p in g.PARTS if not p['sym'].startswith('power:') and p['ref'] not in P]
    if missing:
        sys.exit(f'No position for {missing}')
    root = g.U('root')
    for p in g.PARTS:
        if p['sym'].startswith('power:'):
            continue
        fpid = p['fp'] or ''
        if not fpid:
            props = {g.uq(e[1]): e for e in g.children(g.flat_symbol(p['sym']), 'property')}
            fpid = g.uq(props['Footprint'][2])
        f = load_fp(fpid)
        f.SetReference(p['ref'])
        f.SetValue(p['value'])
        for k, v in p['fields'].items():
            f.SetField(k, v)
        f.SetPath(pcbnew.KIID_PATH('/' + root + '/' + g.U('sym:' + p['ref'])))
        f.SetSheetname('Root')
        f.SetSheetfile('MB-2.kicad_sch')
        x, y, rot = P[p['ref']]
        f.SetPosition(pt(x, y))
        f.SetOrientationDegrees(rot)
        pn = pad_nets(p)
        for pad in f.Pads():
            n = pad.GetNumber()
            if n in pn:
                pad.SetNet(net(pn[n]))
        board.Add(f)
    # ADS1115 socket pin 5 (ADDR to GND) sits between signal tracks: no room for two thermal spokes.
    board.FindFootprintByReference('J4').FindPadByNumber('5').SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)

    # Outline with 2 mm corner radius, and M3 holes
    r = 2.0
    def seg(x0, y0, x1, y1):
        s = pcbnew.PCB_SHAPE(board, pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(pt(x0, y0)); s.SetEnd(pt(x1, y1)); s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(mm(0.1))
        board.Add(s)
    def arc(cx, cy, sx, sy):
        s = pcbnew.PCB_SHAPE(board, pcbnew.SHAPE_T_ARC)
        s.SetCenter(pt(cx, cy)); s.SetStart(pt(sx, sy)); s.SetArcAngleAndEnd(pcbnew.EDA_ANGLE(90, pcbnew.DEGREES_T))
        s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(mm(0.1))
        board.Add(s)
    seg(r, 0, W - r, 0); seg(W, r, W, H - r); seg(W - r, H, r, H); seg(0, H - r, 0, r)
    arc(W - r, r, W - r, 0); arc(W - r, H - r, W, H - r); arc(r, H - r, r, H); arc(r, r, 0, r)
    for i, (x, y) in enumerate(HOLES):
        f = load_fp('MountingHole:MountingHole_3.2mm_M3')
        f.SetReference(f'H{i + 1}')
        f.SetPosition(pt(x, y))
        board.Add(f)

    # Freerouting ignores KiCad's 0.5 mm copper-to-edge rule; strips along the edges keep its tracks off.
    e = 0.5
    for i, (x0, y0, x1, y1) in enumerate(((-1, -1, W + 1, e), (-1, H - e, W + 1, H + 1), (-1, -1, e, H + 1), (W - e, -1, W + 1, H + 1))):
        rule_area(board, x0, y0, x1, y1, f'Edge {i + 1}', pour=False)
    # No copper next to the antenna end of the DevKit (its antenna reaches past the board edge).
    rule_area(board, DK_X + 2.0, 22.0, W, 60.0, 'Antenna')
    # Ground pour on both layers.
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        pour(board, net('GND'), layer, 0, 0, W, H)

    silkscreen(board)

    # Ground pads that routed tracks would fence in get a locked via before routing, so the
    # router routes around it: each relay driver's MOSFET source (via to its left, towards the
    # header) and gate pull-down (via just below its ground pad).
    gnd = net('GND')

    def fanout(ref, pad, dx, dy):
        start = board.FindFootprintByReference(ref).FindPadByNumber(pad).GetPosition()
        via_at = pcbnew.VECTOR2I(start.x + mm(dx), start.y + mm(dy))
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(start); t.SetEnd(via_at); t.SetWidth(mm(0.3)); t.SetLayer(pcbnew.F_Cu); t.SetNet(gnd); t.SetLocked(True)
        board.Add(t)
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(via_at); v.SetDrill(mm(0.35)); v.SetWidth(mm(0.7)); v.SetNet(gnd); v.SetLocked(True)
        board.Add(v)

    for n in range(1, 5):
        fanout(f'Q{n}', '2', -1.7, 0)
        fanout(f'R{26 + n}', '2', 0, 1.6)

    pcbnew.SaveBoard(PCB, board)
    print(f'{PCB}: {len(board.GetFootprints())} footprints, {board.GetNetCount()} nets')


if __name__ == '__main__':
    if '--silk' in sys.argv:  # part fields and silkscreen on the routed board, in place (no copper changes)
        b = pcbnew.LoadBoard(PCB)
        for p in g.PARTS:
            if not p['sym'].startswith('power:'):
                fp = b.FindFootprintByReference(p['ref'])
                fp.SetValue(p['value'])
                for k, v in p['fields'].items():
                    fp.SetField(k, v)
        silkscreen(b)
        pcbnew.SaveBoard(PCB, b)
        print('fields and silkscreen updated:', PCB)
    else:
        main()
