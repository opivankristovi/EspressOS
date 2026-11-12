#!/usr/bin/env python3
"""Generates MB-1.kicad_pcb: board outline, placement, rules and zones (no tracks).

Run it with KiCad's own Python, which has the pcbnew module:
    "%LOCALAPPDATA%\\Programs\\KiCad\\10.0\\bin\\python.exe" gen_pcb.py
Then route.py routes it with Freerouting. Parts and nets come from
gen_schematic.py, so the board always matches the schematic; footprints
keep the symbol ids, so KiCad's "Update PCB from schematic" sees no change.

Layout (top view, 120 x 100 mm, all parts on top):
  top edge     low-voltage terminals: AI (J6), IO (J7), 1-Wire (J8), I2C (J9), Qwiic (J5)
  left edge    USB-C, RESET and BOOT buttons
  right edge   ESP32 module, antenna at the board edge with no copper under it
  middle       analog dividers, IO protection, USB-serial, 3.3 V regulator, output drivers
  y 65.6-71.6  keep-out band: nothing crosses it, so mains copper stays 6 mm from low voltage
  bottom       relays K1/K2, SSRs K3/K4, fuses, mains terminals J2-J4 at the bottom edge
"""
import json
import os
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_schematic as g  # noqa: E402  (parts, nets, symbol pins)

PCB = os.path.join(HERE, 'MB-1.kicad_pcb')
FPDIR = os.path.join(g.SHARE, 'footprints')
W, H = 120.0, 100.0
OX, OY = 100.0, 50.0  # board origin on the sheet (mm)
BAND = (65.6, 71.6)   # keep-out band between low voltage (above) and mains (below)

MAINS = ['R1_COM', 'R1_NO', 'R1_NC', 'R2_COM', 'R2_NO', 'R2_NC', 'SSR_L', 'R3_LF', 'R4_LF', 'R3_LOAD', 'R4_LOAD']
POWER = ['GND', '+5V', '+3V3', 'VBUS_IN', '3V3_OUT', 'DRV1', 'DRV2', 'DRV3', 'DRV4']


def mm(v): return pcbnew.FromMM(v)
def pt(x, y): return pcbnew.VECTOR2I(mm(OX + x), mm(OY + y))


# ------------------------------------------------------------------ placement
# ref: (x, y, rotation in degrees); coordinates are board-local mm, origin top-left.
P = {}

# Top edge terminals, rotated 180 so the wire entries face out (pin 1 is the rightmost pad).
# The ESP32 antenna keep-out covers x >= 113 down to y 60, so nothing goes there.
P['J9'] = (20.8, 5.5, 180)   # 3V3, SDA, SCL, GND: pads 20.8 .. 10.3
P['J8'] = (33.3, 5.5, 180)   # 3V3, DQ, GND: pads 33.3 .. 26.3
P['J6'] = (62.8, 5.5, 180)   # AI1..AI6, GND, GND: pads 62.8 .. 38.3
P['J7'] = (92.3, 5.5, 180)   # IO1..IO6, 3V3, GND: pads 92.3 .. 67.8
P['J5'] = (101.0, 4.0, 180)  # Qwiic, opening to the top edge
TERM = {'J9': (20.8, ['3V3', 'SDA', 'SCL', 'GND']), 'J8': (33.3, ['3V3', 'DQ', 'GND']),
        'J6': (62.8, ['AI1', 'AI2', 'AI3', 'AI4', 'AI5', 'AI6', 'GND', 'GND']),
        'J7': (92.3, ['IO1', 'IO2', 'IO3', 'IO4', 'IO5', 'IO6', '3V3', 'GND'])}

# Buses
P['R8'] = (17.3, 13.0, 90)   # SDA pull-up
P['R9'] = (13.8, 13.0, 90)   # SCL pull-up
P['R10'] = (29.8, 13.0, 90)  # DQ pull-up
P['D3'] = (33.3, 13.0, 90)   # DQ ESD
P['F2'] = (24.0, 18.0, 0)    # 3V3 out PTC

