#!/usr/bin/env python3
"""Polygons of die.json to nets, transistors, resistors and capacitors. Diodes come later.

A net is metal, contacts and doped polygons that touch: a contact joins the metal and doped polygons it overlaps,
overlapping metal polygons join, and doped polygons that touch join when they are one layer or one is untyped.
Wells and substrate are not drawn, except as resistors: a resistor polygon outlines a lightly doped body, a P-well
strip or a patch of N substrate. Its ends are the doped polygons it overlaps (by MIN_PIECE or more) and the one
whose hole it fills; it joins none of them. Its body is a P-well if its ends are P+, N substrate if they are N+.
Channels conduct nothing here, so the doped polygons on a channel's two sides stay apart.
A net takes the names of the pins and labels on its metal, joined by ' = ' when there are several.
A channel polygon outlines a gate-oxide window, which may cover doped silicon; each piece of it outside doped
polygons is one transistor, so a doped strip crossing the window makes two.
Run from the repo root: python3 extract/netlist.py
"""
import collections
import json
import os

from shapely.geometry import Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

HERE = os.path.dirname(os.path.abspath(__file__))
DIE = os.path.join(HERE, '..', 'die.json')
DOPED = ('nplus', 'pplus', 'doped')
RESISTOR = 'resistor'
TOUCH = 1   # px; shapes this close touch
MIN_PIECE = 50   # px^2; smaller pieces of a channel are left by misaligned outlines, not transistors
EDGE = 1.5   # px; a channel piece's edge this close to a doped polygon is shared with it
WEAK = 1.0   # width / length below which a transistor is weak: a latch's feedback, overdriven by its input
TYPE = {'nplus': 'N', 'pplus': 'P'}


class Union:
    def __init__(self, items):
        self.parent = {i: i for i in items}

    def root(self, i):
        while self.parent[i] != i:
            self.parent[i] = self.parent[self.parent[i]]
            i = self.parent[i]
        return i

    def join(self, a, b):
        self.parent[self.root(a)] = self.root(b)


class Die:
    """Shapes of die.json, {id: shape}, with their geometry and a spatial index."""

    def __init__(self, shapes):
        self.shapes = {s['id']: s for s in shapes}
        self.geo = {i: Polygon(s['pts'], s['holes']).buffer(0) for i, s in self.shapes.items()}
        self.ids = list(self.shapes)
        self.tree = STRtree([self.geo[i] for i in self.ids])

    def of(self, *layers):
        return [i for i in self.ids if self.shapes[i]['layer'] in layers]

    def touching(self, g, layers, grow=TOUCH):
        g = g.buffer(grow)
        return [self.ids[j] for j in self.tree.query(g)
                if self.shapes[self.ids[j]]['layer'] in layers and self.geo[self.ids[j]].intersects(g)]

    def overlapping(self, g, layers):
        return [i for i in self.touching(g, layers, 0) if self.geo[i].intersection(g).area > 0]

    def join_doped(self, u):
        """Join, in u, doped polygons that touch and are one layer or untyped."""
        for i in self.of(*DOPED):
            layer = self.shapes[i]['layer']
            for j in self.touching(self.geo[i], DOPED if layer == 'doped' else (layer, 'doped')):
                u.join(i, j)

    def regions(self):
        """Union of doped polygons into doped regions."""
        u = Union(self.of(*DOPED))
        self.join_doped(u)
        return u

    def metal_at(self, xy):
        return [m for m in self.touching(Point(xy), ('metal',)) if self.geo[m].contains(Point(xy))]

    def pieces(self, c):
        """Parts of channel c outside doped polygons, top to bottom then left to right: one transistor each."""
        g = self.geo[c]
        cut = self.overlapping(g, DOPED)
        if cut:
            g = g.difference(unary_union([self.geo[k] for k in cut]))
        parts = [p for p in getattr(g, 'geoms', [g]) if p.area >= MIN_PIECE]
        return sorted(parts, key=lambda p: (p.centroid.y, p.centroid.x))


def ends(d, r):
    """Doped polygons of Die d that resistor r overlaps, or with a hole that r fills."""
    g, out = d.geo[r], []
    for i in d.touching(g, DOPED):
        holes = [Polygon(h).buffer(0) for h in d.shapes[i]['holes']]
        if d.geo[i].intersection(g).area >= MIN_PIECE or any(g.within(h.buffer(TOUCH)) and h.within(g.buffer(TOUCH))
                                                              for h in holes):
            out.append(i)
    return out


def body(d, es):
    """'P-well' or 'N substrate' for a resistor with ends es in Die d, from their layer; None if mixed or untyped."""
    layers = {d.shapes[i]['layer'] for i in es}
    return {frozenset({'pplus'}): 'P-well', frozenset({'nplus'}): 'N substrate'}.get(frozenset(layers))


def union(die):
    """(Die, Union of its shapes into nets) for die, a parsed die.json."""
    d = Die(die['shapes'])
    u = Union(d.of('metal', 'contact', *DOPED))
    d.join_doped(u)
    for c in d.of('contact'):
        for i in d.overlapping(d.geo[c], ('metal',) + DOPED):
            u.join(c, i)
    for m in d.of('metal'):
        for n in d.overlapping(d.geo[m], ('metal',)):
            u.join(m, n)
    return d, u


def nets(die):
    """{shape id: net name} for every metal, contact and doped shape of die, a parsed die.json."""
    d, u = union(die)
    names = collections.defaultdict(set)
    for p in die['pins'] + die['labels']:
        for m in d.metal_at(p['at']):
            names[u.root(m)].add(p['name'])
    members = collections.defaultdict(list)
    for i in u.parent:
        members[u.root(i)].append(i)
    return {i: ' = '.join(sorted(names[r])) or f'n{min(ms)}' for r, ms in members.items() for i in ms}


