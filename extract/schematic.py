"""Transistor-level schematics, as SVG, of extract/propose.py's stages.

A stage's P network is drawn from VDD down to its output and its N network from the output down to GND; a
transmission gate or pass transistor is drawn between its two terminals. Each network is split into series and
parallel parts in the order the nets join them: series parts stack top to bottom, parallel parts sit side by side.
"""
import collections
import html

U = 90   # px per transistor, down
UX = 130   # px per transistor, across: room for the gate lead and the type label
LEAD = 34   # px; gate lead length, left of the channel


def sp(edges, a, b):
    """Series-parallel tree of edges [(u, v, id)] from net a to net b: an id, ('and', [trees, a to b in order]) or
    ('or', [trees]); None if a and b are not joined. Nets other than a and b with one edge are dropped."""
    def flip(x):
        if isinstance(x, str):
            return x
        return (x[0], [flip(y) for y in (reversed(x[1]) if x[0] == 'and' else x[1])])

    def join(op, xs):
        return (op, [z for x in xs for z in (x[1] if not isinstance(x, str) and x[0] == op else [x])])
    edges = [e for e in edges if e[0] != e[1]]
    while True:
        par = collections.defaultdict(list)
        for u, v, x in edges:
            par[frozenset((u, v))].append((u, v, x))
        if any(len(es) > 1 for es in par.values()):
            edges = []
            for es in par.values():
                u, v, _ = es[0]
                xs = [x if (p, q) == (u, v) else flip(x) for p, q, x in es]
                edges.append((u, v, xs[0] if len(xs) == 1 else join('or', xs)))
            continue
        deg = collections.Counter(n for u, v, _ in edges for n in (u, v))
        mid = next((n for n, k in deg.items() if n not in (a, b) and k <= 2), None)
        if mid is None:
            break
        mine = [e for e in edges if mid in e[:2]]
        edges = [e for e in edges if mid not in e[:2]]
        if len(mine) == 2:
            (p, m1, x), (m2, q, y) = [(e if e[1] == mid else (e[1], e[0], flip(e[2]))) for e in mine[:1]] + \
                [(e if e[0] == mid else (e[1], e[0], flip(e[2]))) for e in mine[1:]]
            edges.append((p, q, join('and', [x, y])))
    if not edges:
        return None
    (u, v, x), = edges
    return x if (u, v) == (a, b) else flip(x)


def size(x):
    """(width, height) of tree x in transistors."""
    if x is None:
        return 0, 0
    if isinstance(x, str):
        return 1, 1
    ws, hs = zip(*map(size, x[1]))
    return (max(ws), sum(hs)) if x[0] == 'and' else (sum(ws), max(hs))


class Drawing:
    def __init__(self, ts, gate_name):
        self.ts, self.gate_name, self.out = ts, gate_name, []

    def line(self, *pts, dash=False, width=1.5):
        d = ' '.join(f'{x:.0f},{y:.0f}' for x, y in pts)
        self.out.append(f'<polyline points="{d}" fill="none" stroke="currentColor" stroke-width="{width}"'
                        + (' stroke-dasharray="4 3"' if dash else '') + '/>')

    def text(self, x, y, s, anchor='middle', cls=''):
        self.out.append(f'<text x="{x:.0f}" y="{y:.0f}" text-anchor="{anchor}" class="{cls}">{html.escape(s)}</text>')

    def transistor(self, i, cx, y):
        """Transistor i between (cx, y) and (cx, y + U)."""
        t = self.ts[i]
        weak = t['weak']
        ch = cx - 10
        self.line((cx, y), (cx, y + .3 * U), (ch, y + .3 * U))
        self.line((ch, y + .7 * U), (cx, y + .7 * U), (cx, y + U))
        self.line((ch, y + .25 * U), (ch, y + .75 * U), dash=weak, width=3)
        g = ch - 8
        self.line((g, y + .3 * U), (g, y + .7 * U), width=2)
        lead = g - (8 if t['type'] == 'P' else 0)
        if t['type'] == 'P':
            self.out.append(f'<circle cx="{g - 4}" cy="{y + U / 2:.0f}" r="4" fill="none" stroke="currentColor"'
                            ' stroke-width="1.5"/>')
        self.line((lead, y + U / 2), (g - LEAD, y + U / 2))
        self.text(g - LEAD - 3, y + U / 2 + 4, self.gate_name(t['gate']), 'end', 'gate')
        self.text(cx + 6, y + U / 2 + 4, f"{t['type']}{' weak' if weak else ''}", 'start', 'id')

    def tree(self, x, x0, y0, w):
        """Tree x in the box from (x0, y0), w transistors wide; its ends at the box's top and bottom centre."""
        cx = x0 + w * UX / 2
        if isinstance(x, str):
            self.transistor(x, cx, y0)
            return
        h = size(x)[1]
        if x[0] == 'and':
            y = y0
            for c in x[1]:
                self.tree(c, x0, y, w)
                y += size(c)[1] * U
            return
        xs, left = [], x0 + (w - size(x)[0]) * UX / 2
        for c in x[1]:
            cw, chh = size(c)
            self.tree(c, left, y0, cw)
            ccx = left + cw * UX / 2
            if chh < h:
                self.line((ccx, y0 + chh * U), (ccx, y0 + h * U))
            xs.append(ccx)
            left += cw * UX
        self.line((min(xs), y0), (max(xs), y0))
        self.line((min(xs), y0 + h * U), (max(xs), y0 + h * U))

    def node(self, cx, y, label, side='start'):
        self.out.append(f'<circle cx="{cx:.0f}" cy="{y:.0f}" r="3" fill="currentColor"/>')
        self.text(cx + (10 if side == 'start' else -10), y - 6, label, side, 'net')