# Analog chains, one column per input under its terminal pad.
for n in range(1, 7):
    x = 62.8 - 3.5 * (n - 1)
    P[f'R{22 + n}'] = (x, 13.0, 90)   # 30k
    P[f'R{28 + n}'] = (x, 17.5, 90)   # 10k
    P[f'C{10 + n}'] = (x, 22.0, 90)   # 100n
    P[f'D{5 + n}'] = (x, 27.0 if n % 2 else 31.5, 0)  # BAT54S, staggered

# GPIO series resistors under their pads, ESD next to them.
for n in range(1, 7):
    P[f'R{34 + n}'] = (92.3 - 3.5 * (n - 1), 13.0, 90)
P['U5'] = (86.0, 19.5, 0)
P['U6'] = (77.0, 19.5, 0)

# ESP32: antenna at the right board edge (module body from x 93.7 to 119.2).
P['U1'] = (W - 12.75, 36.0, 270)
P['C8'] = (90.0, 30.0, 90)
P['C9'] = (90.0, 33.5, 90)
P['C10'] = (90.0, 42.0, 90)
P['R6'] = (86.0, 37.0, 90)    # EN pull-up
P['C7'] = (86.0, 41.0, 90)    # EN delay
P['R7'] = (86.0, 45.0, 90)    # IO0 pull-up

# USB-C, protection and power on the left.
P['J1'] = (4.4, 30.0, 270)    # opening to the left edge
P['U4'] = (12.0, 30.0, 0)
P['R1'] = (13.0, 24.0, 0)
P['R2'] = (13.0, 36.0, 0)
P['F1'] = (18.0, 23.0, 90)
P['D1'] = (18.5, 31.0, 90)
P['C1'] = (21.0, 40.5, 0)
P['C2'] = (13.0, 41.5, 90)
P['C3'] = (25.0, 26.0, 90)
P['U2'] = (30.5, 32.0, 0)     # 3.3 V LDO
P['C4'] = (37.0, 29.0, 90)
P['C5'] = (37.0, 33.0, 90)
P['R3'] = (30.0, 39.5, 0)
P['LED1'] = (34.5, 39.5, 0)
P['SW1'] = (5.0, 44.0, 0)     # RESET, at the left edge
P['SW2'] = (5.0, 52.5, 0)     # BOOT

# USB-serial and auto-reset.
P['U3'] = (52.0, 44.0, 0)
P['C6'] = (46.0, 40.0, 90)
P['Q1'] = (60.0, 40.0, 0)
P['Q2'] = (60.0, 45.5, 0)
P['R4'] = (64.0, 40.0, 90)
P['R5'] = (64.0, 45.5, 90)

# Output drivers, a group each above its relay or SSR.
DRV_X = {1: 14.0, 2: 33.0, 3: 63.0, 4: 71.0}
for n, x in DRV_X.items():
    P[f'Q{n + 2}'] = (x, 51.0, 0)          # AO3400A
    P[f'R{18 + n}'] = (x + 3.0, 51.0, 90)  # LED 1k
    P[f'R{10 + n}'] = (x - 3.0, 55.0, 90)  # gate 100R
    P[f'R{14 + n}'] = (x, 55.0, 90)        # gate pull-down 100k
    P[f'LED{n + 1}'] = (x + 3.0, 55.0, 90)
P['D4'] = (24.0, 52.0, 90)   # flyback K1
P['D5'] = (40.5, 52.0, 90)   # flyback K2

# Mains: relays (coil up, contacts down), SSRs (input up, load down), fuses, terminals.
P['K1'] = (12.0, 60.0, 0)    # A1 (12,60) A2 (19.5,60); NC (12,76.5) COM (19.5,80) NO (12,83.5)
P['K2'] = (31.0, 60.0, 0)
P['K3'] = (66.0, 82.0, 90)   # pin1 (50,82), pin2 74.38, pin3 + 64.22, pin4 - 61.68
P['K4'] = (74.0, 82.0, 90)
P['F3'] = (106.0, 76.0, 180)  # pad 1 (SSR L in) on the right
P['F4'] = (106.0, 86.0, 180)
P['J2'] = (12.0, 94.5, 0)    # R1 COM, NO, NC
P['J3'] = (31.0, 94.5, 0)    # R2 COM, NO, NC
P['J4'] = (84.0, 94.5, 0)    # SSR L in, R3 load, R4 load

HOLES = [(3.5, 3.5), (116.5, 3.5), (3.5, 96.5), (116.5, 96.5), (62.0, 96.5)]