def transistors(die):
    """[{channel, piece, type, gate, terms, width, length, weak}] for every channel piece of die, a parsed die.json:
    channel polygon id, piece index (Die.pieces order), N or P (None unless all terminals are one typed layer), the
    net of the metal most over the channel, the nets of the doped regions the piece touches (normally two), its
    width (mean edge shared with its two widest doped polygons) and length (area over width) in px, and whether
    width / length is under WEAK."""
    d = Die(die['shapes'])
    net, root = nets(die), d.regions().root
    out = []
    for c in d.of('channel'):
        g = d.geo[c]
        gates = d.overlapping(g, ('metal',))
        gate = max(gates, key=lambda m: d.geo[m].intersection(g).area) if gates else None
        for k, p in enumerate(d.pieces(c)):
            regions = {}
            for i in d.touching(p, DOPED):
                regions.setdefault(root(i), i)
            layers = {d.shapes[i]['layer'] for i in regions.values()}
            shared = sorted(p.boundary.intersection(d.geo[i].buffer(EDGE)).length for i in d.touching(p, DOPED))[-2:]
            width = sum(shared) / len(shared) if shared else 0
            length = p.area / width if width else 0
            out.append({'channel': c, 'piece': k, 'type': TYPE.get(*layers) if len(layers) == 1 else None,
                        'gate': net.get(gate), 'terms': [net[i] for i in regions.values()],
                        'width': round(width), 'length': round(length), 'weak': 0 < width < WEAK * length})
    return out


def resistors(die):
    """[{id, body, ends, squares, ohms}] for every resistor of die, a parsed die.json: its id, body, the nets of its
    ends, and, for a strip that overlaps both its ends, its squares (distance between the ends' centres, squared,
    over its area: length over width for a rectangle) times its body's sheet resistance in die['values'] where known."""
    d = Die(die['shapes'])
    net = nets(die)
    out = []
    for r in d.of(RESISTOR):
        es = ends(d, r)
        b = body(d, es)
        inside = [i for i in es if d.geo[i].intersection(d.geo[r]).area >= MIN_PIECE]
        squares = ohms = None
        if len(inside) == len(es) == 2:
            squares = round(d.geo[es[0]].centroid.distance(d.geo[es[1]].centroid) ** 2 / d.geo[r].area, 2)
            per = die['values']['ohms_per_square'].get(b, {}).get('value')
            ohms = round(squares * per) if per is not None else None
        out.append({'id': r, 'body': b, 'ends': sorted({net[i] for i in es}), 'squares': squares, 'ohms': ohms})
    return out


def capacitors(die):
    """[{nets, areas, farads, source}] for die, a parsed die.json: the drawn capacitors in die['values'], with their
    plates' nets, then one per net with nets [net, None], None for the silicon under it, and its areas in px^2 by
    layer ('gate' for the channel pieces it gates). farads is None unless die['values'] gives um_per_px and the
    farads_per_um2 of every layer with area."""
    d = Die(die['shapes'])
    net = nets(die)
    values = die['values']
    out = [{'nets': [net.get(i) for i in c['plates']], 'areas': None, 'farads': c['farads'], 'source': c['source']}
           for c in values.get('capacitors', [])]
    skip = unary_union([d.geo[c] for c in d.of('channel')] +
                       [d.geo[i] for c in values.get('capacitors', []) for i in c['plates'][1:] if i is not None])
    areas = collections.defaultdict(lambda: collections.defaultdict(float))
    for i in d.of('metal'):
        areas[net[i]]['metal'] += d.geo[i].difference(skip).area
    for i in d.of(*DOPED):
        areas[net[i]][d.shapes[i]['layer']] += d.geo[i].area
    for t, p in zip(transistors(die), [p for c in d.of('channel') for p in d.pieces(c)]):
        if t['gate'] is not None:
            areas[t['gate']]['gate'] += p.area
    scale = values.get('um_per_px', {}).get('value')
    per = {k: v.get('value') for k, v in values.get('farads_per_um2', {}).items()}
    for n in sorted(areas):
        a = {k: round(v) for k, v in areas[n].items() if round(v)}
        known = scale is not None and all(per.get(k) is not None for k in a)
        out.append({'nets': [n, None], 'areas': a, 'source': 'areas',
                    'farads': sum(v * scale ** 2 * per[k] for k, v in a.items()) if known else None})
    return out


def main():
    die = json.load(open(DIE))
    net = nets(die)
    size = collections.Counter(net.values())
    named = sorted(n for n in size if not n.startswith('n'))
    print(f'{len(size)} nets; named:', ', '.join(f'{n} ({size[n]} shapes)' for n in named))
    ts = transistors(die)
    print(f'{len(ts)} transistors:', dict(collections.Counter(t['type'] for t in ts)),
          f"{sum(t['weak'] for t in ts)} weak")
    for r in resistors(die):
        print(f"resistor {r['id']} ({r['body']}): {' / '.join(r['ends'])}, {r['squares']} squares, {r['ohms']} ohms")
    cs = capacitors(die)
    for c in cs:
        if c['areas'] is None:
            print(f"capacitor {' / '.join(map(str, c['nets']))}: {c['farads']} farads, drawn")
    print(f"{sum(c['areas'] is not None for c in cs)} net capacitors, "
          f"{sum(c['farads'] is None for c in cs)} capacitors without a value")


if __name__ == '__main__':
    main()
