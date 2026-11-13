#!/usr/bin/env python3
"""Proposes the next layer of the circuit hierarchy from die.json, for review; prints each proposed type with its
parts and copy count, adds one viewer problem per copy (kind proposal-<type>) to extract/problems.json, and draws each
type's schematic in extract/proposals.html; types recorded in die.json's types (extract/hier.py) are only counted, under
their recorded names.

stages: transistors into stages. A transmission gate is an N and a P transistor joining the same two nets, neither a
supply. Every other stage is an output net and the transistors joining it to the supplies through series nets (nets
no gate reads, not a pad, touched by one transistor type), strong and weak transistors apart, and inverters sharing
an output split apart; a transistor in no such
path is a pass transistor. Transistors of one type and strength joining the same two nets, with one gate, are one
transistor: a wide transistor drawn in parts. A resistor's ends are one net here, as py/sim.py's load_die(strips=True) has them.
Stages with the same wiring (graph isomorphism: transistors by type and strength, nets by role) are one type.
Run from the repo root: python3 extract/propose.py stages; then open annotate_nets/index.html?die&only=proposal-<type>.
"""
import collections
import json
import os
import sys

import networkx as nx

import cells
import check
import schematic
from netlist import DIE, Die, resistors, transistors

HERE = os.path.dirname(os.path.abspath(__file__))
from logic import conducts, leaves, reduce

SUP = ('GND', 'VDD')


def joined(die):
    """{net: net}, joining each resistor's ends; a supply or pin name wins, else the first name."""
    pins = {p['name'] for p in die['pins']}
    rank = lambda n: (n not in SUP, n not in pins, n)
    to = {}
    find = lambda n: find(to[n]) if n in to else n
    for r in resistors(die):
        a, *rest = sorted(map(find, r['ends']), key=rank)
        for b in rest:
            if b != a:
                to[b] = a
    return find


def stages(die):
    """[{kind, out, ts}]: kind tg, cmos, tri or pass; out the output net (None for tg and pass); ts the transistors,
    each {id, type, weak, gate, terms}."""
    find = joined(die)
    ts = {}
    for t in transistors(die):   # parallel transistors (one type, strength, gate and pair of terminals) are one
        terms = [find(n) for n in t['terms']]
        k = (t['type'], t['weak'], find(t['gate']), frozenset(terms)) if len(set(terms)) == 2 else id(t)
        tid = f"{t['channel']}.{t['piece']}"
        if k in ts:
            ts[k]['id'] += '+' + tid
            ts[k]['channels'].append(t['channel'])
        else:
            ts[k] = {'id': tid, 'channel': t['channel'], 'channels': [t['channel']], 'type': t['type'],
                     'weak': t['weak'], 'gate': find(t['gate']), 'terms': terms}
    ts = list(ts.values())
    pins = {find(p['name']) for p in die['pins']}
    gates = {t['gate'] for t in ts}
    out, left = [], []
    pairs = collections.defaultdict(list)
    for t in ts:
        if not t['weak'] and not set(t['terms']) & set(SUP) and len(set(t['terms'])) == 2:
            pairs[frozenset(t['terms'])].append(t)
    tg = set()
    for xs in pairs.values():
        ns, ps = [t for t in xs if t['type'] == 'N'], [t for t in xs if t['type'] == 'P']
        for n, p in zip(ns, ps):
            out.append({'kind': 'tg', 'out': None, 'ts': [n, p]})
            tg |= {n['id'], p['id']}
    for weak in (False, True):
        mine = [t for t in ts if t['weak'] == weak and t['id'] not in tg]
        types = collections.defaultdict(set)
        for t in mine:
            for n in t['terms']:
                types[n].add(t['type'])
        series = {n for n in types if n not in gates | pins | set(SUP) and len(types[n]) == 1}
        claimed = set()
        for o in sorted({n for t in mine for n in t['terms']} - series - set(SUP)):
            seen, todo, st = {o}, [o], []
            while todo:
                m = todo.pop()
                for t in mine:
                    if m in t['terms'] and t['id'] not in claimed:
                        claimed.add(t['id'])
                        st.append(t)
                        n = t['terms'][1] if t['terms'][0] == m else t['terms'][0]
                        if n in series and n not in seen:
                            seen.add(n)
                            todo.append(n)
            if not st:
                continue
            used = set()
            nets = {}
            for typ, sup in (('N', 'GND'), ('P', 'VDD')):
                x = reduce([(*t['terms'], t['id']) for t in st if t['type'] == typ], o, sup)
                nets[typ] = x
                used |= leaves(x) if x is not None else set()
            for t in st:
                if t['id'] not in used:
                    left.append(t)
            st = [t for t in st if t['id'] in used]
            for part in inverters(st, o) if st else []:
                kind = 'cmos' if any(t['type'] == 'N' for t in part) and any(t['type'] == 'P' for t in part) \
                    and complementary(part, o) else 'tri'
                out.append({'kind': kind, 'out': o, 'ts': part})
        left += [t for t in mine if t['id'] not in claimed]
    for t in left:
        out.append({'kind': 'pass', 'out': None, 'ts': [t]})
    return out


