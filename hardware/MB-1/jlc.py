#!/usr/bin/env python3
"""Writes the JLCPCB assembly files for MB-1 from the routed board:

    jlcpcb/MB-1-gerbers.zip  Gerbers (Protel names) and Excellon drill files, for the PCB order
    jlcpcb/MB-1-bom.csv      Comment, Designator, Footprint, LCSC Part #
    jlcpcb/MB-1-cpl.csv      Designator, Mid X, Mid Y, Layer, Rotation

Run it with KiCad's Python:
    "%LOCALAPPDATA%\\Programs\\KiCad\\10.0\\bin\\python.exe" jlc.py

Only SMD parts go in: JLCPCB places those. The through-hole parts (terminals, relays, SSRs,
fuse sockets) are soldered by hand. Positions are in mm from the board's lower-left corner,
Y up. JLCPCB places its own library footprint for each part, whose zero rotation and origin
differ from KiCad's for some packages; JLC_FIX corrects those, and jlc_check.py verifies the
result against JLCPCB's footprints.
"""
import csv
import math
import glob
import os
import shutil
import subprocess
import sys
import zipfile
from collections import defaultdict

import pcbnew

import gen_pcb  # board origin and size (OX, OY, H)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'jlcpcb')
PCB = os.path.join(HERE, 'MB-1.kicad_pcb')
CLI = os.path.join(os.path.dirname(sys.executable), 'kicad-cli.exe' if os.name == 'nt' else 'kicad-cli')
LAYERS = 'F.Cu,B.Cu,F.Paste,B.Paste,F.Silkscreen,B.Silkscreen,F.Mask,B.Mask,Edge.Cuts'


# LCSC part -> (degrees to add, origin offset x, y in mm in the footprint's own frame, y up).
# Found with jlc_check.py, which fits JLCPCB's footprint onto the KiCad pads.
JLC_FIX = {
    'C20526': (180, 0, 0),     # MMBT3904, SOT-23
    'C20917': (180, 0, 0),     # AO3400A, SOT-23
    'C47546': (180, 0, 0),     # BAT54S, SOT-23
    'C84681': (270, 0, 0),     # CH340C, SOIC-16
    'C7519': (270, 0, 0),      # USBLC6-2SC6, SOT-23-6
    'C138714': (270, 0, 0),    # TPD4E05U06, USON-10
    'C500795': (180, -0.29, 0),  # AP7361C, SOT-223: JLCPCB's origin is the body centre
    'C701341': (270, 0, -3.68),  # ESP32-WROOM-32E: KiCad's origin is not the module centre
    'C165948': (0, 0, 1.57),   # USB-C HRO TYPE-C-31-M-12: origin offset
    'C2886897': (180, 0, 0),   # TL3342: symmetric; 180 keeps JLCPCB's pad 1 on KiCad's pad 1
}


def gerbers():
    """Gerbers and drill files the way JLCPCB's KiCad guide asks, zipped."""
    tmp = os.path.join(OUT, 'gerbers')
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    subprocess.run([CLI, 'pcb', 'export', 'gerbers', '-o', tmp, '-l', LAYERS, '--subtract-soldermask',
                    '--check-zones', PCB], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([CLI, 'pcb', 'export', 'drill', '-o', tmp + os.sep, '--format', 'excellon', '-u', 'mm',
                    '--excellon-zeros-format', 'decimal', '--excellon-oval-format', 'alternate',
                    '--excellon-separate-th', PCB], check=True, stdout=subprocess.DEVNULL)
    files = sorted(glob.glob(os.path.join(tmp, '*')))
    with zipfile.ZipFile(os.path.join(OUT, 'MB-1-gerbers.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(f, os.path.basename(f))
    shutil.rmtree(tmp)
    return [os.path.basename(f) for f in files]


def natural(ref):
    head = ref.rstrip('0123456789')
    return head, int(ref[len(head):] or 0)


def main():
    board = pcbnew.LoadBoard(PCB)
    x0, y0 = pcbnew.FromMM(gen_pcb.OX), pcbnew.FromMM(gen_pcb.OY + gen_pcb.H)  # lower-left corner
    lines, cpl = defaultdict(list), []
    for f in sorted(board.GetFootprints(), key=lambda f: natural(f.GetReference())):
        if not f.GetAttributes() & pcbnew.FP_SMD:
            continue
        ref, lcsc = f.GetReference(), f.GetFieldText('LCSC') if f.HasField('LCSC') else ''
        if not lcsc:
            raise SystemExit(f'{ref} has no LCSC number')
        lines[(f.GetValue(), f.GetFPID().GetLibItemName().wx_str(), lcsc)].append(ref)
        c, r = f.GetPosition(), f.GetOrientationDegrees()
        add, dx, dy = JLC_FIX.get(lcsc, (0, 0, 0))
        a = math.radians(r)
        x = pcbnew.ToMM(c.x - x0) + dx * math.cos(a) - dy * math.sin(a)
        y = pcbnew.ToMM(y0 - c.y) + dx * math.sin(a) + dy * math.cos(a)
        cpl.append([ref, f'{x:.3f}mm', f'{y:.3f}mm', 'Top' if f.GetLayer() == pcbnew.F_Cu else 'Bottom',
                    f'{(r + add) % 360:g}'])
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
    print('gerbers:', ' '.join(gerbers()))


if __name__ == '__main__':
    main()
