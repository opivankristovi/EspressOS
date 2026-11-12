#!/usr/bin/env python3
"""Writes 3d/MB-1.stl: the assembled board as one mesh, for designing an enclosure around it
(Fusion, TinkerCAD, any CAD that imports STL).

    "%LOCALAPPDATA%\\Programs\\KiCad\\10.0\\bin\\python.exe" make_3d.py

KiCad exports the board and every part that has a 3D model. A few parts have none in KiCad's
library (the USB-C socket, the G2RL relays, the 1812 PTC, the project's own G3MB footprint); for
those this script adds a solid block: the outline of the part's body from the footprint's
fabrication drawing, the height from the data sheet (maximum). That is all an enclosure needs.

Units mm. Origin at the board's lower-left corner, X along the 120 mm edge, Y along the 100 mm
edge (Y up, so the terminals for low voltage are at the top, mains at the bottom), Z up from
the bottom of the 1.6 mm board. Through-hole pins reach 2.9 mm below the board.
"""
import os
import struct
import subprocess
import sys
import tempfile

import pcbnew

import gen_pcb

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(HERE, 'MB-1.kicad_pcb')
OUT = os.path.join(HERE, '3d', 'MB-1.stl')
CLI = os.path.join(os.path.dirname(sys.executable), 'kicad-cli.exe' if os.name == 'nt' else 'kicad-cli')
MODELS = os.path.join(os.path.dirname(sys.executable), '..', 'share', 'kicad', '3dmodels')
BOARD = 1.6  # board thickness, mm

# Footprint -> body height above the board (mm, data sheet maximum), for footprints without a model.
HEIGHT = {
    'USB_C_Receptacle_HRO_TYPE-C-31-M-12': 3.3,   # HRO TYPE-C-31-M-12 shell
    'Relay_SPDT_Omron_G2RL-1': 15.7,             # Omron G2RL-1: 29 x 12.7 x 15.7
    'Omron_G3MB-202P_SIP4': 20.5,                # Omron G3MB: 24.5 x 5.5 x 20.5
    'Fuse_1812_4532Metric': 1.0,                 # Bourns MF-MSMF150
}


def has_model(f):
    for m in f.Models():
        p = m.m_Filename
        for var in ('${KICAD10_3DMODEL_DIR}', '${KICAD9_3DMODEL_DIR}', '${KICAD8_3DMODEL_DIR}'):
            p = p.replace(var, MODELS)
        if any(os.path.exists(os.path.splitext(p)[0] + ext) for ext in ('.step', '.stp', '.wrl')):
            return True
    return False


def body_outline(f):
    """Bounding box of the footprint's F.Fab drawing (its body), in board mm (y down)."""
    box = None
    for it in f.GraphicalItems():
        if it.GetLayer() == pcbnew.F_Fab and it.GetClass() != 'PCB_TEXT':
            bb = it.GetBoundingBox()
            if box is None:
                box = bb
            else:
                box.Merge(bb)
    if box is None:
        box = f.GetCourtyard(pcbnew.F_CrtYd).BBox()
    t = pcbnew.ToMM
    return t(box.GetX()), t(box.GetY()), t(box.GetRight()), t(box.GetBottom())


def block(x0, y0, x1, y1, z0, z1):
    """12 triangles of a box, outward normals."""
    v = [(x, y, z) for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)]
    quads = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    tris = []
    for a, b, c, d in quads:
        tris += [(v[a], v[b], v[c]), (v[a], v[c], v[d])]
    return tris


def normal(t):
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = t
    ux, uy, uz, wx, wy, wz = bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az
    n = (uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx)
    m = sum(c * c for c in n) ** 0.5 or 1.0
    return tuple(c / m for c in n)


def read_ascii_stl(path):
    tris, cur = [], []
    with open(path) as fh:
        for line in fh:
            w = line.split()
            if w and w[0] == 'vertex':
                cur.append(tuple(float(c) for c in w[1:4]))
                if len(cur) == 3:
                    tris.append(tuple(cur))
                    cur = []
    return tris


def main():
    board = pcbnew.LoadBoard(PCB)
    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, 'board.stl')
        subprocess.run([CLI, 'pcb', 'export', 'stl', '-f', '--subst-models',
                        '--user-origin', f'{gen_pcb.OX}x{gen_pcb.OY + gen_pcb.H}mm', '-o', raw, PCB],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        tris = read_ascii_stl(raw)
    added = []
    for f in board.GetFootprints():
        name = f.GetFPID().GetLibItemName().wx_str()
        if has_model(f) or name not in HEIGHT:
            continue
        x0, y0, x1, y1 = body_outline(f)
        X = lambda x: x - gen_pcb.OX
        Y = lambda y: gen_pcb.OY + gen_pcb.H - y
        tris += block(X(x0), Y(y1), X(x1), Y(y0), BOARD, BOARD + HEIGHT[name])
        added.append(f'{f.GetReference()} {x1 - x0:.1f} x {y1 - y0:.1f} x {HEIGHT[name]} mm')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'wb') as fh:
        fh.write(b'MB-1 rev A, EspressOS. mm, origin board lower-left, Z up from board bottom'.ljust(80, b' '))
        fh.write(struct.pack('<I', len(tris)))
        for t in tris:
            fh.write(struct.pack('<12fH', *normal(t), *t[0], *t[1], *t[2], 0))
    lo = [min(p[k] for t in tris for p in t) for k in range(3)]
    hi = [max(p[k] for t in tris for p in t) for k in range(3)]
    print(f'{OUT}: {len(tris)} triangles, {os.path.getsize(OUT) / 1e6:.1f} MB')
    print('extent mm: ' + '  '.join(f'{a} {l:.1f}..{h:.1f}' for a, l, h in zip('XYZ', lo, hi)))
    print('blocks added for parts without a model:\n  ' + '\n  '.join(added))


if __name__ == '__main__':
    main()
