#!/usr/bin/env python3
"""The circuit hierarchy recorded in die.json, above its transistors: stages, cells and blocks.

die['types'] names the approved stage and cell types, keyed by a fingerprint of their wiring (a Weisfeiler-Lehman
hash of extract/propose.py's graph() or cell_graph()), so a type keeps its name whatever extract/propose.py would call it.
die['cells'] lists each cell: its name, type and transistors (channel.piece, as extract/propose.py numbers them);
die['blocks'] lists each block's cells. Stages are not recorded: extract/propose.py derives them from the transistors.
A net's name is a pad's or a label's (die['labels']), else block.cell.port of the cell driving it: port q for a storage cell's output, y for
another's, y0, y1, ... when a cell drives several nets other cells read, i0, i1, ... for nets inside a cell; the
cell part is left out when the cell is named after its block.
Run from the repo root: python3 extract/hier.py, to print each block's cells and the named nets.
"""
import collections
import json

import propose
from netlist import DIE

SUP = ('GND', 'VDD')


fingerprint = propose.fingerprint


def cells(die):
    """[{name, type, block, stages, ts, ext, storage, kinds}]: die['cells'] with extract/propose.py's stages and graph
    fields; kinds are the stages' recorded type names. Raises if a stage's transistors span two cells."""
    ss = propose.stages(die)
    stage_type = die['types']['stages']
    where = {}
    for c in die['cells']:
        for t in c['transistors']:
            where[t] = c['name']
    block = {c: b['name'] for b in die['blocks'] for c in b['cells']}
    find = propose.joined(die)
    pins = {find(p['name']) for p in die['pins']} - set(SUP)
    mine = collections.defaultdict(list)
    for s in ss:
        homes = {where.get(i) for t in s['ts'] for i in t['id'].split('+')}
        if len(homes) != 1 or None in homes:
            raise ValueError(f"stage at {s['out'] or s['ts'][0]['terms']}: transistors in cells {sorted(map(str, homes))}")
        mine[homes.pop()].append(s)
    strong = {s['out'] for s in ss if s['out'] and not all(t['weak'] for t in s['ts'])
              and stage_type.get(fingerprint(propose.graph(s))) != 'gated_pullup'}
    out = []
    for c in die['cells']:
        st = mine[c['name']]
        ids = {t['id'] for s in st for t in s['ts']}
        nets = {n for s in st for t in s['ts'] for n in [t['gate'], *t['terms']]}
        outside = {n for s in ss for t in s['ts'] if t['id'] not in ids for n in [t['gate'], *t['terms']]}
        out.append({'name': c['name'], 'type': c['type'], 'block': block.get(c['name']), 'stages': st,
                    'ts': [t for s in st for t in s['ts']], 'ext': (nets & (outside | pins)) - set(SUP),
                    'storage': {x for s in st if s['kind'] == 'tg' for x in s['ts'][0]['terms']} - strong - set(SUP),
                    'kinds': [stage_type.get(fingerprint(propose.graph(s)), '?') for s in st], 'kind': 'cell', 'out': None})
    return out


def net_names(die, cs=None):
    """{net: name} for every net a cell's transistors touch, by the rule in this module's docstring."""
    cs = cs if cs is not None else cells(die)
    find = propose.joined(die)
    names = {n: n for n in SUP} | {find(p['name']): p['name'] for p in die['pins'] + die['labels']}
    for c in cs:
        prefix = c['block'] if c['name'] == c['block'] else f"{c['block']}.{c['name']}"
        outs = sorted({s['out'] for s in c['stages'] if s['out'] and s['out'] in c['ext']}, key=natural)
        port = 'q' if c['storage'] else 'y'
        for k, n in enumerate(outs):
            names.setdefault(n, f'{prefix}.{port}' if len(outs) == 1 else f'{prefix}.{port}{k}')
        inner = sorted({n for t in c['ts'] for n in [t['gate'], *t['terms']]} - c['ext'] - set(SUP), key=natural)
        for k, n in enumerate(inner):
            names.setdefault(n, f'{prefix}.i{k}')
    return names


def natural(n):
    return (len(n), n)


def main():
    die = json.load(open(DIE))
    cs = cells(die)
    names = net_names(die, cs)
    for b in die['blocks']:
        types = collections.Counter(c['type'] for c in cs if c['block'] == b['name'])
        print(f"{b['name']:6} {len(b['cells']):3} cells: {', '.join(f'{k} {v}' for k, v in types.most_common())}")
    print(f'{len(names)} named nets, e.g.', ', '.join(sorted(names.values())[:12]))


if __name__ == '__main__':
    main()