def svg(s, real=False):
    """(SVG of stage s, {letter: net}): its gate inputs lettered a, b, ... in drawing order, or, with real, its
    inputs and output labelled with their net names."""
    ts = {t['id']: t for t in s['ts']}
    letters = {}

    def gate_name(n):
        if real or n in ('GND', 'VDD') or n == s['out']:
            return 'out' if n == s['out'] and not real else n
        if n not in letters:
            letters[n] = chr(97 + len(letters))
        return letters[n]
    d = Drawing(ts, gate_name)
    pad = 2 * LEAD + 40
    if s['out'] is None:   # transmission gate or pass transistor, between its two terminals
        a, b = s['ts'][0]['terms']
        x = sp([(*t['terms'], t['id']) for t in s['ts']], a, b) if a != b else s['ts'][0]['id']
        w, h = size(x)
        cx = pad + w * UX / 2
        top = 30
        d.node(cx, top, a if real or a in ('GND', 'VDD') else 'x')
        d.tree(x, pad, top, w)
        d.node(cx, top + h * U, b if real or b in ('GND', 'VDD') else 'y')
        width, height = pad + w * UX + 60, top + h * U + 30
        terms = {k: v for k, v in (('x', a), ('y', b)) if v not in ('GND', 'VDD')}
    else:
        o = s['out']
        p = sp([(*t['terms'], t['id']) for t in s['ts'] if t['type'] == 'P'], 'VDD', o)
        n = sp([(*t['terms'], t['id']) for t in s['ts'] if t['type'] == 'N'], o, 'GND')
        (wp, hp), (wn, hn) = size(p), size(n)
        w = max(wp, wn, 1)
        cx = pad + w * UX / 2
        top = 30
        if p is not None:
            d.text(cx, top - 10, 'VDD', cls='net')
            d.line((cx - 20, top), (cx + 20, top), width=2)
            d.tree(p, pad + (w - wp) * UX / 2, top, wp)
        yo = top + hp * U
        d.line((cx, yo), (pad + w * UX, yo))
        d.node(pad + w * UX, yo, o if real else 'out')
        if n is not None:
            d.tree(n, pad + (w - wn) * UX / 2, yo, wn)
            yg = yo + hn * U
            d.line((cx - 20, yg), (cx + 20, yg), width=2)
            d.text(cx, yg + 18, 'GND', cls='net')
        width, height = pad + w * UX + 60, yo + hn * U + 30
        terms = {}
    body = '\n'.join(d.out)
    return (f'<svg viewBox="0 0 {width:.0f} {height:.0f}" width="{width:.0f}" height="{height:.0f}">{body}</svg>',
            {**{k: n for n, k in letters.items()}, **terms})


def page(types, cell, done=()):
    """HTML page of [(name, [stages])], each type's first copy drawn; cell maps a channel to its cell name;
    done lists the approved types as (name, copies)."""
    cards = []
    for name, grp in types:
        s = grp[0]
        pic, nets = svg(s)
        cells = sorted({cell.get(t['channel'], '?') for g in grp for t in g['ts'][:1]})
        where = ', '.join(f'{k} = {v}' for k, v in sorted(nets.items()))
        if s['out'] is not None:
            where = (where + '; ' if where else '') + f"out = {s['out']}"
        cards.append(f'''<section><h2>{html.escape(name)} <span>{len(grp)} {"copy" if len(grp) == 1 else "copies"}</span></h2>
{pic}
<p>Drawn from {html.escape(', '.join(t['id'] for t in s['ts']))} (channel.piece): {html.escape(where)}.</p>
<p>Cells: {html.escape(', '.join(cells))}.</p>
<p class="link">annotate_nets/index.html?die&amp;only=proposal-{html.escape(name)}</p></section>''')
    return f'''<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proposed stages</title>
<style>
:root {{ --bg: #fff; --fg: #111; --muted: #666; --card: #f6f6f4; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg: #161616; --fg: #eee; --muted: #999; --card: #222; }} }}
body {{ background: var(--bg); color: var(--fg); font: 14px/1.4 system-ui, sans-serif; margin: 16px; }}
main {{ display: flex; flex-wrap: wrap; gap: 16px; }}
section {{ background: var(--card); padding: 12px 16px; border-radius: 8px; max-width: 100%; overflow-x: auto; }}
h2 {{ font-size: 16px; margin: 0 0 8px; }} h2 span {{ color: var(--muted); font-weight: normal; }}
p {{ margin: 4px 0; max-width: 46ch; }} .link {{ color: var(--muted); font: 12px monospace; }}
svg {{ display: block; color: var(--fg); }} svg text {{ fill: currentColor; font: 13px system-ui, sans-serif; }}
svg .id {{ fill: var(--muted); font-size: 11px; }} svg .net {{ font-weight: 600; }}
</style></head><body>
<h1>Proposed stages: {len(types)} types to review, {sum(len(g) for _, g in types)} stages</h1>
<p>Approved: {html.escape(', '.join(f'{n} ({k})' for n, k in done)) or 'none'}.</p>
<p>Generated by python3 extract/propose.py stages. Letters a, b, ... are the stage's input nets; x and y a transmission
gate's or pass transistor's terminals. A circle on a gate marks a P transistor; a dashed channel, a weak one.</p>
<main>
{chr(10).join(cards)}
</main></body></html>'''


