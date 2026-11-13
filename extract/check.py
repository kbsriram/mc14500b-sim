#!/usr/bin/env python3
"""Checks on die.json; prints problems and writes them to extract/problems.json, in windows of nearby problems.

1. Schema: known keys and layers, unique ids, valid polygons; cells, blocks, marks, pins and values name real shapes.
2. Every channel lies under one metal polygon (its gate) and has no contact on it.
3. Every channel piece (netlist.Die.pieces: a transistor) touches exactly two doped regions (its terminals), both of
   one layer, and is in one cell. A doped region is a group of same-layer doped polygons
   that touch; channels cut doped silicon, so the two sides are separate regions.
4. Every contact lands on doped silicon; a contact may also reach past it, as long strips and contacts shared by two regions do.
   A contact named in a mark (a registration or other mark, not a circuit) need not.
5. No doped polygon is untyped; the viewer draws them untyped (layer doped) and Claude sets N+ or P+.
6. No outline is jagged: JAGGED or more short edges (straight ones under SHORT px, diagonal ones under CHAMFER px)
   next to another short edge mark an outline traced from the photo rather than drawn, likely misplaced.
   A short edge between two long ones is a drawn corner cut and does not count.
7. No doped polygon lies mostly (COVERED of its area or more) under another of its layer: it needs a hole cut
   around it, or merging into the other.
8. Supply regions still to draw: GROUP_MIN or more GND or VDD contacts on no doped polygon, each within GROUP px of
   another, mark an undrawn region.
9. Every resistor has exactly two ends (netlist.ends), both N+ or both P+.
10. Hierarchy (extract/hier.py): cell and block names are unique, every cell is in one block and has a recorded type,
    and no stage's transistors span two cells.
11. Every stage's wiring is a recorded stage type, and every cell's is its type's: its fingerprint is recorded under
    that name, and it is isomorphic to the type's first copy.
Run from the repo root: python3 extract/check.py
"""
import collections
import json
import os
import sys

from shapely.geometry import Polygon

from netlist import DOPED, RESISTOR, Die, Union, body, ends, nets

HERE = os.path.dirname(os.path.abspath(__file__))
DIE = os.path.join(HERE, '..', 'die.json')
OUT = os.path.join(HERE, 'problems.json')
LAYERS = ('metal', 'contact', 'channel', 'nplus', 'pplus', 'doped', RESISTOR)
KEYS = {'units', 'size', 'shapes', 'pins', 'labels', 'values', 'types', 'cells', 'blocks', 'marks'}
GATE = 0.5       # least fraction of a channel's area its gate metal covers; metal and silicon photos misregister
ON_DOPED = 50    # px^2; least overlap of a contact with doped polygons
COVERED = 0.5    # share of a doped polygon's area under another of its layer that makes it covered
GROUP = 400      # px; supply contacts on no doped polygon this close to each other form one group
GROUP_MIN = 3    # least contacts in a group that mark an undrawn supply region
JAGGED = 3       # short edges beside short edges that make an outline jagged; hand-drawn outlines have none
SHORT = 8        # px; straight edges shorter than this are short
CHAMFER = 12     # px; diagonal edges whose longer side is shorter than this are short
WINDOW = 300     # px; a window holds problems this close to its first one, in x and in y
PER_WINDOW = 6   # most problems in one window


