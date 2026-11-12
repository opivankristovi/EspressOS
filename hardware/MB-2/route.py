#!/usr/bin/env python3
"""Routes MB-2.kicad_pcb with Freerouting, then fills the zones.

    "%LOCALAPPDATA%\\Programs\\KiCad\\10.0\\bin\\python.exe" route.py [freerouting-2.5.0.jar] [java.exe]

Steps: export Specctra DSN from KiCad, run Freerouting on it, import the
session (tracks and vias) back, fill the ground pours, save. The keep-out band
in gen_pcb.py stops any track crossing between the mains and low-voltage areas;
the net classes give mains tracks 2 mm width and 2 mm spacing. Check the result
with  kicad-cli pcb drc MB-2.kicad_pcb  (the 6 mm mains rule lives in MB-2.kicad_dru).

Uses the Freerouting jar on Java 25 (Microsoft OpenJDK): the native freerouting-cli 2.5.0 build
crashes in its routing loop and then hangs. Freerouting's log: MB-2.route.log.
"""
import glob
import math
import os
import re
import subprocess
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(HERE, 'MB-2.kicad_pcb')
DSN = os.path.join(HERE, 'MB-2.dsn')
SES = os.path.join(HERE, 'MB-2.ses')
LOG = os.path.join(HERE, 'MB-2.route.log')
ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
FR = ARGS[0] if ARGS else os.path.expandvars(r'%LOCALAPPDATA%\freerouting\freerouting-2.5.0.jar')
JAVA = ARGS[1] if len(ARGS) > 1 else (sorted(glob.glob(r'C:\Program Files\Microsoft\jdk-2[5-9]*\bin\java.exe')) or ['java'])[-1]

MM = pcbnew.FromMM


def margin(board, d):
    """Freerouting rounds clearances down by a few tenths of a micron; route with a small margin."""
    ns = board.GetDesignSettings().m_NetSettings
    for nc in [ns.GetDefaultNetclass()] + list(ns.GetNetclasses().values()):
        nc.SetClearance(nc.GetClearance() + MM(d))


def route(board, clearance_margin=0.01):
    """Freerouting: DSN out, SES back in. Ground is a plane net (its pads reach the pours by vias).
    Returns the number of connections Freerouting left unrouted."""
    margin(board, clearance_margin)
    ok = pcbnew.ExportSpecctraDSN(board, DSN)
    margin(board, -clearance_margin)
    if not ok:
        sys.exit('DSN export failed')
    with open(LOG, 'w', encoding='utf-8') as log:
        try:
            r = subprocess.run([JAVA, '-jar', FR, '-de', DSN, '-do', SES, '-mp', '100', '--gui.enabled=false'],
                               stdout=log, stderr=subprocess.STDOUT, text=True, timeout=1800)
        except subprocess.TimeoutExpired:
            sys.exit('Freerouting took more than 30 minutes; see ' + LOG)
    if r.returncode or not os.path.exists(SES):
        sys.exit('Freerouting failed; see ' + LOG)
    if not pcbnew.ImportSpecctraSES(board, SES):
        sys.exit('SES import failed')
    for f in (DSN, SES):
        os.remove(f)
    done = [l for l in open(LOG, encoding='utf-8', errors='replace') if 'Auto-routing stage completed' in l]
    m = re.search(r'\((\d+) unrouted', done[-1]) if done else None
    return int(m.group(1)) if m else 0


def ring(x, y, r):
    d = r * 7 // 10
    return [pcbnew.VECTOR2I(x + dx, y + dy) for dx, dy in ((0, 0), (r, 0), (-r, 0), (0, r), (0, -r), (d, d), (-d, d), (d, -d), (-d, -d))]


def add_via(board, net, x, y, size=0.6, drill=0.3):
    v = pcbnew.PCB_VIA(board)
    v.SetPosition(pcbnew.VECTOR2I(x, y))
    v.SetDrill(MM(drill))
    v.SetWidth(MM(size))
    v.SetNet(net)
    board.Add(v)


def gnd_fills(board):
    """The ground net and its pour fills, one (layer, polygon set) per pour."""
    gnd = board.FindNet('GND')
    return gnd, [(z.GetLayer(), z.GetFilledPolysList(z.GetLayer())) for z in board.Zones()
                 if not z.GetIsRuleArea() and z.GetNetCode() == gnd.GetNetCode()]


