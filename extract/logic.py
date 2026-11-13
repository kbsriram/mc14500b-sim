"""Series-parallel expressions of a CMOS stage's switch networks, for extract/propose.py and extract/build.py."""
import collections


def reduce(edges, a, b):
    """Series-parallel reduction of edges [(net, net, expr)] to one expression between a and b.
    expr is a gate net, ('and', [exprs]) or ('or', [exprs]); None if a and b are not joined."""
    edges = [e for e in edges if e[0] != e[1]]

    def join(op, xs):
        return (op, [y for x in xs for y in (x[1] if isinstance(x, tuple) and x[0] == op else [x])])
    while True:
        par = collections.defaultdict(list)
        for u, v, x in edges:
            par[frozenset((u, v))].append(x)
        if any(len(xs) > 1 for xs in par.values()):
            edges = [(*sorted(k), xs[0] if len(xs) == 1 else join('or', xs)) for k, xs in par.items()]
            continue
        deg = collections.Counter(n for u, v, _ in edges for n in (u, v))
        mid = next((n for n, d in deg.items() if n not in (a, b) and d <= 2), None)
        if mid is None:
            break
        mine = [e for e in edges if mid in e[:2]]
        edges = [e for e in edges if mid not in e[:2]]
        if len(mine) == 2:
            ends = [e[1] if e[0] == mid else e[0] for e in mine]
            edges.append((ends[0], ends[1], join('and', [e[2] for e in mine])))
    if not edges:
        return None
    assert len(edges) == 1 and {edges[0][0], edges[0][1]} == {a, b}, f'not series-parallel: {edges}'
    return edges[0][2]


def leaves(x):
    return {x} if isinstance(x, str) else set().union(*map(leaves, x[1]))


def conducts(x, val, low):
    """Whether network x conducts; low: its switches are PMOS, on while their gate is low."""
    if isinstance(x, str):
        return val[x] != low
    return (all if x[0] == 'and' else any)(conducts(y, val, low) for y in x[1])
