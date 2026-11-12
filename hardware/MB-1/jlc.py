#!/usr/bin/env python3
"""Writes the JLCPCB assembly files for MB-1 from the routed board:

    jlcpcb/MB-1-bom.csv   Comment, Designator, Footprint, LCSC Part #
    jlcpcb/MB-1-cpl.csv   Designator, Mid X, Mid Y, Layer, Rotation

Run it with KiCad's Python:
    "%LOCALAPPDATA%\\Programs\\KiCad\\10.0\\bin\\python.exe" jlc.py

Only SMD parts go in: JLCPCB places those. The through-hole parts (terminals, relays, SSRs,
fuse sockets) are soldered by hand. Positions are in mm from the board's lower-left corner,
Y up. Rotations are KiCad's; JLCPCB's own library sometimes rotates a part differently, so
check every part in the placement preview after uploading and turn it there if needed.
"""
import csv
import os
from collections import defaultdict

import pcbnew

import gen_pcb  # board origin and size (OX, OY, H)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'jlcpcb')


def natural(ref):
    head = ref.rstrip('0123456789')
    return head, int(ref[len(head):] or 0)


def main():
    board = pcbnew.LoadBoard(os.path.join(HERE, 'MB-1.kicad_pcb'))
    x0, y0 = pcbnew.FromMM(gen_pcb.OX), pcbnew.FromMM(gen_pcb.OY + gen_pcb.H)  # lower-left corner
    lines, cpl = defaultdict(list), []
    for f in sorted(board.GetFootprints(), key=lambda f: natural(f.GetReference())):
        if not f.GetAttributes() & pcbnew.FP_SMD:
            continue
        ref, lcsc = f.GetReference(), f.GetFieldText('LCSC') if f.HasField('LCSC') else ''
        if not lcsc:
            raise SystemExit(f'{ref} has no LCSC number')
        lines[(f.GetValue(), f.GetFPID().GetLibItemName().wx_str(), lcsc)].append(ref)
        c = f.GetPosition()
        cpl.append([ref, f'{pcbnew.ToMM(c.x - x0):.3f}mm', f'{pcbnew.ToMM(y0 - c.y):.3f}mm',
                    'Top' if f.GetLayer() == pcbnew.F_Cu else 'Bottom', f'{f.GetOrientationDegrees() % 360:g}'])
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, 'MB-1-bom.csv'), 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['Comment', 'Designator', 'Footprint', 'LCSC Part #'])
        for (value, fp, lcsc), refs in sorted(lines.items(), key=lambda kv: natural(kv[1][0])):
            w.writerow([value, ','.join(refs), fp, lcsc])
    with open(os.path.join(OUT, 'MB-1-cpl.csv'), 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'])
        w.writerows(cpl)
    print(f'{len(lines)} BOM lines, {len(cpl)} placed parts -> {OUT}')


if __name__ == '__main__':
    main()
