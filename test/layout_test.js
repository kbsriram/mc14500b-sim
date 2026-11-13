// Check site/gen/layouts against the netlist: each layout places exactly its parts, drawn with the right symbols on
// the right nets; an openable part's layout is its closed outline k times larger, with its pins where the outline's
// are; and each net's wires join all its pins in one piece, unless the net is drawn with tags. A pin on VDD or GND
// must reach a supply symbol's wire. Run from the repo root: node test/layout_test.js
require('../site/gen/mc14500b.js');
require('../site/gen/layouts/index.js');
globalThis.Symbols = require('../site/symbols.js');
const Route = require('../site/route.js');

const nl = NETLISTS.mc14500b, S = Symbols.build(nl);
const name = i => nl.nets[i].name;
let bad = 0;
const fail = (L, msg) => { if (bad++ < 40) console.log(`${L}: ${msg}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function onSeg(p, [a, b]) {
  return (a[0] === b[0] && p[0] === a[0] && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]))
    || (a[1] === b[1] && p[1] === a[1] && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]));
}

function wired(name, L) {
  // Each untagged net's wires join all its pins in one piece; a supply pin touches a wire of its net.
  const tagged = new Set(L.tags.map(t => t.net)), segs = {};
  for (const w of L.wires) for (let i = 1; i < w.pts.length; i++) (segs[w.net] ??= []).push([w.pts[i - 1], w.pts[i]]);
  const sh = Route.layoutSheet(L, S);
  for (const [net, posts] of Object.entries(sh.posts)) {
    if (tagged.has(net) || posts.length < 2) continue;
    const s = segs[net] || [], up = s.map((_, i) => i);
    const find = i => up[i] === i ? i : (up[i] = find(up[i]));
    s.forEach((a, i) => s.forEach((b, j) => { if (i < j && (onSeg(a[0], b) || onSeg(a[1], b) || onSeg(b[0], a) || onSeg(b[1], a))) up[find(i)] = find(j); }));
    const groups = new Set(posts.map(p => { const i = s.findIndex(g => onSeg(p, g)); return i < 0 ? `loose ${p[0]},${p[1]}` : find(i); }));
    if (groups.size > 1) fail(name, `net ${net}: pins in ${groups.size} pieces (${[...groups].filter(g => typeof g === 'string').join('; ')})`);
  }
  for (const lp of Object.values(L.parts)) {
    const s = S[lp.sym];
    if (!s || !lp.nets) continue;
    const o = Symbols.orient(lp, s.w, s.h);
    for (const [pin, p] of Object.entries(s.pins)) {
      const net = lp.nets[pin];
      if (!Route.SUPPLIES.includes(net)) continue;
      const [x, y] = o.map(p.at).map((v, i) => v + lp.at[i]);
      if (!(segs[net] || []).some(g => onSeg([x, y], g))) fail(name, `${lp.sym} pin ${pin} on ${net} at ${x},${y}: no supply wire`);
    }
  }
}

function places(name, L, want) {
  // L's parts, less supply symbols, are exactly want {id: {sym, nets}}.
  const got = Object.entries(L.parts).filter(([, p]) => !(p.sym in { vdd: 1, gnd: 1 }));
  for (const [id] of got) if (!want[id]) fail(name, `places ${id}, not a part here`);
  for (const [id, w] of Object.entries(want)) {
    const lp = L.parts[id];
    if (!lp) { fail(name, `does not place ${id}`); continue; }
    if (lp.sym !== w.sym) fail(name, `${id} drawn as ${lp.sym}, not ${w.sym}`);
    if (w.nets && !w.ok(lp.nets || {})) fail(name, `${id} on nets ${JSON.stringify(lp.nets)}, not ${JSON.stringify(w.nets)}`);
  }
}

function scaled(name, L, sym) {
  // L is sym's outline k times larger, its pins where sym's are.
  const s = S[sym];
  if (!L.k || L.w !== s.w * L.k || L.h !== s.h * L.k) fail(name, `size ${L.w} x ${L.h}, not ${L.k} x ${sym}'s ${s.w} x ${s.h}`);
  for (const [pin, p] of Object.entries(s.pins))
    if (!L.pins[pin] || !same(L.pins[pin].at, [p.at[0] * L.k, p.at[1] * L.k])) fail(name, `pin ${pin} not at ${L.k} x ${p.at}`);
  for (const pin of Object.keys(L.pins)) if (!s.pins[pin]) fail(name, `pin ${pin} not on ${sym}`);
}

const exact = nets => ({ nets, ok: got => same(Object.entries(got).sort(), Object.entries(nets).sort()) });
const need = (L, name) => { if (!LAYOUTS[L]) { fail(L, 'no layout'); return false; } return true; };

// stages: transistors, with a and b interchangeable
for (const [t, st] of Object.entries(nl.types.stage)) {
  const L = `stage.${t}`;
  if (!need(L)) continue;
  scaled(L, LAYOUTS[L], L);
  places(L, LAYOUTS[L], Object.fromEntries(Object.entries(st.ts).map(([r, x]) => [r, {
    sym: `${x.type === 'N' ? 'n' : 'p'}mos${x.weak ? '_w' : ''}`, nets: x,
    ok: g => g.gate === x.gate && same([g.a, g.b].sort(), [x.a, x.b].sort()) }])));
  wired(L, LAYOUTS[L]);
}
// cell types of several stages: their stages
for (const [t, ct] of Object.entries(nl.types.cell)) {
  if (ct.stages.length === 1) continue;
  const L = `cell.${t}`;
  if (!need(L)) continue;
  scaled(L, LAYOUTS[L], L);
  places(L, LAYOUTS[L], Object.fromEntries(ct.stages.map(s => {
    const sym = `stage.${s.type}`;
    return [s.role, { sym, ...exact(Object.fromEntries(Object.keys(S[sym].pins).map(p => [p, s.ports[p]]))) }];
  })));
  wired(L, LAYOUTS[L]);
}
// blocks: their cells, one-stage cells as their stage
for (const b of nl.blocks) {
  const L = `block.${b.name}`;
  if (!need(L)) continue;
  const want = {};
  for (const ci of b.cells) {
    const c = nl.cells[ci], one = nl.types.cell[c.type].stages.length === 1, st = one ? nl.stages[c.stages[0]] : null;
    const sym = one ? `stage.${st.type}` : `cell.${c.type}`, src = one ? st.nets : c.nets;
    want[c.name] = { sym, ...exact(Object.fromEntries(Object.keys(S[sym].pins).map(p => [p, name(src[p])]))) };
  }
  places(L, LAYOUTS[L], want);
  const ports = new Set(b.ports.map(name));
  for (const n of Object.keys(LAYOUTS[L].pins)) if (!ports.has(n)) fail(L, `pin ${n} is not one of the block's ports`);
  for (const n of ports) if (!LAYOUTS[L].pins[n]) fail(L, `no pin for port ${n}`);
  wired(L, LAYOUTS[L]);
}
// the chip: its blocks, each the size its layout is over k
if (need('chip')) {
  const C = LAYOUTS.chip;
  places('chip', C, Object.fromEntries(nl.blocks.map(b => [b.name, { sym: 'block' }])));
  for (const b of nl.blocks) {
    const lp = C.parts[b.name], B = LAYOUTS[`block.${b.name}`];
    if (lp && B && (lp.w * B.k !== B.w || lp.h * B.k !== B.h)) fail('chip', `${b.name} is ${lp.w} x ${lp.h}, its layout ${B.w} x ${B.h} over k ${B.k}`);
  }
  for (const k of Object.keys(nl.pins)) if (!C.pins[k]) fail('chip', `no pin ${k}`);
  wired('chip', C);
}
const n = Object.keys(LAYOUTS).length;
console.log(`${n} layouts checked, ${bad} problems`);
process.exit(bad ? 1 : 0);