def inverters(st, o):
    """st split into one inverter per gate net when it is only inverters sharing output o (each gate an N from o to
    GND and a P from o to VDD), as a Schmitt trigger's two feedback inverters are; else [st]."""
    by = collections.defaultdict(list)
    for t in st:
        by[t['gate']].append(t)
    if len(by) > 1 and all(sorted((t['type'], *sorted(t['terms'])) for t in ts) ==
                           sorted([('N', *sorted((o, 'GND'))), ('P', *sorted((o, 'VDD')))]) for ts in by.values()):
        return list(by.values())
    return [st]


def complementary(st, o):
    """Whether the stage's P network conducts exactly when its N network does not, for every input."""
    nx_ = reduce([(*t['terms'], t['gate']) for t in st if t['type'] == 'N'], o, 'GND')
    px = reduce([(*t['terms'], t['gate']) for t in st if t['type'] == 'P'], o, 'VDD')
    vs = sorted(leaves(nx_) | leaves(px))
    if len(vs) > 8:
        return False
    for k in range(2 ** len(vs)):
        val = {v: k >> i & 1 for i, v in enumerate(vs)}
        if conducts(nx_, val, False) == conducts(px, val, True):
            return False
    return True


def graph(s):
    """s as a graph: a node per transistor (type, strength) and per net (role: out, a supply, mid, or in).
    A gate on a supply is an ordinary input, so an inverter with its input tied low is an inverter."""
    g = nx.Graph()
    gates = {t['gate'] for t in s['ts']}
    role = lambda n: n if n in SUP else 'out' if n == s['out'] else \
        'mid' if s['out'] is not None and n not in gates else 'in'
    for t in s['ts']:
        g.add_node(t['id'], label=f"{t['type']}{'w' if t['weak'] else ''}")
        for n, edge in [(t['gate'], 'g')] + [(n, 't') for n in t['terms']]:
            node, lab = (('tied', n), 'in') if edge == 'g' and n in SUP else (('net', n), role(n))
            g.add_node(node, label=lab)
            if g.has_edge(t['id'], node):
                g.edges[t['id'], node]['label'] += edge
            else:
                g.add_edge(t['id'], node, label=edge)
    return g