def fits(fills, x, y, r):
    """A via of radius r at (x, y) lies inside the ground fill on every layer."""
    return all(f.Contains(p) for _, f in fills for p in ring(x, y, r))


def holes(board):
    """Centres and radii of every drilled hole: vias and through-hole pads."""
    out = [(v.GetPosition(), v.GetDrill() // 2) for v in board.GetTracks() if v.GetClass() == 'PCB_VIA']
    out += [(p.GetPosition(), max(p.GetDrillSize().x, p.GetDrillSize().y) // 2) for p in board.GetPads() if p.GetDrillSize().x]
    return out


def clear_of_holes(hs, x, y, drill=0.3, gap=0.5):
    """A new via's hole keeps gap (edge to edge) from every existing hole."""
    return all(math.hypot(c.x - x, c.y - y) >= r + MM(drill / 2 + gap) for c, r in hs)


def stitch(board, pitch=4.0):
    """Ground vias on a grid wherever both ground pours have room for one."""
    gnd, fills = gnd_fills(board)
    r, step, box, added = MM(0.35), MM(pitch), board.GetBoardEdgesBoundingBox(), 0
    hs = holes(board)
    for y in range(box.GetY() + step // 2, box.GetBottom(), step):
        for x in range(box.GetX() + step // 2, box.GetRight(), step):
            if clear_of_holes(hs, x, y) and fits(fills, x, y, r):
                add_via(board, gnd, x, y)
                hs.append((pcbnew.VECTOR2I(x, y), MM(0.15)))
                added += 1
    return added


def piece_at(f, p):
    """Index of the fill piece (outline minus its holes) that holds point p, or None."""
    for i in range(f.OutlineCount()):
        if f.Outline(i).PointInside(p) and not any(f.Hole(i, j).PointInside(p) for j in range(f.HoleCount(i))):
            return i
    return None


def join_islands(board):
    """Ground pour pieces form groups through vias and through-hole ground pads. Every group that is
    not the main ground gets a via down to a main-ground piece on the other layer."""
    gnd, fills = gnd_fills(board)
    parent = {}

    def find(k):
        while parent.setdefault(k, k) != k:
            k = parent[k]
        return k

    def union(keys):
        keys = [find(k) for k in keys]
        for k in keys[1:]:
            parent[k] = keys[0]

    for li, (_, f) in enumerate(fills):
        for i in range(f.OutlineCount()):
            find((li, i))
    for v in board.GetTracks():
        if v.GetClass() == 'PCB_VIA' and v.GetNetCode() == gnd.GetNetCode():
            union([(li, i) for li, (_, f) in enumerate(fills) for i in [piece_at(f, v.GetPosition())] if i is not None])
    for p in board.GetPads():
        if p.GetNetCode() == gnd.GetNetCode() and p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
            c, r = p.GetPosition(), max(p.GetSize().x, p.GetSize().y) // 2 + MM(0.1)
            union([(li, i) for li, (_, f) in enumerate(fills) for q in ring(c.x, c.y, r)[1:]
                   for i in [piece_at(f, q)] if i is not None])
    area = {k: fills[k[0]][1].Outline(k[1]).Area() for k in parent}
    main = find(max(area, key=area.get))
    r, step, added, hs = MM(0.35), MM(0.25), 0, holes(board)
    groups = {}
    for k in parent:
        if find(k) != main:
            groups.setdefault(find(k), []).append(k)
    for keys in groups.values():
        spot = None
        for li, i in keys:
            box = fills[li][1].Outline(i).BBox()
            spot = next(((x, y) for y in range(box.GetY(), box.GetBottom(), step) for x in range(box.GetX(), box.GetRight(), step)
                         if piece_at(fills[li][1], pcbnew.VECTOR2I(x, y)) == i and clear_of_holes(hs, x, y) and fits(fills, x, y, r)
                         and all(find((lj, piece_at(g, pcbnew.VECTOR2I(x, y)))) == main for lj, (_, g) in enumerate(fills) if lj != li)), None)
            if spot:
                break
        if spot:
            add_via(board, gnd, *spot)
            hs.append((pcbnew.VECTOR2I(*spot), MM(0.15)))
            added += 1
        else:
            bb = fills[keys[0][0]][1].Outline(keys[0][1]).BBox()
            print(f'  no room to join a ground island at ({pcbnew.ToMM(bb.GetX()):.1f}, {pcbnew.ToMM(bb.GetY()):.1f}) mm')
    return added


def tidy(board):
    """Freerouting leaves a few loose ends: signal vias whose tracks all sit on one layer (the tracks
    meet without them, or end there as a dead-end stub), and ground vias drilled on top of another
    hole (the ESP32's thermal vias already join the layers). Removes them; returns how many."""
    gnd, n = board.FindNet('GND').GetNetCode(), 0
    pads = list(board.GetPads())

    def layers_at(item, c):
        """Copper layers on which something else of the same net touches point c."""
        net, out = item.GetNetCode(), set()
        for t in board.GetTracks():
            if t.GetNetCode() != net or t.m_Uuid.AsString() == item.m_Uuid.AsString():
                continue
            if t.GetClass() == 'PCB_VIA' and t.GetPosition() == c:
                out |= {pcbnew.F_Cu, pcbnew.B_Cu}
            elif t.GetClass() == 'PCB_TRACK' and c in (t.GetStart(), t.GetEnd()):
                out.add(t.GetLayer())
        out |= {l for p in pads if p.GetNetCode() == net and p.HitTest(c) for l in (pcbnew.F_Cu, pcbnew.B_Cu) if p.IsOnLayer(l)}
        return out

    hs = holes(board)
    for v in [v for v in board.GetTracks() if v.GetClass() == 'PCB_VIA' and not v.IsLocked()]:
        c = v.GetPosition()
        if v.GetNetCode() == gnd:
            crowded = any(h != c and math.hypot(h.x - c.x, h.y - c.y) < r + v.GetDrill() // 2 + MM(0.25) for h, r in hs)
            if crowded and any(p.GetNetCode() == gnd and p.GetDrillSize().x and p.HitTest(c) for p in pads):
                board.Delete(v)
                n += 1
        elif len(layers_at(v, c)) < 2:
            board.Delete(v)
            n += 1
    while True:  # dead-end stubs, a segment at a time
        stubs = [t for t in board.GetTracks() if t.GetClass() == 'PCB_TRACK' and not t.IsLocked() and t.GetNetCode() != gnd
                 and any(t.GetLayer() not in layers_at(t, e) for e in (t.GetStart(), t.GetEnd()))]
        if not stubs:
            return n
        for t in stubs:
            board.Delete(t)
            n += 1


def widen_necks(board):
    """Freerouting necks tracks down at pads, a little under the board's minimum track width."""
    n, minimum = 0, board.GetDesignSettings().m_TrackMinWidth
    for t in board.GetTracks():
        if t.GetClass() == 'PCB_TRACK' and t.GetWidth() < minimum:
            t.SetWidth(minimum)
            n += 1
    return n


board = pcbnew.LoadBoard(PCB)
if '--post' not in sys.argv:
    # Freerouting's router is deterministic and sometimes stalls with a net open. A slightly larger
    # clearance margin is a different problem for it, so retry from the unrouted board with one.
    for m in (0.01, 0.02, 0.03):
        left = route(board, m)
        if not left:
            break
        print(f'Freerouting left {left} connection(s) unrouted with a {m} mm margin; retrying')
        board = pcbnew.LoadBoard(PCB)
    else:
        sys.exit('still unrouted; see ' + LOG)
print('loose vias and stubs removed:', tidy(board))
filler = pcbnew.ZONE_FILLER(board)
filler.Fill(board.Zones())
print('stitching vias:', stitch(board))
filler.Fill(board.Zones())
for _ in range(3):  # a new via can leave another piece cut off; a few rounds settle it
    n = join_islands(board)
    print('island vias:', n)
    filler.Fill(board.Zones())
    if not n:
        break
print('necked tracks widened:', widen_necks(board))
filler.Fill(board.Zones())
pcbnew.SaveBoard(PCB, board)
print('done:', PCB, len(board.GetTracks()), 'tracks and vias')