# ------------------------------------------------------------------ helpers
def load_fp(fpid):
    lib, name = fpid.split(':')
    path = os.path.join(HERE, lib + '.pretty') if lib == 'MB-1' else os.path.join(FPDIR, lib + '.pretty')
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


def write_project():
    """Net classes in the project file, the mains rule in MB-1.kicad_dru."""
    pro = os.path.join(HERE, 'MB-1.kicad_pro')
    with open(pro, encoding='utf-8') as f:
        d = json.load(f)

    def cls(name, clearance, track, via_d, via_drill, prio):
        return {'name': name, 'clearance': clearance, 'track_width': track, 'via_diameter': via_d, 'via_drill': via_drill,
                'diff_pair_gap': 0.25, 'diff_pair_via_gap': 0.25, 'diff_pair_width': 0.2, 'microvia_diameter': 0.3,
                'microvia_drill': 0.1, 'bus_width': 12, 'line_style': 0, 'wire_width': 6, 'priority': prio,
                'pcb_color': 'rgba(0, 0, 0, 0.000)', 'schematic_color': 'rgba(0, 0, 0, 0.000)'}
    d['net_settings'] = {
        'classes': [cls('Default', 0.2, 0.25, 0.6, 0.3, 2147483647), cls('Power', 0.2, 0.6, 0.8, 0.4, 1),
                    cls('Mains', 2.0, 2.0, 2.4, 1.2, 0)],
        'meta': {'version': 4},
        'netclass_assignments': None,
        'netclass_patterns': [{'netclass': 'Mains', 'pattern': n} for n in MAINS] +
                             [{'netclass': 'Power', 'pattern': n} for n in POWER],
    }
    d.setdefault('board', {}).setdefault('design_settings', {}).setdefault('rules', {}).update(
        {'min_clearance': 0.2, 'min_track_width': 0.127, 'min_via_diameter': 0.5, 'min_through_hole_diameter': 0.2,
         'min_copper_edge_clearance': 0.5, 'min_hole_clearance': 0.25})
    with open(pro, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(d, f, indent=2)
        f.write('\n')
    with open(os.path.join(HERE, 'MB-1.kicad_dru'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('''(version 1)

# Mains copper keeps 6 mm from low-voltage copper (reinforced insulation, 230 V).
(rule "Mains to low voltage"
  (constraint clearance (min 6mm))
  (condition "A.NetClass == 'Mains' && B.NetClass != 'Mains' && B.Type != 'Hole'"))

# Different mains circuits (functional insulation).
(rule "Mains to mains"
  (constraint clearance (min 2.0mm))
  (condition "A.NetClass == 'Mains' && B.NetClass == 'Mains'"))

# Inside one SSR or relay the part's own pin spacing applies.
(rule "Inside SSR and relay"
  (constraint clearance (min 1.5mm))
  (condition "A.NetClass == 'Mains' && B.NetClass == 'Mains' && A.memberOfFootprint('K*') && B.memberOfFootprint('K*')"))

# Mounting screws: 6 mm from mains copper.
(rule "Mains to holes"
  (constraint hole_clearance (min 6mm))
  (condition "A.NetClass == 'Mains' && B.Type == 'Hole' && B.Pad_Type == 'NPTH, mechanical'"))
''')


# Parts whose reference would sit on a printed terminal or button label: the reference moves to
# the fabrication layer (assembly drawing) and the label stays on the silkscreen.
LABELLED = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8', 'J9', 'SW1', 'SW2']


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
    for ref, (x0, labs) in TERM.items():
        for i, lab in enumerate(labs):
            text(lab, x0 - 3.5 * i, 10.6, 0.8, 90)
    for x0, labs in ((12.0, ['COM', 'NO', 'NC']), (31.0, ['COM', 'NO', 'NC']), (84.0, ['L', 'R3', 'R4'])):
        for i, lab in enumerate(labs):
            text(lab, x0 + 5.08 * i, 88.0, 1.0)
    text('R1', 7.0, 88.0, 1.2); text('R2', 26.4, 88.0, 1.2)
    text('R3/R4 SSR', 89.0, 77.0, 1.2); text('2 A AC only', 89.0, 79.0, 1.0)
    text('MAINS 230 V', 51.0, 78.0, 1.5)
    text('MB-1 rev A  EspressOS', 99.0, 63.0, 1.2)
    text('USB', 4.5, 22.5, 1.0); text('RESET', 5.0, 40.0, 0.8); text('BOOT', 5.0, 48.5, 0.8)


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
        f.SetSheetfile('MB-1.kicad_sch')
        x, y, rot = P[p['ref']]
        f.SetPosition(pt(x, y))
        f.SetOrientationDegrees(rot)
        pn = pad_nets(p)
        for pad in f.Pads():
            n = pad.GetNumber()
            if n in pn:
                pad.SetNet(net(pn[n]))
            elif p['ref'] == 'J1' and n.startswith('S'):
                pad.SetNet(net('GND'))  # USB-C shield
                pad.SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)  # no room for thermal spokes at the edge
        board.Add(f)

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

    # Keep-out band between low voltage and mains, and under the ESP32 antenna.
    rule_area(board, 0, BAND[0], W, BAND[1], 'Mains separation')
    # Freerouting ignores KiCad's 0.5 mm copper-to-edge rule; strips along the edges keep its tracks off.
    e = 0.5
    for i, (x0, y0, x1, y1) in enumerate(((-1, -1, W + 1, e), (-1, H - e, W + 1, H + 1), (-1, -1, e, H + 1), (W - e, -1, W + 1, H + 1))):
        rule_area(board, x0, y0, x1, y1, f'Edge {i + 1}', pour=False)
    # (the ESP32 footprint brings its own antenna keep-out)
    # Ground pour on both layers, low-voltage area only.
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        pour(board, net('GND'), layer, 0, 0, W, BAND[0])

    silkscreen(board)

    # Ground pads that routed tracks would fence in get a locked via before routing, so the router
    # routes around it. Each entry: footprint, pad to start from, via offset (mm), pads bridged on the way.
    gnd = net('GND')

    def fanout(ref, pad, dx, dy, bridge=(), also=()):
        """Via at (dx, dy) mm from the pad; bridge: pads of the same part chained in before it;
        also: (ref, pad) of other parts that get their own track to the via."""
        f = board.FindFootprintByReference(ref)
        start = f.FindPadByNumber(pad).GetPosition()
        via_at = pcbnew.VECTOR2I(start.x + mm(dx), start.y + mm(dy))
        pts = [f.FindPadByNumber(b).GetPosition() for b in bridge] + [start, via_at]
        segs = list(zip(pts, pts[1:]))
        segs += [(board.FindFootprintByReference(r).FindPadByNumber(p).GetPosition(), via_at) for r, p in also]
        for a, b in segs:
            t = pcbnew.PCB_TRACK(board)
            t.SetStart(a); t.SetEnd(b); t.SetWidth(mm(0.25)); t.SetLayer(pcbnew.F_Cu); t.SetNet(gnd); t.SetLocked(True)
            board.Add(t)
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(via_at); v.SetDrill(mm(0.3)); v.SetWidth(mm(0.6)); v.SetNet(gnd); v.SetLocked(True)
        board.Add(v)

    # TPD4E05U06 (USON-10): its two GND pads (3, 8) face each other under the package. Bridge them
    # and take ground down with a via past the free NC pads on the right, as TI's layout does.
    for ref in ('U5', 'U6'):
        fanout(ref, '8', 1.3, 0, bridge=('3',))
    # USBLC6 (U4): its GND pad 2 sits between the D+ and D- pads.
    fanout('U4', '2', -1.2, 0)
    # AI filter caps: ground pad straight to the plane, beside the cap in the gap between columns.
    for n in range(1, 7):
        fanout(f'C{10 + n}', '2', 1.2, 0)
    # Output drivers: MOSFET source and gate pull-down share one via between their ground pads.
    for n in range(1, 5):
        q = board.FindFootprintByReference(f'Q{n + 2}').FindPadByNumber('2').GetPosition()
        r = board.FindFootprintByReference(f'R{14 + n}').FindPadByNumber('2').GetPosition()
        fanout(f'Q{n + 2}', '2', pcbnew.ToMM((r.x - q.x) // 2), pcbnew.ToMM((r.y - q.y) // 2), also=((f'R{14 + n}', '2'),))

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