def name(s):
    """A proposed type name: tg, pass_n, inv, nand2, nor3, aoi21, oai22, tri_<n>_<p>, with a weak_ prefix."""
    if s['kind'] == 'tg':
        return 'tg'
    if s['kind'] == 'pass':
        return f"pass_{s['ts'][0]['type'].lower()}"
    nx_ = reduce([(*t['terms'], t['gate']) for t in s['ts'] if t['type'] == 'N'], s['out'], 'GND')
    px = reduce([(*t['terms'], t['gate']) for t in s['ts'] if t['type'] == 'P'], s['out'], 'VDD')
    weak = 'weak_' if all(t['weak'] for t in s['ts']) else ''

    def shape(x):
        if x is None:
            return '0'
        if isinstance(x, str):
            return '1'
        if all(isinstance(y, str) for y in x[1]):
            return ('s' if x[0] == 'and' else 'p') + str(len(x[1]))
        return ('s' if x[0] == 'and' else 'p') + '(' + ','.join(shape(y) for y in x[1]) + ')'
    if s['kind'] == 'tri':
        return f"{weak}tri_n{shape(nx_)}_p{shape(px)}"
    if isinstance(nx_, str):
        return weak + 'inv'
    if all(isinstance(y, str) for y in nx_[1]):
        return weak + ('nand' if nx_[0] == 'and' else 'nor') + str(len(nx_[1]))
    sizes = sorted((1 if isinstance(y, str) else len(y[1]) for y in nx_[1]), reverse=True)
    if all(isinstance(z, str) for y in nx_[1] if not isinstance(y, str) for z in y[1]):
        return weak + ('aoi' if nx_[0] == 'or' else 'oai') + ''.join(map(str, sizes))
    return weak + 'cmos_' + shape(nx_)


def fingerprint(g):
    """A hash of graph g's wiring (Weisfeiler-Lehman, on node and edge labels): die.json's key for a type."""
    return nx.weisfeiler_lehman_graph_hash(g, node_attr='label', edge_attr='label')


def types(ss, graph=graph, name=name):
    """[(name, [stages])] grouping ss by graph isomorphism, most copies first; graph and name as for stages."""
    buckets = collections.defaultdict(list)
    for s in ss:
        g = graph(s)
        buckets[nx.weisfeiler_lehman_graph_hash(g, node_attr='label', edge_attr='label')].append((s, g))
    groups = []
    match = dict(node_match=lambda a, b: a['label'] == b['label'], edge_match=lambda a, b: a['label'] == b['label'])
    for items in buckets.values():
        mine = []
        for s, g in items:
            for grp in mine:
                if nx.is_isomorphic(grp[0][1], g, **match):
                    grp.append((s, g))
                    break
            else:
                mine.append([(s, g)])
        groups += [[s for s, _ in grp] for grp in mine]
    named = collections.defaultdict(list)
    for grp in sorted(groups, key=len, reverse=True):
        named[name(grp[0])].append(grp)
    out = []
    for n, grps in named.items():
        for k, grp in enumerate(grps):
            out.append((n if len(grps) == 1 else f'{n}_{chr(97 + k)}', grp))
    return sorted(out, key=lambda x: (-len(x[1]), x[0]))


def cell_list(die):
    """[{kind 'cell', name, stages, ts, ext, storage, out None}]: extract/cells.py's grouping of the approved stages.
    ext holds the cell's nets that pads or other cells' transistors touch; storage its storage nodes."""
    ss = stages(die)
    recorded = die['types']['stages']
    kind = {}
    for typ, grp in types(ss):
        for s in grp:
            kind[id(s)] = recorded.get(fingerprint(graph(s)), typ)
    kinds = [kind[id(s)] for s in ss]
    find = joined(die)
    pins = {find(p['name']) for p in die['pins']} - set(SUP)
    strong = {s['out'] for s, k in zip(ss, kinds) if s['out'] and not all(t['weak'] for t in s['ts']) and k != 'gated_pullup'}
    out = []
    for ms in cells.group(ss, kinds, pins):
        mine = [ss[i] for i in ms]
        ids = {t['id'] for s in mine for t in s['ts']}
        nets = {n for s in mine for t in s['ts'] for n in [t['gate'], *t['terms']]}
        outside = {n for s in ss for t in s['ts'] if t['id'] not in ids for n in [t['gate'], *t['terms']]}
        storage = {x for s in mine if s['kind'] == 'tg' for x in s['ts'][0]['terms']} - strong - set(SUP)
        out.append({'kind': 'cell', 'out': None, 'stages': mine, 'kinds': [kinds[i] for i in ms],
                    'ts': [t for s in mine for t in s['ts']], 'ext': (nets & (outside | pins)) - set(SUP),
                    'storage': storage, 'name': cells.name(ms, ss, kinds, storage)})
    return out


