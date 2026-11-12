#!/usr/bin/env python3
"""Writes fab/MB-2-gerbers.zip: Gerbers and drill files for ordering the bare board.

    "%LOCALAPPDATA%\\Programs\\KiCad\\10.0\\bin\\python.exe" gerbers.py

MB-2 is hand-soldered, so unlike MB-1 there is no assembly BOM or placement file: upload the
zip at any PCB fab (JLCPCB, PCBWay, Aisler, ...) as a 2-layer, 1.6 mm, 120 x 80 mm board.
The layer set and drill options follow JLCPCB's KiCad guide, which other fabs also read:
Protel file extensions, silkscreen clipped at the solder-mask openings, Excellon drill in mm
with plated and non-plated holes in separate files.
"""
import glob
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(HERE, 'MB-2.kicad_pcb')
OUT = os.path.join(HERE, 'fab')
CLI = os.path.join(os.path.dirname(sys.executable), 'kicad-cli.exe' if os.name == 'nt' else 'kicad-cli')
LAYERS = 'F.Cu,B.Cu,F.Paste,B.Paste,F.Silkscreen,B.Silkscreen,F.Mask,B.Mask,Edge.Cuts'


def main():
    tmp = os.path.join(OUT, 'gerbers')
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    subprocess.run([CLI, 'pcb', 'export', 'gerbers', '-o', tmp, '-l', LAYERS, '--subtract-soldermask',
                    '--check-zones', PCB], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([CLI, 'pcb', 'export', 'drill', '-o', tmp + os.sep, '--format', 'excellon', '-u', 'mm',
                    '--excellon-zeros-format', 'decimal', '--excellon-oval-format', 'alternate',
                    '--excellon-separate-th', PCB], check=True, stdout=subprocess.DEVNULL)
    files = sorted(glob.glob(os.path.join(tmp, '*')))
    zpath = os.path.join(OUT, 'MB-2-gerbers.zip')
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(f, os.path.basename(f))
    shutil.rmtree(tmp)
    print(zpath + ':', ' '.join(os.path.basename(f) for f in files))


if __name__ == '__main__':
    main()
