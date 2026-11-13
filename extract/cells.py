"""Groups extract/propose.py's stages into cells, for review; the rules join stages until none applies.

1. Storage: a storage node is a transmission gate terminal no strong stage drives. Its transmission
   gates, the stages driving it (weak inverter, gated pullup), and the stages on its loop (two stages at most from
   the node back to it, or to a transmission gate's other terminal) are one cell: a latch.
2. Master-slave: two cells join when a net of one is read only by itself and by the other's transmission gate.
3. Weak feedback onto a strongly driven net (a Schmitt trigger) joins the net's driver and the feedback's drivers.
4. An inverter joins the cell holding every reader of its output, when that cell has a split_inv or mux2_inv: their
   enable or select inverters, and data inverters read by them alone. Flip-flops take none: their clock and data
   inverters stay cells of their own.
5. A one-stage cell whose output only one inverter reads joins it: NOR + inverter is OR2, NAND + inverter AND2.
6. A cell whose outputs only the cell holding a split_inv reads joins that cell: the tri-state driver's gating.
Rules 2 and 6 look only at a cell's outputs: nets its own stages drive.
"""
import collections

SUP = ('GND', 'VDD')
DRIVES = ('split_inv', 'mux2_inv')   # stages around which rule 4 gathers a cell


class Union:
    def __init__(self, n):
        self.p = list(range(n))

    def root(self, i):
        while self.p[i] != i:
            self.p[i] = self.p[self.p[i]]
            i = self.p[i]
        return i

    def join(self, a, b):
        a, b = self.root(a), self.root(b)
        if a != b:
            self.p[a] = b
            return True
        return False


def group(ss, kind, pins):
    """[[stage index]] grouping stages ss, whose approved type names are kind[i]; pins are pad nets."""
    n = len(ss)
    u = Union(n)
    weak = [all(t['weak'] for t in s['ts']) for s in ss]
    drivers, readers, tg_on = collections.defaultdict(set), collections.defaultdict(set), collections.defaultdict(set)
    for i, s in enumerate(ss):
        if s['out']:
            drivers[s['out']].add(i)
        for t in s['ts']:
            readers[t['gate']].add(i)
        if s['kind'] == 'tg':
            for x in s['ts'][0]['terms']:
                tg_on[x].add(i)
    strong = {s['out'] for i, s in enumerate(ss) if s['out'] and not weak[i] and kind[i] != 'gated_pullup'}
    outs = lambda i: {ss[i]['out']} if ss[i]['out'] else set(ss[i]['ts'][0]['terms'])

    # 1. Storage nodes and their loops.
    for node in set(tg_on) - strong - set(SUP):
        mine = tg_on[node] | drivers[node]
        ends = {node} | {x for i in tg_on[node] for x in ss[i]['ts'][0]['terms']}
        for a in readers[node] - mine:   # a reads the node; a loop returns through a, or a and one more stage
            if outs(a) & ends or any(outs(a) & {t['gate'] for t in ss[i]['ts']} for i in drivers[node]):
                mine.add(a)
            for b in set().union(*(readers[o] for o in outs(a))) - mine:
                if outs(b) & ends or any(outs(b) & {t['gate'] for t in ss[i]['ts']} for i in drivers[node]):
                    mine |= {a, b}
        for i in mine:
            u.join(i, next(iter(mine)))

    # 3. Weak feedback onto a strongly driven net.
    for i, s in enumerate(ss):
        if weak[i] and s['out'] in strong and s['out'] not in pins:
            for j in drivers[s['out']] | set().union(*(drivers[t['gate']] for t in s['ts'])):
                u.join(i, j)

    def cells():
        out = collections.defaultdict(list)
        for i in range(n):
            out[u.root(i)].append(i)
        return out

    changed = True
    while changed:
        changed = False
        cs = cells()
        of = {i: r for r, ms in cs.items() for i in ms}
        nets = {r: {ss[i]['out'] for i in ms if ss[i]['out']} for r, ms in cs.items()}
        reads = lambda net: {of[i] for i in readers[net]} | {of[i] for i in tg_on[net]}
        kinds = {r: {kind[i] for i in ms} for r, ms in cs.items()}
        has = lambda r, ks: bool(kinds[r] & set(ks))
        for r, ms in cs.items():
            if changed:
                break
            ext = {x: reads(x) - {r} for x in nets[r] - set(SUP) - pins}
            # 2. Master-slave: a net of r read only by r and one other cell's transmission gate.
            if 'tg' in kinds[r]:
                for x, rs in ext.items():
                    if len(rs) == 1 and any(of[i] in rs for i in tg_on[x]) and 'tg' in kinds[next(iter(rs))]:
                        changed = u.join(r, next(iter(rs)))
            # 4. An inverter whose readers are all in one cell with a driver stage.
            if not changed and len(ms) == 1 and kind[ms[0]] == 'inv' and ss[ms[0]]['out'] not in pins:
                rs = ext[ss[ms[0]]['out']]
                if len(rs) == 1 and has(next(iter(rs)), DRIVES):
                    changed = u.join(r, next(iter(rs)))
            # 5. A one-stage cell read only by one inverter.
            if not changed and len(ms) == 1 and ss[ms[0]]['out'] and ss[ms[0]]['out'] not in pins:
                rd = readers[ss[ms[0]]['out']] | tg_on[ss[ms[0]]['out']]
                if len(rd) == 1 and kind[next(iter(rd))] == 'inv' and len(cs[of[next(iter(rd))]]) == 1:
                    changed = u.join(r, of[next(iter(rd))])
            # 6. A cell whose outputs only a split_inv reads, at that stage's gates.
            if not changed and ext and not has(r, ('tg',) + DRIVES):
                rd = {i for x in ext for i in readers[x] | tg_on[x] if of[i] != r}
                if len({of[i] for i in rd}) == 1 and has(of[next(iter(rd))], ('split_inv',)):
                    changed = u.join(r, of[next(iter(rd))])
    return sorted(cells().values(), key=min)


def name(ms, ss, kind, storage):
    """A proposed cell type name from its stages' approved names."""
    ks = collections.Counter(kind[i] for i in ms)
    k = len(storage)
    if k:
        base = {1: 'latch', 2: 'dff'}.get(k, f'storage{k}')
        return base + ('_set' if ks['gated_pullup'] else '')
    if ks['split_inv']:
        return 'tristate_out'
    if ks['mux2_inv']:
        return 'mux2'
    if ks['weak_inv']:
        return 'schmitt'
    if len(ms) == 1:
        return kind[ms[0]]
    if len(ms) == 2 and ks['inv']:
        other = next(kind[i] for i in ms if kind[i] != 'inv' or ks['inv'] == 2)
        return {'nor2': 'or2', 'nand2': 'and2', 'inv': 'buf', 'nor4': 'or4'}.get(other, other + '+inv')
    return '+'.join(sorted(kind[i] for i in ms))
