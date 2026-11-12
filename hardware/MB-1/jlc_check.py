#!/usr/bin/env python3
"""Checks the JLCPCB placement file against JLCPCB's own footprints.

JLCPCB's placement preview drops its library footprint for each LCSC part (the EasyEDA one) at
the CPL position and rotation. This script does the same: for every SMD part it fetches that
footprint from EasyEDA's component API, finds the rotation and offset that put its numbered pads
on the KiCad pads, and compares them with jlcpcb/MB-1-cpl.csv. Run it after jlc.py:

    "%LOCALAPPDATA%\\Programs\\KiCad\\10.0\\bin\\python.exe" jlc_check.py

It prints one line per part and exits non-zero if any part would sit wrong (rotation off, or more
than 0.1 mm off position). The right values go into JLC_FIX in jlc.py. It also lists the pin names
of both libraries per pad, so a pinout or polarity difference shows even where the pads line up;
REMAP holds the parts whose pad numbers differ (an LED with pad 1 as anode, say).
"""
import csv
import json
import math
import os
import sys
import time
import urllib.request

import pcbnew

import gen_pcb
import gen_schematic as g

HERE = os.path.dirname(os.path.abspath(__file__))
API = 'https://easyeda.com/api/products/{}/components?version=6.4.19.5'
U = 0.254  # EasyEDA unit: 10 mil


# JLCPCB parts whose pad numbers mean something else than KiCad's: EasyEDA pad -> KiCad pad.
REMAP = {
    'C2286': {'1': '2', '2': '1'},                       # KT-0603R: pad 1 is the anode (KiCad: pad 1 cathode)
    'C2886897': {'1': '1', '2': '1', '3': '2', '4': '2'},  # TL3342: 1+2 and 3+4 are one terminal each (KiCad: 1, 1, 2, 2)
}

CACHE = os.path.join(HERE, 'jlcpcb', 'easyeda-cache.json')  # not in git; delete it to fetch again


def fetch(lcsc, cache):
    """EasyEDA's component record for one LCSC part (cached; the API rate-limits)."""
    if lcsc not in cache:
        for attempt in range(6):
            try:
                req = urllib.request.Request(API.format(lcsc), headers={'User-Agent': 'curl/8.0', 'Accept': '*/*'})
                cache[lcsc] = json.load(urllib.request.urlopen(req, timeout=30))['result']
                break
            except Exception:
                time.sleep(30)
        else:
            sys.exit(f'EasyEDA did not answer for {lcsc}; try again later')
        with open(CACHE, 'w', encoding='utf-8') as fh:
            json.dump(cache, fh)
        time.sleep(2)
    return cache[lcsc]


def easyeda_pads(r, lcsc):
    """pad number -> list of (x, y) in mm, y up, relative to the footprint origin JLCPCB places at the CPL point."""
    ds = r['packageDetail']['dataStr']
    ox, oy = float(ds['head']['x']), float(ds['head']['y'])
    pads = {}
    for s in ds['shape']:
        if s.startswith('PAD~'):
            f = s.split('~')
            pads.setdefault(f[8], []).append(((float(f[2]) - ox) * U, -(float(f[3]) - oy) * U))
    m = REMAP.get(lcsc, {})
    out = {}
    for n, p in pads.items():
        if n:
            out.setdefault(m.get(n, n), []).extend(p)
    return r['packageDetail']['title'], out


def pin_names(r):
    """EasyEDA symbol: pin number -> pin name."""
    names = {}
    for s in r['dataStr']['shape']:
        if s.startswith('P~'):
            segs = s.split('^^')
            num = segs[0].split('~')[3]
            label = [x.split('~')[4] for x in segs[1:] if x.split('~')[0] in ('0', '1') and len(x.split('~')) > 4]
            names[num] = label[0] if label else '?'
    return names


def centre(pts):
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def rot(p, deg):
    a = math.radians(deg)
    return p[0] * math.cos(a) - p[1] * math.sin(a), p[0] * math.sin(a) + p[1] * math.cos(a)