def run(die, net=None):
    """[{kind, note, at, rect, ids}] for die, a parsed die.json, sorted by position. at is a die pixel [x, y];
    ids[0] is the shape the problem is about, rect [x, y, w, h] its bounding box, that of a group's frame ids, or the
    box given.
    net: netlist.nets(die), if the caller has it."""
    problems = []

    def bad(kind, note, at, ids=(), frame=(), box=None):
        problems.append({'kind': kind, 'note': note, 'at': [int(round(v)) for v in at], 'ids': list(dict.fromkeys(ids)),
                         'frame': list(frame), 'box': box})

    # 1. Schema.
    if set(die) != KEYS:
        bad('schema', f'top-level keys differ: missing {sorted(KEYS - set(die))}, extra {sorted(set(die) - KEYS)}', (0, 0))
    shapes, geo = {}, {}
    for s in die.get('shapes', []):
        i = s.get('id')
        if i in shapes:
            bad('schema', f'duplicate shape id {i}', s['pts'][0], [i])
            continue
        if s.get('layer') not in LAYERS or set(s) != {'id', 'layer', 'pts', 'holes'}:
            bad('schema', f'shape {i}: layer {s.get("layer")!r}, keys {sorted(s)}', s['pts'][0], [i])
            continue
        g = Polygon(s['pts'], s['holes'])
        if len(s['pts']) < 3 or not g.is_valid or g.area == 0:
            g = g.buffer(0)
            bad('schema', f'shape {i}: invalid or empty polygon{", left out of the other checks" * g.is_empty}',
                s['pts'][0], [i])
            if g.is_empty:   # e.g. a hole around the whole outline
                continue
        shapes[i], geo[i] = s, g
    d = Die(shapes.values())
    of, touching, geo = d.of, d.touching, d.geo
    at = lambda i: geo[i].representative_point().coords[0]

    def is_layer(i, layer, where):
        if shapes.get(i, {}).get('layer') != layer:
            bad('schema', f'{where}: {i} is not a {layer} shape', at(i) if i in shapes else (0, 0), [i] if i in shapes else [])

    owner = collections.defaultdict(dict)   # channel: {piece: cell}
    for c in die.get('cells', []):
        for x in c['transistors']:
            i, k = map(int, x.split('.'))
            is_layer(i, 'channel', f'cell {c["name"]} transistor {x}')
            if k in owner[i]:
                bad('schema', f'transistor {x} is in cells {owner[i][k]} and {c["name"]}', at(i) if i in geo else (0, 0))
            owner[i][k] = c['name']
    names = {c['name'] for c in die.get('cells', [])}
    for b in die.get('blocks', []):
        for c in set(b['cells']) - names:
            bad('schema', f'block {b["name"]}: no cell {c}', (0, 0))
    marked = set()
    for m in die.get('marks', []):
        for i in m['shapes']:
            if shapes.get(i, {}).get('layer') not in ('metal', 'contact'):
                bad('schema', f'mark {m["note"]!r}: {i} is not a metal or contact shape', at(i) if i in shapes else (0, 0))
            marked.add(i)
    for p in die.get('pins', []) + die.get('labels', []):
        if not d.metal_at(p['at']):
            bad('schema', f'pin or label {p["name"]} is on no metal', p['at'])
    for cap in die.get('values', {}).get('capacitors', []):
        metal, doped = cap['plates']
        is_layer(metal, 'metal', 'capacitor plate')
        if doped is None:
            bad('capacitor', 'capacitor has no doped plate under its metal plate', at(metal), [metal])
        elif shapes.get(doped, {}).get('layer') not in DOPED:
            bad('schema', f'capacitor plate {doped} is not doped', at(metal), [metal])

    root = d.regions().root

    # 2 and 3. Gate and terminals of each channel.
    for i in of('channel'):
        name = f"channel {i} ({', '.join(sorted(set(owner[i].values()))) or 'in no cell'})"
        g = geo[i]
        gates = [m for m in touching(g, ('metal',), 0) if geo[m].intersection(g).area > 0]
        cover = sum(geo[m].intersection(g).area for m in gates) / g.area
        if len(gates) != 1 or cover < GATE:
            bad('gate', f'{name}: {len(gates)} metal polygons over it, covering {cover:.0%}', at(i), [i] + gates)
        shorts = [c for c in touching(g, ('contact',), 0) if geo[c].intersection(g).area > 0]
        if shorts:
            bad('gate', f'{name}: contacts {shorts} on the channel', at(i), [i] + shorts)
        pieces = d.pieces(i)
        if set(owner[i]) != set(range(len(pieces))):
            bad('cell', f'{name}: {len(pieces)} transistors (pieces outside doped silicon); cells list pieces '
                f'{sorted(owner[i])}', at(i), [i])
        for k, p in enumerate(pieces):
            pname = f'transistor {i}.{k} ({owner[i].get(k, "in no cell")})'
            terms = collections.defaultdict(list)
            for j in touching(p, DOPED):
                terms[root(j)].append(j)
            polys = sorted(j for js in terms.values() for j in js)
            layers = {shapes[j]['layer'] for j in polys} - {'doped'}
            where = p.representative_point().coords[0]
            if len(terms) < 2:
                bad('terminal', f'{pname}: touches {len(terms)} doped region{"s" * (len(terms) != 1)}, needs 2',
                    where, [i] + polys)
            elif len(terms) > 2:
                bad('terminal', f'{pname}: touches {len(terms)} doped regions {polys}, needs 2', where, [i] + polys)
            if len(layers) > 1:
                bad('terminal', f'{pname}: terminals on both N+ and P+ {polys}', where, [i] + polys)

    # 4. Contacts on doped silicon.
    bare = []
    for c in of('contact'):
        if c in marked:
            continue
        on = sum(geo[k].intersection(geo[c]).area for k in touching(geo[c], DOPED, 0))
        if on < ON_DOPED:
            bad('contact', f'contact {c}: on no doped polygon', at(c), [c])
            bare.append(c)

    # 5. Untyped doped polygons.
    for i in of('doped'):
        bad('untyped', f'doped polygon {i}: N+ or P+ not set yet', at(i), [i])

    # 6. Jagged outlines.
    for i in of('channel', RESISTOR, *DOPED):
        rings = []   # (ring index, its counted short edges as corner pairs)
        for k, r in enumerate([shapes[i]['pts'], *shapes[i]['holes']]):
            edges = list(zip(r, r[1:] + r[:1]))
            short = [max(abs(x1 - x0), abs(y1 - y0)) < CHAMFER if x1 != x0 and y1 != y0 else
                     abs(x1 - x0) + abs(y1 - y0) < SHORT for (x0, y0), (x1, y1) in edges]
            counted = [e for j, e in enumerate(edges) if short[j] and (short[j - 1] or short[(j + 1) % len(short)])]
            if counted:
                rings.append((k, counted))
        n = sum(len(c) for _, c in rings)
        if n >= JAGGED:   # one problem for each outline or hole with counted edges, framed on those edges
            for k, counted in rings:
                xs = [x for e in counted for x, _ in e]; ys = [y for e in counted for _, y in e]
                where = 'outline' if k == 0 else f'hole {k - 1}'
                bad('jagged', f'{shapes[i]["layer"]} {i}: {n} short edges, {len(counted)} in its {where}',
                    counted[0][0], [i], box=(min(xs), min(ys), max(xs), max(ys)))

    # 7. Doped polygons under others of their layer.
    for i in of(*DOPED):
        for j in d.overlapping(geo[i], (shapes[i]['layer'],)):
            share = geo[i].intersection(geo[j]).area / geo[i].area if j != i else 0
            if share >= COVERED:
                bad('covered', f'{shapes[i]["layer"]} {i}: {share:.0%} under {j}', at(i), [i, j])

    # 8. Supply regions to draw.
    net = net or nets(die)
    supply = lambda i: next((s for s in ('GND', 'VDD') if s in net.get(i, '').split(' = ')), None)

    def groups(ids, layers, gap):   # ids within gap px of another of the same supply and layer, in groups
        u = Union(ids)
        for i in ids:
            for j in touching(geo[i], layers, gap):
                if j in u.parent and supply(j) == supply(i) and shapes[j]['layer'] == shapes[i]['layer']:
                    u.join(i, j)
        out = collections.defaultdict(list)
        for i in ids:
            out[u.root(i)].append(i)
        return sorted(sorted(g) for g in out.values())

    for g in groups([c for c in bare if supply(c)], ('contact',), GROUP):
        if len(g) >= GROUP_MIN:
            bad('supply-group', f'{len(g)} {supply(g[0])} contacts {g} on no doped polygon: an undrawn {supply(g[0])} '
                'region', at(g[0]), g, g)

    # 9. Resistors.
    for r in of(RESISTOR):
        es = ends(d, r)
        if len(es) != 2 or body(d, es) is None:
            bad('resistor', f'resistor {r}: ends {es}; needs two, both N+ or both P+', at(r), [r, *es])

    # 10 and 11. Hierarchy.
    hierarchy(die, bad, at if geo else None)

    for p in problems:
        ids = [i for i in (p.pop('frame') or p['ids'][:1]) if i in geo]
        box = p.pop('box')
        if box:
            p['rect'] = [int(box[0]), int(box[1]), int(box[2] - box[0]), int(box[3] - box[1])]
        elif ids:
            x0, y0 = min(geo[i].bounds[0] for i in ids), min(geo[i].bounds[1] for i in ids)
            x1, y1 = max(geo[i].bounds[2] for i in ids), max(geo[i].bounds[3] for i in ids)
            p['rect'] = [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]
        else:
            p['rect'] = [*p['at'], 0, 0]

    problems.sort(key=lambda p: (p['at'][1] // 100, p['at'][0]))
    return problems


def hierarchy(die, bad, at):
    """Rules 10 and 11 on die, calling bad(kind, note, at, ids) as run() does; at(i) places a channel i."""
    import networkx as nx

    import hier
    import propose
    if 'types' not in die or 'transistors' not in (die.get('cells') or [{}])[0]:
        bad('hierarchy', 'die.json records no types, or cells without transistor lists', (0, 0))
        return
    first = lambda c: int(c['transistors'][0].split('.')[0]) if c['transistors'] else None
    where = lambda c: (at(first(c)), [first(c)]) if first(c) is not None and at else ((0, 0), [])
    names = [c['name'] for c in die['cells']]
    for n in {n for n in names if names.count(n) > 1}:
        bad('hierarchy', f'cell name {n} used {names.count(n)} times', (0, 0))
    inblock = collections.Counter(c for b in die['blocks'] for c in b['cells'])
    for c in die['cells']:
        if inblock[c['name']] != 1:
            bad('hierarchy', f'cell {c["name"]} is in {inblock[c["name"]]} blocks', *where(c))
        if c['type'] not in die['types']['cells'].values():
            bad('hierarchy', f'cell {c["name"]}: type {c["type"]} is not recorded', *where(c))
    try:
        cs = hier.cells(die)
    except ValueError as e:
        bad('hierarchy', str(e), (0, 0))
        return
    match = dict(node_match=lambda a, b: a['label'] == b['label'], edge_match=lambda a, b: a['label'] == b['label'])
    seen = {}
    for c, rec in zip(cs, die['cells']):
        for s, k in zip(c['stages'], c['kinds']):
            if k == '?':
                bad('type', f'cell {c["name"]}: stage at {s["out"] or s["ts"][0]["terms"]} is no recorded stage type', *where(rec))
        g = propose.cell_graph(c)
        if die['types']['cells'].get(hier.fingerprint(g)) != c['type']:
            bad('type', f'cell {c["name"]}: wiring is not type {c["type"]}\'s', *where(rec))
        if c['type'] in seen and not nx.is_isomorphic(seen[c['type']][0], g, **match):
            bad('type', f'cell {c["name"]}: wiring differs from {seen[c["type"]][1]}, the first {c["type"]}', *where(rec))
        seen.setdefault(c['type'], (g, c['name']))


def windows(problems):
    """[{rect, problems}]: from the first problem not yet in a window, it and the nearest others within WINDOW."""
    left, out = list(problems), []
    while left:
        x, y = left[0]['at']
        near = sorted((p for p in left if abs(p['at'][0] - x) <= WINDOW and abs(p['at'][1] - y) <= WINDOW),
                      key=lambda p: max(abs(p['at'][0] - x), abs(p['at'][1] - y)))[:PER_WINDOW]
        left = [p for p in left if not any(p is q for q in near)]
        x0 = min(p['rect'][0] for p in near)
        y0 = min(p['rect'][1] for p in near)
        x1 = max(p['rect'][0] + p['rect'][2] for p in near)
        y1 = max(p['rect'][1] + p['rect'][3] for p in near)
        out.append({'rect': [x0, y0, x1 - x0, y1 - y0], 'problems': near})
    return out


def save(die, net=None):
    """Problems of die, written to extract/problems.json; returns what it wrote. net: as for run."""
    out = {'windows': windows(run(die, net))}
    with open(OUT + '.tmp', 'w') as f:
        json.dump(out, f, indent=1)
    os.replace(OUT + '.tmp', OUT)
    return out


def main():
    out = save(json.load(open(DIE)))
    problems = [p for w in out['windows'] for p in w['problems']]
    for p in problems:
        print(f'{p["kind"]:9} {p["at"][0]:5},{p["at"][1]:<5} {p["note"]}')
    print(f'wrote {os.path.relpath(OUT)}: {len(problems)} problems in {len(out["windows"])} windows',
          dict(collections.Counter(p['kind'] for p in problems)))
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
