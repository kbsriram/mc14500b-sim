#!/usr/bin/env python3
"""Write site/gen/mc14500b.js, the MC14500B from die.json in the format site/netlist.js reads.
Transistors and nets are extract/netlist.py's, with each resistor's ends joined as extract/propose.py joins them; stages are
extract/propose.py's, cells, blocks, types and net names extract/hier.py's.
A type's copies are drawn from one layout, so each copy names its nets and parts by role, the same in every copy:
the type's first copy names them, and a graph isomorphism (extract/propose.py's graph and cell_graph) maps each other
copy onto it. A stage's roles: y its output, a, b, ... its inputs in its N network's order, m0, m1, ... nets between
transistors; a transmission gate's are a and b (its terminals), gn and gp (its gates). A cell's: in0, in1, ... the
nets it reads from outside, out0, out1, ... the nets it drives that others read, n0, n1, ... its own.
Run from the repo root: python3 extract/build.py
"""
import json
import os

import networkx as nx

import hier
import netlist
import propose
from logic import reduce

HERE = os.path.dirname(os.path.abspath(__file__))

VOLTS = 5
OHMS = {False: 1e3, True: 1e4}   # ohm, a conducting strong or weak transistor; assumed, not measured
SUP = ('GND', 'VDD')
natural = hier.natural


def mapping(g, h):
    """{node of g: node of h}, an isomorphism matching node and edge labels. Of several (a transmission gate's two
    terminals swap), the least by image in g's node order, so the choice does not depend on Python's hash seed."""
    same = lambda x, y: x['label'] == y['label']
    m = nx.algorithms.isomorphism.GraphMatcher(g, h, node_match=same, edge_match=same)
    best = min(m.isomorphisms_iter(), key=lambda x: [str(x[n]) for n in g], default=None)
    assert best is not None, 'copies of one type differ'
    return best


def tree(x, rename):
    """An extract/logic.py reduce() expression with its leaves renamed: a leaf, or [op, [trees]]; groups before leaves."""
    if isinstance(x, str):
        return rename(x)
    kids = [tree(y, rename) for y in x[1]]
    return [x[0], sorted(kids, key=lambda k: (isinstance(k, str), str(k)))]


def leaves(x):
    return [x] if isinstance(x, str) else [y for k in x[1] for y in leaves(k)]


def stage_type(s):
    """(type info, {net: role}, {transistor id: role}) for s, the first copy of its type."""
    ts = {t['id']: t for t in s['ts']}
    role = {n: n for n in SUP}
    info = {'kind': s['kind']}
    if s['kind'] == 'tg':
        n = next(t for t in s['ts'] if t['type'] == 'N')
        p = next(t for t in s['ts'] if t['type'] == 'P')
        role.update({n['terms'][0]: 'a', n['terms'][1]: 'b', n['gate']: 'gn', p['gate']: 'gp'})
        order = [p['id'], n['id']]
    else:
        out = s['out']
        if out:
            role[out] = 'y'
        nets = {k: reduce([(*t['terms'], t['gate']) for t in s['ts'] if t['type'] == k], out, sup) if out else None
                for k, sup in (('N', 'GND'), ('P', 'VDD'))}
        gates = [g for k in 'NP' if nets[k] for g in leaves(tree(nets[k], str))] + sorted((t['gate'] for t in s['ts']), key=natural)
        letters = iter('abcdefgh')
        for g in dict.fromkeys(gates):
            if g not in role:
                role[g] = next(letters)
        mids = sorted({n for t in s['ts'] for n in t['terms']} - set(role), key=natural)
        role.update({n: f'm{k}' for k, n in enumerate(mids)})
        sw = {k: reduce([(*t['terms'], t['id']) for t in s['ts'] if t['type'] == k], out, sup) if out else None
              for k, sup in (('N', 'GND'), ('P', 'VDD'))}
        order = [i for k in 'PN' if sw[k] for i in leaves(tree(sw[k], str))]
        order += [i for i in ts if i not in order]
        info.update(n=tree(nets['N'], role.get) if nets['N'] else None, p=tree(nets['P'], role.get) if nets['P'] else None)
    tr = {i: f't{k}' for k, i in enumerate(order)}
    if s['kind'] != 'tg' and s['out']:
        info.update({f'{k.lower()}sw': tree(x, tr.get) for k, sup in (('N', 'GND'), ('P', 'VDD'))
                     if (x := reduce([(*t['terms'], t['id']) for t in s['ts'] if t['type'] == k], s['out'], sup))})
    info['ts'] = {tr[i]: {'type': ts[i]['type'], 'weak': ts[i]['weak'], 'gate': role[ts[i]['gate']],
                          'a': role[ts[i]['terms'][0]], 'b': role[ts[i]['terms'][1]]} for i in order}
    info['ports'] = sorted(set(role.values()) - set(SUP), key=lambda r: (r[0] in 'mt', natural(r)))
    return info, role, tr


