#!/usr/bin/env python3
"""Checks that KiCad reads MB-2.kicad_sch as exactly the nets in gen_schematic.py.

    kicad-cli sch export netlist --format kicadsexpr -o MB-2.net MB-2.kicad_sch
    python check_netlist.py MB-2.net

Labels and power symbols that land on the wrong pin (overlapping parts) would
short or split nets without any ERC error; this catches that.
"""
import sys

sys.argv, net_file = sys.argv[:1], sys.argv[1]
import gen_schematic as g  # noqa: E402

with open(net_file, encoding='utf-8') as f:
    tree = g.parse(f.read())

# KiCad's view: net name -> {(ref, pin)}
kicad = {}
for net in g.children(g.child(tree, 'nets'), 'net'):
    name = g.uq(g.child(net, 'name')[1]).lstrip('/')
    pins = {(g.uq(g.child(n, 'ref')[1]), g.uq(g.child(n, 'pin')[1])) for n in g.children(net, 'node')}
    kicad[name] = pins

# The design's view
want = {}
for p in g.PARTS:
    if p['sym'].startswith('power:'):
        continue
    sym = g.flat_symbol(p['sym'])
    for num, name, *_ in g.pins_of(sym):
        net = p['pins'].get(num, p['pins'].get(name))
        if net:
            for n in num.strip('[]').split(','):  # stacked pins "[1,15,38,39]"
                want.setdefault(net, set()).add((p['ref'], n))

bad = 0
by_pins = {frozenset(v): k for k, v in kicad.items()}
for net, pins in sorted(want.items()):
    got = kicad.get(net)
    if got is None:
        got = next((v for v in kicad.values() if pins <= v), None)
    if got != pins:
        bad += 1
        print(f'{net}: want {sorted(pins)}\n      got  {sorted(got) if got else None}')
connected = {k: v for k, v in kicad.items() if len(v) > 1 and not k.startswith('unconnected')}
extra = [k for k, v in connected.items() if k not in want and frozenset(v) not in {frozenset(x) for x in want.values()}]
for k in extra:
    bad += 1
    print(f'unexpected net {k}: {sorted(kicad[k])}')
print(f'{len(want)} nets checked, {bad} differ')
sys.exit(1 if bad else 0)