def cell_html(c):
    """c's stages, each drawn with its real net names, in columns by signal order within the cell."""
    st = c['stages']
    outs = {s['out']: i for i, s in enumerate(st) if s['out']}
    depth = [0] * len(st)
    for _ in range(len(st)):   # longest path from the cell's inputs, ignoring loops
        for i, s in enumerate(st):
            ins = {t['gate'] for t in s['ts']} | (set(s['ts'][0]['terms']) if s['kind'] == 'tg' else set())
            d = max((depth[outs[n]] + 1 for n in ins if n in outs and outs[n] != i), default=0)
            depth[i] = max(depth[i], min(d, len(st)))
    cols = collections.defaultdict(list)
    for i, s in enumerate(st):
        cols[depth[i]].append(i)
    out = []
    for d in sorted(cols):
        items = []
        for i in cols[d]:
            s = st[i]
            pic, _ = svg(s, real=True)
            title = s['out'] or ' / '.join(s['ts'][0]['terms'])
            items.append(f'<div class="st"><h3>{html.escape(title)} ({html.escape(c["kinds"][i])})</h3>{pic}</div>')
        out.append('<div class="col">' + ''.join(items) + '</div>')
    return '<div class="row">' + ''.join(out) + '</div>'


def cell_page(types, done=()):
    """HTML page of [(name, [cells])], each type's first copy drawn by cell_html; done as for page."""
    cards = []
    for name, grp in types:
        c = grp[0]
        cards.append(f'''<section><h2>{html.escape(name)} <span>{len(grp)} {"copy" if len(grp) == 1 else "copies"}</span></h2>
<p>Stages: {html.escape(' + '.join(sorted(c['kinds'])))}. Nets other cells or pads reach: {html.escape(', '.join(sorted(c['ext'])))}.
{('Storage nodes: ' + html.escape(', '.join(sorted(c['storage']))) + '.') if c['storage'] else ''}</p>
{cell_html(c)}
<p class="link">annotate_nets/index.html?die&amp;only=proposal-{html.escape(name)}</p></section>''')
    return f'''<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proposed cells</title>
<style>
:root {{ --bg: #fff; --fg: #111; --muted: #666; --card: #f6f6f4; --st: #fff; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg: #161616; --fg: #eee; --muted: #999; --card: #222; --st: #1b1b1b; }} }}
body {{ background: var(--bg); color: var(--fg); font: 14px/1.4 system-ui, sans-serif; margin: 16px; }}
section {{ background: var(--card); padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; overflow-x: auto; }}
h2 {{ font-size: 16px; margin: 0 0 8px; }} h2 span {{ color: var(--muted); font-weight: normal; }}
h3 {{ font-size: 13px; margin: 0 0 4px; }} p {{ margin: 4px 0; max-width: 90ch; }}
.row {{ display: flex; gap: 16px; align-items: center; }} .col {{ display: flex; flex-direction: column; gap: 12px; }}
.st {{ background: var(--st); padding: 6px; border-radius: 6px; }} .link {{ color: var(--muted); font: 12px monospace; }}
svg {{ display: block; color: var(--fg); }} svg text {{ fill: currentColor; font: 13px system-ui, sans-serif; }}
svg .id {{ fill: var(--muted); font-size: 11px; }} svg .net {{ font-weight: 600; }}
</style></head><body>
<h1>Proposed cells: {len(types)} types to review, {sum(len(g) for _, g in types)} cells</h1>
<p>Approved: {html.escape(', '.join(f'{n} ({k})' for n, k in done)) or 'none'}.</p>
<p>Generated by python3 extract/propose.py cells. Each stage is drawn with its real net names; columns run in signal
order inside the cell. A gate labelled with a net is wired to the stage whose output is that net.</p>
{chr(10).join(cards)}
</body></html>'''