def cell_graph(c):
    """c as a graph, as graph() draws a stage: nets by role, a supply, ext (other cells or a pad reach it) or int."""
    g = nx.Graph()
    for t in c['ts']:
        g.add_node(t['id'], label=f"{t['type']}{'w' if t['weak'] else ''}")
        for n, edge in [(t['gate'], 'g')] + [(n, 't') for n in t['terms']]:
            node, lab = (('tied', n), 'ext') if edge == 'g' and n in SUP else \
                (('net', n), n if n in SUP else 'ext' if n in c['ext'] else 'int')
            g.add_node(node, label=lab)
            if g.has_edge(t['id'], node):
                g.edges[t['id'], node]['label'] += edge
            else:
                g.add_edge(t['id'], node, label=edge)
    return g


def main():
    layer = sys.argv[1] if len(sys.argv) > 1 else 'stages'
    assert layer in ('stages', 'cells'), f'layer {layer}: only stages and cells so far'
    die = json.load(open(DIE))
    d = Die(die['shapes'])
    cell = {int(x.split('.')[0]): c['name'] for c in die['cells'] for x in c['transistors']}
    ss = stages(die)
    n_ts = sum(len(t['channels']) for s in ss for t in s['ts'])
    print(f"{len(ss)} stages from {n_ts} transistors, {sum(len(s['ts']) for s in ss)} after joining parallel ones")
    problems = [p for p in check.run(die) if not p['kind'].startswith('proposal-')]
    if layer == 'cells':
        cs = cell_list(die)
        print(f'{len(cs)} cells')
        found = types(cs, cell_graph, lambda c: c['name'])
    else:
        found = types(ss)
    recorded = die['types'][layer]
    key = lambda grp: fingerprint(cell_graph(grp[0]) if layer == 'cells' else graph(grp[0]))
    done = [(recorded[key(grp)], len(grp)) for typ, grp in found if key(grp) in recorded]
    found = [(typ, grp) for typ, grp in found if key(grp) not in recorded]
    print('approved:', ', '.join(f'{typ} ({n})' for typ, n in done))
    with open(os.path.join(HERE, 'proposals.html'), 'w') as f:
        f.write(schematic.cell_page(found, done) if layer == 'cells' else schematic.page(found, cell, done))
    for typ, grp in found:
        s = grp[0]
        parts = collections.Counter(f"{t['type']}{' weak' if t['weak'] else ''}" for t in s['ts'])
        where = collections.Counter(cell.get(t['channel'], '?') for g in grp for t in g['ts'][:1])
        print(f"{typ:16} {len(grp):3} copies; {', '.join(f'{v} {k}' for k, v in sorted(parts.items()))}; "
              f"in cells {', '.join(sorted(where))}" + (f"; stages {'+'.join(sorted(s['kinds']))}" if layer == 'cells' else ''))
        for g in grp:
            chans = sorted({c for t in g['ts'] for c in t['channels']})
            x0, y0, x1, y1 = (f(d.geo[c].bounds[i] for c in chans) for i, f in enumerate((min, min, max, max)))
            problems.append({'kind': f'proposal-{typ}', 'at': [int((x0 + x1) / 2), int((y0 + y1) / 2)],
                             'note': f"{typ}: out {g['out']}; " + ', '.join(
                                 f"{t['id']} {t['type']}{'w' if t['weak'] else ''} gate {t['gate']}" for t in g['ts']),
                             'ids': chans, 'rect': [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]})
    problems.sort(key=lambda p: (p['at'][1] // 100, p['at'][0]))
    with open(check.OUT + '.tmp', 'w') as f:
        json.dump({'windows': check.windows(problems)}, f, indent=1)
    os.replace(check.OUT + '.tmp', check.OUT)
    print(f'wrote {os.path.relpath(check.OUT)} and extract/proposals.html')


if __name__ == '__main__':
    main()