def clocks(ts, x2, fixed):
    """Nets on a path of ordinary gates from x2 to a transmission gate's gate; ts: [(type, gate, a, b)].
    A transmission gate is a PMOS and an NMOS sharing both terminals; an ordinary gate is any other transistor."""
    pairs = {(t[0], frozenset(t[2:])) for t in ts}
    fwd, back, tg_gates = {}, {}, set()
    for t in ts:
        if ({'N': 'P', 'P': 'N'}.get(t[0]), frozenset(t[2:])) in pairs:
            tg_gates.add(t[1])
            continue
        for n in t[2:]:
            if n not in fixed:
                fwd.setdefault(t[1], set()).add(n)
                back.setdefault(n, set()).add(t[1])

    def reach(starts, edges):
        seen, todo = set(starts), list(starts)
        while todo:
            for m in edges.get(todo.pop(), set()) - seen:
                seen.add(m)
                todo.append(m)
        return seen
    return reach([x2], fwd) & reach(tg_gates, back)


def main():
    die = json.load(open(netlist.DIE))
    find = propose.joined(die)
    d = netlist.Die(die['shapes'])
    raw = netlist.transistors(die)
    pieces = [p for c in d.of('channel') for p in d.pieces(c)]
    at = {f"{t['channel']}.{t['piece']}": [round(p.centroid.x), round(p.centroid.y)] for t, p in zip(raw, pieces)}
    cs = hier.cells(die)
    names = hier.net_names(die, cs) | {find(p['name']): p['name'] for p in die['pins']}   # a package pin's name wins
    stype = die['types']['stages']

    keys = sorted({find(n) for t in raw for n in [t['gate'], *t['terms']]} | {find(p['name']) for p in die['pins']}, key=natural)
    idx = {n: i for i, n in enumerate(keys)}
    cell_ix = {c['name']: i for i, c in enumerate(cs)}
    owner = {x: c['name'] for c in die['cells'] for x in c['transistors']}
    ts = [{'id': f"{t['channel']}.{t['piece']}", 'type': t['type'], 'gate': idx[find(t['gate'])],
           'a': idx[find(t['terms'][0])], 'b': idx[find(t['terms'][1])], 'ohms': OHMS[t['weak']],
           'cell': cell_ix[owner[f"{t['channel']}.{t['piece']}"]], 'at': at[f"{t['channel']}.{t['piece']}"]} for t in raw]
    tix = {t['id']: i for i, t in enumerate(ts)}

    # Types: the first copy of each names roles; other copies map onto it, a stage through its cell's mapping.
    types = {'stage': {}, 'cell': {}}
    stages, cells = [], []
    ref = {}   # cell type -> (first cell, its stages' (role map, transistor map) by stage index in the cell)
    for ci, c in enumerate(cs):
        g = propose.cell_graph(c)
        if c['type'] not in ref:
            ext = c['ext']
            outs = sorted({s['out'] for s in c['stages'] if s['out'] in ext}, key=natural)
            ins = sorted(ext - set(outs), key=natural)
            own = sorted({n for t in c['ts'] for n in [t['gate'], *t['terms']]} - ext - set(SUP), key=natural)
            crole = {n: n for n in SUP} | {n: f'in{k}' for k, n in enumerate(ins)} | \
                {n: f'out{k}' for k, n in enumerate(outs)} | {n: f'n{k}' for k, n in enumerate(own)}
            parts = []
            for k, s in enumerate(c['stages']):
                name = stype[propose.fingerprint(propose.graph(s))]
                if name not in types['stage']:
                    info, srole, tr = stage_type(s)
                    types['stage'][name] = info | {'ref': s}
                sref = types['stage'][name]['ref']
                if sref is s:
                    _, srole, tr = stage_type(s)
                else:   # this stage's nets and transistors by the type's roles
                    m = mapping(propose.graph(sref), propose.graph(s))
                    _, r0, t0 = stage_type(sref)
                    srole = {m[('net', n)][1]: r for n, r in r0.items() if ('net', n) in m} | {n: n for n in SUP}
                    tr = {m[i]: r for i, r in t0.items()}
                parts.append({'role': f's{k}', 'type': name,
                              'ports': {r: crole[n] for n, r in srole.items() if n not in SUP}, 'tr': tr})
            types['cell'][c['type']] = {'ins': [crole[n] for n in ins], 'outs': [crole[n] for n in outs],
                                        'storage': sorted(crole[n] for n in c['storage']),
                                        'stages': [{k: v for k, v in p.items() if k != 'tr'} for p in parts]}
            ref[c['type']] = (c, g, crole, parts)
            m = {('net', n): ('net', n) for n in crole} | {t['id']: t['id'] for t in c['ts']}
        else:
            c0, g0, crole0, parts0 = ref[c['type']]
            m = mapping(g0, g)
        c0, g0, crole0, parts0 = ref[c['type']]
        nets = {r: idx[find(m[('net', n)][1])] for n, r in crole0.items() if n not in SUP and ('net', n) in m}
        mine = []
        for p in parts0:
            mine.append(len(stages))
            stages.append({'type': p['type'], 'cell': ci, 'role': p['role'],
                           'nets': {r: nets[cr] for r, cr in p['ports'].items()},
                           'ts': {r: [tix[x] for x in m[i].split('+')] for i, r in p['tr'].items()}})
        xs = [at[x] for t in c['ts'] for x in t['id'].split('+')]
        cells.append({'name': c['name'], 'type': c['type'], 'block': c['block'], 'nets': nets, 'stages': mine,
                      'at': [round(sum(p[0] for p in xs) / len(xs)), round(sum(p[1] for p in xs) / len(xs))],
                      'box': [min(p[0] for p in xs), min(p[1] for p in xs), max(p[0] for p in xs), max(p[1] for p in xs)]})
    for t in types['stage'].values():
        del t['ref']

    pin_nets = {idx[find(p['name'])] for p in die['pins']}
    blocks = []
    for b in die['blocks']:
        mine = [cell_ix[c] for c in b['cells']]
        inside = {n for i in mine for n in cells[i]['nets'].values()}
        outside = {n for i, c in enumerate(cells) if i not in mine for n in c['nets'].values()}
        boxes = [cells[i]['box'] for i in mine]
        blocks.append({'name': b['name'], 'cells': mine, 'ports': sorted(inside & (outside | pin_nets)),
                       'box': [min(x[0] for x in boxes), min(x[1] for x in boxes), max(x[2] for x in boxes), max(x[3] for x in boxes)]})

    plate = netlist.nets(die)
    caps = [{'a': idx[find(plate[c['plates'][0]])], 'b': idx[find(plate[c['plates'][1]])], 'farads': c['farads'],
             'note': c['source']} for c in die['values']['capacitors']]
    caps += [{'a': idx[find(c['pin'])], 'b': idx['GND'], 'farads': c['farads'], 'note': c['source']}
             for c in die['values']['pad_capacitance']]

    clk = clocks([(t['type'], find(t['gate']), find(t['terms'][0]), find(t['terms'][1])) for t in raw],
                 find('X2'), {find(n) for n in SUP})
    out = {
        'format': 'netlist/2', 'name': 'MC14500B', 'volts': VOLTS,
        'nets': [{'key': n, 'name': names.get(n, n)} for n in keys],
        'gnd': idx['GND'], 'vdd': idx['VDD'],
        'pins': {p['name']: idx[find(p['name'])] for p in die['pins'] if p['name'] not in SUP},
        'clocks': sorted(idx[n] for n in clk),
        'transistors': ts, 'resistors': [], 'capacitors': caps, 'diodes': [],
        'types': types, 'blocks': blocks, 'cells': cells, 'stages': stages,
        'die': {'w': die['size'][0], 'h': die['size'][1], 'pins': {p['name']: p['at'] for p in die['pins']}},
    }
    path = os.path.join(HERE, '..', 'site', 'gen', 'mc14500b.js')
    with open(path, 'w') as f:
        f.write('// Written by extract/build.py.\n(globalThis.NETLISTS ??= {}).mc14500b = '
                + json.dumps(out, separators=(',', ':')) + ';\n')
    print(f"{path}: {len(keys)} nets, {len(ts)} transistors, {len(caps)} capacitors, {len(stages)} stages "
          f"({len(types['stage'])} types), {len(cells)} cells ({len(types['cell'])} types), {len(blocks)} blocks")


if __name__ == '__main__':
    main()