def fit(src, dst):
    """Rotation (multiple of 90) and offset that best map src pads onto dst pads, and the worst pad error.
    Pads are compared by number; a number used for a different count of pads on the two sides
    (a SOT-223 tab, say) is left out."""
    common = sorted(n for n in set(src) & set(dst) if len(src[n]) == len(dst[n]))
    src = {n: centre(src[n]) for n in common}
    dst = {n: centre(dst[n]) for n in common}
    best = None
    for deg in (0, 90, 180, 270):
        r = {n: rot(src[n], deg) for n in common}
        dx = sum(dst[n][0] - r[n][0] for n in common) / len(common)
        dy = sum(dst[n][1] - r[n][1] for n in common) / len(common)
        err = max(math.hypot(r[n][0] + dx - dst[n][0], r[n][1] + dy - dst[n][1]) for n in common)
        if best is None or err < best[3]:
            best = (deg, dx, dy, err)
    return best, len(common)


def main():
    board = pcbnew.LoadBoard(os.path.join(HERE, 'MB-1.kicad_pcb'))
    x0, y0 = pcbnew.FromMM(gen_pcb.OX), pcbnew.FromMM(gen_pcb.OY + gen_pcb.H)
    with open(os.path.join(HERE, 'jlcpcb', 'MB-1-cpl.csv'), newline='', encoding='utf-8') as fh:
        cpl = {r['Designator']: r for r in csv.DictReader(fh)}
    cache = json.load(open(CACHE, encoding='utf-8')) if os.path.exists(CACHE) else {}
    bad = 0
    for ref, row in cpl.items():
        f = board.FindFootprintByReference(ref)
        lcsc = f.GetFieldText('LCSC')
        rec = fetch(lcsc, cache)
        title, src = easyeda_pads(rec, lcsc)
        dst = {}
        for p in f.Pads():
            if p.GetNumber():
                c = p.GetPosition()
                dst.setdefault(p.GetNumber(), []).append((pcbnew.ToMM(c.x - x0), pcbnew.ToMM(y0 - c.y)))
        (deg, dx, dy, err), n = fit(src, dst)
        cx, cy, cr = float(row['Mid X'].rstrip('mm')), float(row['Mid Y'].rstrip('mm')), float(row['Rotation'])
        off = math.hypot(dx - cx, dy - cy)
        # The rotation and the centre are what the placement decides. The pad error left after the fit
        # is the difference between the two libraries' land patterns (a wider SOIC row spacing, say);
        # with the part centred, up to 0.5 mm of it stays well inside the pads.
        ok = err < 0.5 and (deg - cr) % 360 == 0 and off < 0.1
        bad += not ok
        print(f"{'ok ' if ok else 'FIX'} {ref:5} {lcsc:9} {title[:34]:34} pads {n:2}  fit {deg:3}deg err {err:.2f}  "
              f"cpl {cr:3g}deg -> need {deg:3}deg, shift {dx - cx:+.2f} {dy - cy:+.2f} mm")
    # Pin names on both sides, per KiCad pad number, for every part type: a polarity or pinout
    # difference shows here even where the pads line up.
    print()
    print('pin names, KiCad / JLCPCB (after REMAP):')
    seen = set()
    for p in g.PARTS:
        if p['ref'] not in cpl or p['fields']['LCSC'] in seen:
            continue
        lcsc = p['fields']['LCSC']
        seen.add(lcsc)
        ee = pin_names(cache[lcsc])
        inv = {}
        for n, name in ee.items():
            inv.setdefault(REMAP.get(lcsc, {}).get(n, n), []).append(name)
        kc = {}
        for num, name, *_ in g.pins_of(g.flat_symbol(p['sym'])):
            for n in num.strip('[]').split(','):
                kc.setdefault(n, []).append(name)
        pins = sorted(set(kc) | set(inv), key=lambda n: (len(n), n))
        print(f"  {p['ref']:5} {lcsc:9} " + '  '.join(f"{n}:{'/'.join(kc.get(n, ['-']))}~{'/'.join(inv.get(n, ['-']))}" for n in pins)[:200])
    print('parts to fix:', bad)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
