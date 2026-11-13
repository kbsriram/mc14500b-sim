// Draft the schematic's layouts into site/gen/layouts, one file per drawing: the chip (its blocks), each block
// (its cells), each cell type of several stages (its stages), and each stage type (its transistors). An opened part
// draws its layout inside its closed outline, k times larger, so a layout's pins sit where the closed symbol's are.
// Blocks stand in GRID's columns; cells and stages stand in columns by logic depth; transistors as
// CMOS stages are drawn, the P network over the N network. Wires are routed by site/route.js; nets the router
// cannot place, and clock and reset nets read by many blocks, get a tag at each pin instead.
// gen/placement.json, if present, holds hand placement by layout name. A block or cell: {cols: [[part, ...], ...],
// pins: {in, out, ctl: [net, ...]}} (pins for a block only), columns left to right, each top to bottom, and each
// edge's pins in order. A stage: {at: {transistor: [x, y]}, rot: {transistor: degrees}}. Any layout: wires: [{net,
// pts}], hand-drawn runs kept as they are, the router joining the rest of their net to them. What it leaves out is
// placed as usual.
// Run from the repo root: node gen/draft.js [--only NAME], NAME a layout (stage.inv, cell.dff, block.TIE): only that
// layout, and the chip after a block.
const fs = require('fs');
const path = require('path');
const Symbols = require('../site/symbols.js');
const Route = require('../site/route.js');
globalThis.Symbols = Symbols;
require('../site/gen/mc14500b.js');

const nl = globalThis.NETLISTS.mc14500b;
const S = Symbols.build(nl);
const G = Route.G;
const OUT = path.join(__dirname, '..', 'site', 'gen', 'layouts');
const PLACEMENT = path.join(__dirname, 'placement.json');
const PLACE = fs.existsSync(PLACEMENT) ? JSON.parse(fs.readFileSync(PLACEMENT, 'utf8')) : {};
const PITCH = 32;   // spacing of a closed block's pins
const GAP = 128;    // between columns of parts, for wires
const MARGIN = 96;  // between a layout's pins and its parts
const SUPPLY = { VDD: 'vdd', GND: 'gnd' };
const TAG_READERS = 4;   // the chip draws a net as tags when this many blocks read it
// package pins on the chip's sides, top to bottom: inputs left, outputs right; VDD and VSS join no drawn wire
const SIDES = { w: ['DATA', 'X1', 'X2', 'I0', 'I1', 'I2', 'I3', 'RST'], e: ['WRITE', 'RR', 'JMP', 'RTN', 'O', 'F'] };
// the chip's blocks in columns, left to right, each top to bottom: inputs and timing, decoding, the data path's
// registers, the logic unit and result, the outputs; as the data sheet's block diagram reads, by judgement
const GRID = [['INST', 'OSC', 'RST', 'TIE'], ['CTRL', 'CLK'], ['MUX', 'DATA', 'IEN', 'OEN'], ['LU', 'RR', 'SKIP'], ['WRITE', 'FLAG']];
const PIN_LABEL = { O: 'FLAG O', F: 'FLAG F' };

const name = i => nl.nets[i].name;
const snap = v => Math.round(v / G) * G;
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

class Sheet {
  // Parts and pins on one layout, and the wires and tags joining them.
  constructor(w, h) {
    Object.assign(this, { w, h, pins: {}, parts: {}, wires: [], tags: [], posts: {}, rects: [], keep: [] });   // keep: hand wires
  }

  post(net, x, y, dir) { (this.posts[net] ??= []).push([x, y, dir]); }

  add(id, sym, x, y, nets, { rot = 0, flip = false, w, h, pins, ...extra } = {}) {
    // A part at (x, y), turned by rot and flip; its symbol's pins, or pins {net: {at, dir}} for a block, join nets.
    const s = S[sym];
    this.parts[id] = { sym, at: [x, y], ...(rot ? { rot } : {}), ...(flip ? { flip } : {}), ...(s ? {} : { w, h }), ...extra,
      ...(nets && Object.keys(nets).length ? { nets } : {}) };
    const o = Symbols.orient({ rot, flip }, s ? s.w : w, s ? s.h : h);
    this.rects.push([x, y, x + o.w, y + o.h]);
    const ps = s ? Object.entries(s.pins).map(([n, p]) => [nets[n], p]) : Object.entries(pins);
    for (const [net, p] of ps) if (net != null) { const [px, py] = o.map(p.at); this.post(net, x + px, y + py, o.dir(p.dir)); }
  }

  supplies() {
    // A supply symbol beside every part pin on VDD or GND, two grid steps out.
    for (const [net, sym] of Object.entries(SUPPLY)) {
      (this.posts[net] || []).forEach(([px, py, d], i) => {
        const [dx, dy] = Symbols.DIR[d], sx = px + 2 * G * dx, sy = py + 2 * G * dy, sp = S[sym].pins.p.at;
        const o = { rot: net === 'VDD' ? (d === 's' ? 180 : 0) : (d === 'n' ? 180 : 0) };
        const t = Symbols.orient(o, 32, 32), [qx, qy] = t.map(sp);
        this.parts[`${net}@${i}`] = { sym, at: [sx - qx, sy - qy], ...(o.rot ? { rot: o.rot } : {}) };
        this.wires.push({ net, pts: [[px, py], [sx, sy]] });
      });
      delete this.posts[net];
    }
  }

  route(tagged = new Set()) {
    const r = Route.routeSheet({ box: [0, 0, this.w, this.h], rects: this.rects, posts: this.posts }, Object.keys(this.posts).sort(), this.keep, tagged);
    this.wires.push(...this.keep, ...r.wires);
    this.tags.push(...r.tags);
    return r.failed;
  }

  json(extra = {}) {
    return { w: this.w, h: this.h, ...extra, pins: this.pins, parts: this.parts, wires: this.wires, tags: this.tags };
  }
}

let ORDER = 'ins';   // see columns(); drafted() tries both

function columns(items, pinY, hint) {
  // Columns of items {id, sym, ins, outs} by logic depth from the layout's pins, each column ordered by the mean
  // height of its inputs' sources, then of the layout pins it drives; with ORDER 'both', by the mean of both.
  // pinY gives the layout's pins' heights, as fractions of its height.
  const drv = new Map();
  for (const it of items) for (const n of it.outs) drv.set(n, it);
  const depth = new Map();
  const d = (it, seen = new Set()) => {
    if (depth.has(it.id)) return depth.get(it.id);
    if (seen.has(it.id)) return 0;
    seen.add(it.id);
    const v = 1 + Math.max(0, ...it.ins.filter(n => drv.has(n) && drv.get(n) !== it).map(n => d(drv.get(n), seen)));
    seen.delete(it.id);
    depth.set(it.id, v);
    return v;
  };
  const cols = new Map();
  for (const it of items) { const c = d(it); if (!cols.has(c)) cols.set(c, []); cols.get(c).push(it); }
  const y = new Map(Object.entries(pinY)), out = [];
  for (const c of [...cols.keys()].sort((a, b) => a - b)) {
    const pinsOut = it => it.outs.filter(n => n in pinY);
    const bary = it => {
      const ys = [...it.ins.filter(n => y.has(n)).map(n => y.get(n)), ...(ORDER === 'both' ? pinsOut(it).map(n => pinY[n]) : [])];
      return ys.length ? mean(ys) : it.y0 ?? 0.5;
    };
    const outY = it => { const ys = pinsOut(it).map(n => pinY[n]); return ys.length ? mean(ys) : 0.5; };
    const col = cols.get(c).sort((a, b) => bary(a) - bary(b) || outY(a) - outY(b) || (a.y0 ?? 0) - (b.y0 ?? 0));
    col.forEach((it, i) => { for (const n of it.outs) y.set(n, (i + 0.5) / col.length); });
    out.push(col);
  }
  if (!hint?.cols?.length) return out;
  // hand placement: its columns in its order; a part it leaves out goes to the end of the column at its usual place
  const byId = new Map(items.map(it => [it.id, it])), placed = new Set(hint.cols.flat());
  const hand = hint.cols.map(c => c.filter(id => byId.has(id)).map(id => byId.get(id)));
  out.forEach((col, i) => { for (const it of col) if (!placed.has(it.id)) hand[Math.min(i, hand.length - 1)].push(it); });
  return hand.filter(c => c.length);
}

const size = it => it.w ? [it.w, it.h] : [S[it.sym].w, S[it.sym].h];

function measure(cols) {
  // (width, height) that columns of parts need.
  const width = 2 * MARGIN + cols.reduce((s, col) => s + Math.max(...col.map(it => size(it)[0])), 0) + GAP * (cols.length - 1);
  return [width, Math.max(...cols.map(col => col.reduce((s, it) => s + size(it)[1] + 4 * G, 0))) + 2 * MARGIN];
}

function scaledPins(sh, pins, k) {
  // sh's pins: pins {net: {at, dir, ...}} of a closed outline, k times larger.
  for (const [n, p] of Object.entries(pins)) {
    sh.pins[n] = { ...p, at: [p.at[0] * k, p.at[1] * k] };
    sh.post(n, ...sh.pins[n].at, p.dir);
  }
}

function inside(W, H, pins, items, minK = 2, hint) {
  // A Sheet for a closed outline of W by H with pins {net: pin}: items in columns inside it, k times larger, k the
  // smallest whole number that fits them. Returns [sheet, k].
  const cols = columns(items, Object.fromEntries(Object.entries(pins).map(([n, p]) => [n, p.at[1] / H])), hint);
  const [width, height] = measure(cols);
  const k = Math.max(minK, Math.ceil(width / W), Math.ceil(height / H));
  const sh = new Sheet(W * k, H * k);
  sh.keep = hint?.wires || [];
  scaledPins(sh, pins, k);
  let x = snap(MARGIN + (sh.w - width) / 2);
  for (const col of cols) {
    const cw = Math.max(...col.map(it => size(it)[0])), step = (sh.h - 2 * MARGIN) / col.length;
    col.forEach((it, i) => {
      const [w, h] = size(it);
      sh.add(it.id, it.sym, x + snap((cw - w) / 2), snap(MARGIN + (i + 0.5) * step - h / 2), it.nets, it.opts || {});
    });
    x += cw + GAP;
  }
  sh.supplies();
  return [sh, k];
}

function symPins(sym) {
  // A symbol's pins as a layout's pins: {pin name: {at, dir, label?}}.
  return Object.fromEntries(Object.entries(S[sym].pins).map(([n, p]) => [n, { at: p.at, dir: p.dir }]));
}

// Stage types: transistors, the P network over the N network.
function stageLayout(tname) {
  const t = nl.types.stage[tname], sym = `stage.${tname}`, s = S[sym];
  const ts = t.ts, tsym = r => `${ts[r].type === 'N' ? 'n' : 'p'}mos${ts[r].weak ? '_w' : ''}`;
  const place = [];   // [role, x, y, top net, bottom net, rot]
  const leaves = x => typeof x === 'string' ? [x] : x[1].flatMap(leaves);
  const TW = 64, TH = 64, SP = 32;   // a transistor's cell, and the space between
  function arrange(x, top, bot) {   // [w, h, items relative] for subtree x between nets top and bot
    if (typeof x === 'string') return [TW, TH, [[x, 0, 0, top, bot]]];
    if (x[0] === 'or') {
      let w = 0, h = 0; const out = [];
      for (const k of x[1]) { const [kw, kh, it] = arrange(k, top, bot); out.push(...it.map(([r, a, b, tp, bt]) => [r, a + w, b, tp, bt])); w += kw + SP; h = Math.max(h, kh); }
      return [w - SP, h, out];
    }
    // series: chain the kids from top to bot
    let cur = top, left = [...x[1]], h = 0, w = 0; const out = [];
    while (left.length) {
      const i = left.findIndex(k => leaves(k).some(r => ts[r].a === cur || ts[r].b === cur));
      const k = left.splice(i, 1)[0];
      const kn = new Set(leaves(k).flatMap(r => [ts[r].a, ts[r].b]));
      const rest = new Set([bot, ...left.flatMap(j => leaves(j).flatMap(r => [ts[r].a, ts[r].b]))]);
      const next = left.length ? [...kn].find(n => n !== cur && rest.has(n)) : bot;
      const [kw, kh, it] = arrange(k, cur, next);
      out.push(...it.map(([r, a, b, tp, bt]) => [r, a, b + h, tp, bt]));
      h += kh + SP; w = Math.max(w, kw); cur = next;
    }
    return [w, h - SP, out];
  }
  let parts = [], W, H;
  if (t.kind === 'tg') {
    const n = Object.keys(ts).find(r => ts[r].type === 'N'), p = Object.keys(ts).find(r => ts[r].type === 'P');
    parts = [[n, 0, 0, 'a', 'b', 90], [p, 0, TH + 2 * SP, 'a', 'b', 270]];
    W = TW; H = 2 * TH + 2 * SP;
  } else if (t.psw || t.nsw) {
    const [pw, ph, pi] = t.psw ? arrange(t.psw, 'VDD', 'y') : [0, 0, []];
    const [nw, nh, ni] = t.nsw ? arrange(t.nsw, 'y', 'GND') : [0, 0, []];
    W = Math.max(pw, nw);
    const off = t.psw ? ph + 2 * SP : 0;
    parts = [...pi.map(([r, a, b, tp, bt]) => [r, a + (W - pw) / 2, b, tp, bt, 0]), ...ni.map(([r, a, b, tp, bt]) => [r, a + (W - nw) / 2, b + off, tp, bt, 0])];
    H = off + nh;
  } else {
    const rs = Object.keys(ts);
    parts = rs.map((r, i) => [r, i * (TW + SP), 0, ts[r].a, ts[r].b, 0]);
    W = rs.length * (TW + SP) - SP; H = TH;
  }
  const needW = W + 2 * MARGIN + 2 * 64, needH = H + 2 * MARGIN + 2 * 48;
  const k = Math.max(2, Math.ceil(needW / s.w), Math.ceil(needH / s.h));
  const sh = new Sheet(s.w * k, s.h * k);
  sh.keep = PLACE[sym]?.wires || [];
  scaledPins(sh, symPins(sym), k);
  const x0 = snap((sh.w - W) / 2), y0 = snap((sh.h - H) / 2), hint = PLACE[sym] || {}, gates = [];
  for (const [r, x, y, top, bot, rot0] of parts) {
    const rot = hint.rot?.[r] ?? rot0, [px, py] = hint.at?.[r] ?? [x0 + snap(x), y0 + snap(y)];
    const o = Symbols.orient({ rot }, 48, 64), q = S[tsym(r)].pins;
    // the transistor's a and b are interchangeable: put top's net on whichever pin lands up (or west, turned)
    const aUp = o.map(q.a.at)[1] < o.map(q.b.at)[1] || o.map(q.a.at)[0] < o.map(q.b.at)[0];
    const nets = { gate: ts[r].gate, a: aUp ? top : bot, b: aUp ? bot : top };
    if (!new Set([ts[r].a, ts[r].b]).has(top)) { nets.a = ts[r].a; nets.b = ts[r].b; }
    sh.add(r, tsym(r), px, py, nets, { rot });
    const g = o.map(q.gate.at);
    gates.push({ r, net: ts[r].gate, type: ts[r].type, at: [px + g[0], py + g[1]], dir: o.dir(q.gate.dir) });
  }
  symmetricInputs(sh, gates);
  sh.supplies();
  return [sh, k];
}

function symmetricInputs(sh, gates) {
  // An input pin that gates one P and one N transistor whose gate leads point west in one column, the pin between
  // them in height: a straight run from the pin to a bus two grid steps west of the leads, and the bus spanning both,
  // kept as hand wires are, when no part stands in the way; the router joins the leads to the bus.
  const clear = (x0, y0, x1, y1) => !sh.rects.some(([a, b, c, d]) => a <= Math.max(x0, x1) && c >= Math.min(x0, x1) && b <= Math.max(y0, y1) && d >= Math.min(y0, y1));
  for (const [net, pin] of Object.entries(sh.pins)) {
    const gs = gates.filter(g => g.net === net);
    if (pin.dir !== 'w' || gs.length !== 2 || new Set(gs.map(g => g.type)).size !== 2 || sh.keep.some(w => w.net === net)) continue;
    const [a, b] = gs.sort((p, q) => p.at[1] - q.at[1]), x = a.at[0] - 2 * G, y = pin.at[1];
    if (a.at[0] !== b.at[0] || a.dir !== 'w' || b.dir !== 'w' || !(a.at[1] < y && y < b.at[1]) || x <= pin.at[0]) continue;
    if (!clear(pin.at[0] + G, y, x, y) || !clear(x, a.at[1], x, b.at[1])) continue;
    sh.keep.push({ net, pts: [pin.at, [x, y]] }, { net, pts: [[x, a.at[1]], [x, b.at[1]]] });
  }
}

function cellItems(ct) {
  // A cell type's stages as items.
  return nl.types.cell[ct].stages.map(st => {
    const sym = `stage.${st.type}`, ports = st.ports;
    const nets = Object.fromEntries(Object.keys(S[sym].pins).map(p => [p, ports[p]]));
    return { id: st.role, sym, nets, ins: Object.entries(nets).filter(([p]) => p !== 'y').map(([, n]) => n), outs: ports.y ? [ports.y] : [] };
  });
}

function cellLayout(ct) {
  const sym = `cell.${ct}`, s = S[sym];
  return inside(s.w, s.h, symPins(sym), cellItems(ct), 3, PLACE[sym]);
}

// Blocks: their cells, each drawn as its cell type's symbol, or its stage's for a cell of one stage.
function cellItem(ci) {
  const c = nl.cells[ci], ct = nl.types.cell[c.type];
  const st = ct.stages.length === 1 ? nl.stages[c.stages[0]] : null;
  const sym = st ? `stage.${st.type}` : `cell.${c.type}`, src = st ? st.nets : c.nets;
  const nets = Object.fromEntries(Object.keys(S[sym].pins).map(p => [p, name(src[p])]));
  const outs = st ? (st.nets.y !== undefined ? [name(st.nets.y)] : []) : ct.outs.map(r => name(c.nets[r]));
  return { id: c.name, sym, nets, ins: Object.values(nets).filter(n => !outs.includes(n)), outs, y0: c.at[1] };
}

const blockOf = new Map(nl.blocks.flatMap(b => b.cells.map(c => [c, b.name])));
const dieCentre = b => [(b.box[0] + b.box[2]) / 2, (b.box[1] + b.box[3]) / 2];

function farEnd(b, net) {
  // Die position that block b's pin on net leads to: the mean of the other blocks' cells and the pins on it.
  const pts = nl.cells.filter((c, i) => blockOf.get(i) !== b.name && Object.values(c.nets).includes(net)).map(c => c.at);
  for (const [k, n] of Object.entries(nl.pins)) if (n === net) pts.push(nl.die.pins[k]);
  return pts.length ? [mean(pts.map(p => p[0])), mean(pts.map(p => p[1]))] : dieCentre(b);
}

function blockPins(b) {
  // {in, out, ctl}: the nets b's pins carry, each edge in the order of the places they lead to.
  const items = b.cells.map(cellItem), outs = new Set(items.flatMap(it => it.outs));
  const drvBlock = new Map();
  nl.cells.forEach((c, i) => { for (const it of [cellItem(i)]) for (const n of it.outs) drvBlock.set(n, blockOf.get(i)); });
  const ports = b.ports.map(name);
  for (const k of SIDES.w) if (k in nl.pins) outs.delete(name(nl.pins[k]));
  const ctl = ports.filter(n => !outs.has(n) && ['CLK', 'RST', 'OSC'].includes(drvBlock.get(n)) && drvBlock.get(n) !== b.name);
  const ins = ports.filter(n => !outs.has(n) && !ctl.includes(n)), out = ports.filter(n => outs.has(n));
  const at = n => farEnd(b, b.ports[ports.indexOf(n)]), hint = PLACE[`block.${b.name}`]?.pins || {};
  const order = (list, cls) => { const h = hint[cls] || []; return [...h.filter(n => list.includes(n)), ...list.filter(n => !h.includes(n))]; };
  return { in: order(ins.sort((p, q) => at(p)[1] - at(q)[1]), 'in'), out: order(out.sort((p, q) => at(p)[1] - at(q)[1]), 'out'),
    ctl: order(ctl.sort((p, q) => at(p)[0] - at(q)[0]), 'ctl'), items };
}

function edgePoints(shape, w, h, cls) {
  // Grid points for pins of class cls on a block outline of w by h: [x, y, dir].
  const out = [];
  for (const [fx0, fy0, fx1, fy1] of Symbols.data.shapes[shape].edges[cls]) {
    const [x0, y0, x1, y1] = [fx0 * w, fy0 * h, fx1 * w, fy1 * h];
    if (x0 === x1) { for (let y = PITCH; y < h; y += PITCH) if (y > Math.min(y0, y1) && y < Math.max(y0, y1)) out.push([x0, y, cls === 'in' ? 'w' : 'e']); }
    else for (let x = PITCH; x < w; x += PITCH) if (x > x0 && x < x1) out.push([x, h, 's']);
  }
  return out;
}

const spread = (cands, n) => Array.from({ length: n }, (_, i) => cands[Math.floor((i + 0.5) * cands.length / n)]);

function placePins(shape, nets, w, h) {
  // Grow w and h until every edge class fits; return [w, h, {net: pin}].
  for (;;) {
    const fit = Object.fromEntries(['in', 'out', 'ctl'].map(c => [c, edgePoints(shape, w, h, c)]));
    if (fit.in.length < nets.in.length || fit.out.length < nets.out.length) h += PITCH;
    else if (fit.ctl.length < nets.ctl.length) w += PITCH;
    else {
      const pins = {};
      for (const c of ['in', 'out', 'ctl']) spread(fit[c], nets[c].length).forEach(([x, y, dir], i) => {
        const n = nets[c][i];
        pins[n] = { at: [x, y], dir, label: short(n) };
      });
      return [w, h, pins];
    }
  }
}

function short(n) {
  // A block pin's label: the net's name less its block and its port, unless that leaves nothing.
  const parts = n.split('.');
  if (parts.length === 1) return n;
  if (parts.length === 2) return parts[0];
  return parts.slice(1, -1).join('.');
}

function blockLayout(b) {
  const p = blockPins(b), shape = (Symbols.data.blocks[b.name] || { shape: 'box' }).shape;
  const title = (Symbols.data.blocks[b.name] || {}).title || b.name;
  const w0 = PITCH * Math.max(6, Math.ceil(title.length * 22 / PITCH) + 4);   // room for the title between the pins' names
  let [w, h, pins] = placePins(shape, p, w0, PITCH * 6);
  const pinY = Object.fromEntries(Object.entries(pins).map(([n, q]) => [n, q.at[1] / h]));
  const hint = PLACE[`block.${b.name}`];
  const [cw, ch] = measure(columns(p.items, pinY, hint));
  const k0 = Math.max(3, Math.ceil(ch / h));
  const w1 = PITCH * Math.ceil(cw / k0 / PITCH);
  if (w1 > w) [w, h, pins] = placePins(shape, p, w1, h);
  const [sh, k] = inside(w, h, pins, p.items, 3, hint);
  return [sh, k, w, h];
}

// The chip: blocks in GRID's columns; package pins on the board's sides.
function chipLayout(blocks) {
  const SEP = 192, CGAP = 320, EDGE = 352;   // between blocks in a column, between columns, from the chip's edge
  const items = nl.blocks.map(b => {
    const L = LAYOUTS[`block.${b.name}`], ps = Object.entries(L.pins);
    return { id: b.name, w: blocks[b.name][0], h: blocks[b.name][1], y0: dieCentre(b)[1],
      ins: ps.filter(([, p]) => p.dir !== 'e').map(([n]) => n), outs: ps.filter(([, p]) => p.dir === 'e').map(([n]) => n) };
  });
  const byId = new Map(items.map(it => [it.id, it])), placed = new Set(GRID.flat());
  const cols = GRID.map(col => col.filter(b => byId.has(b)).map(b => byId.get(b)));
  cols[cols.length - 1].push(...items.filter(it => !placed.has(it.id)));
  const H = Math.ceil((Math.max(...cols.map(c => c.reduce((s, it) => s + it.h + SEP, -SEP))) + 2 * EDGE / 2) / PITCH) * PITCH;
  const rects = [];
  let x = EDGE;
  for (const col of cols) {
    const cw = Math.max(...col.map(it => it.w)), ch = col.reduce((s, it) => s + it.h + SEP, -SEP);
    let y = (H - ch) / 2;
    for (const it of col) {
      rects.push({ name: it.id, w: it.w, h: it.h, x: Math.round((x + (cw - it.w) / 2) / PITCH) * PITCH, y: Math.round(y / PITCH) * PITCH });
      y += it.h + SEP;
    }
    x += cw + CGAP;
  }
  const W = Math.ceil((x - CGAP + EDGE) / PITCH) * PITCH;
  const sh = new Sheet(W, H);
  for (const [side, ks] of Object.entries(SIDES)) ks.forEach((k, i) => {
    const x = side === 'w' ? 0 : W;
    const net = k in SUPPLY ? k : name(nl.pins[k]);
    sh.pins[net] = { at: [x, Math.round(H * (i + 1) / (ks.length + 1) / PITCH) * PITCH], dir: side, label: PIN_LABEL[k] || k };
    if (!(k in SUPPLY)) sh.post(net, ...sh.pins[net].at, side);
  });
  for (const r of rects) {
    const L = LAYOUTS[`block.${r.name}`], k = L.k;
    const pins = Object.fromEntries(Object.entries(L.pins).map(([n, p]) => [n, { at: [p.at[0] / k, p.at[1] / k], dir: p.dir }]));
    sh.add(r.name, 'block', r.x, r.y, null, { w: r.w, h: r.h, pins, block: r.name });
  }
  const readers = new Map();
  nl.cells.forEach((c, i) => { for (const n of Object.values(c.nets)) { const k = name(n); if (!readers.has(k)) readers.set(k, new Set()); readers.get(k).add(blockOf.get(i)); } });
  const tagged = new Set(Object.keys(sh.posts).filter(n => (readers.get(n)?.size || 0) >= TAG_READERS));
  return [sh, tagged];
}

globalThis.LAYOUTS = {};
function write(file, sh, k, extra = {}) {
  const p = path.join(OUT, `${file}.js`);
  const L = sh.json({ ...(k ? { k } : {}), ...extra });
  LAYOUTS[file] = L;
  const body = JSON.stringify(L, null, 0).replace(/\],"/g, '],\n"').replace(/\},"/g, '},\n"');
  fs.writeFileSync(p, `// Written by gen/draft.js.\n(globalThis.LAYOUTS ??= {})[${JSON.stringify(file)}] = ${body};\n`);
  console.log(`${p}: ${Object.keys(L.parts).length} parts, ${L.wires.length} wire runs, ${new Set(L.tags.map(t => t.net)).size} tagged nets`);
}

function drafted(make, once = false) {
  // make()'s [sheet, k], routed, with columns ordered both ways (see columns): the fewer tagged nets, then the shorter
  // wire; once: only the usual way, for a hand-placed block.
  let best = null;
  for (const o of once ? ['ins'] : ['ins', 'both']) {
    ORDER = o;
    const [sh, k] = make();
    sh.route();
    const tags = new Set(sh.tags.map(t => t.net)).size;
    const len = sh.wires.reduce((s, w) => s + w.pts.slice(1).reduce((m, p, i) => m + Math.abs(p[0] - w.pts[i][0]) + Math.abs(p[1] - w.pts[i][1]), 0), 0);
    if (!best || tags < best.tags || (tags === best.tags && len < best.len)) best = { sh, k, tags, len };
  }
  ORDER = 'ins';
  return [best.sh, best.k];
}

function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  if (only?.startsWith('stage.') && only.slice(6) in nl.types.stage) {
    const [sh, k] = stageLayout(only.slice(6));
    sh.route();
    return write(only, sh, k);
  }
  if (only?.startsWith('cell.') && only.slice(5) in nl.types.cell) {
    const [sh, k] = drafted(() => cellLayout(only.slice(5)), !!PLACE[only]?.cols?.length);
    return write(only, sh, k);
  }
  if (only) {   // one block and the chip, with the other layouts as they are
    const b = nl.blocks.find(x => `block.${x.name}` === only);
    if (!b) throw new Error(`no layout ${only}`);
    require(path.join(OUT, 'index.js'));
    const [sh, k] = drafted(() => blockLayout(b), !!PLACE[only]?.cols?.length);
    write(`block.${b.name}`, sh, k);
    const sizes = Object.fromEntries(nl.blocks.map(x => { const L = LAYOUTS[`block.${x.name}`]; return [x.name, [L.w / L.k, L.h / L.k]]; }));
    const [chip, tagged] = chipLayout(sizes);
    chip.route(tagged);
    write('chip', chip, null, { tagged: [...tagged].sort() });
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const files = [];
  for (const t of Object.keys(nl.types.stage)) {
    const [sh, k] = stageLayout(t);
    sh.route();
    write(`stage.${t}`, sh, k);
    files.push(`stage.${t}`);
  }
  for (const [t, ct] of Object.entries(nl.types.cell)) {
    if (ct.stages.length === 1) continue;
    const [sh, k] = drafted(() => cellLayout(t), !!PLACE[`cell.${t}`]?.cols?.length);
    write(`cell.${t}`, sh, k);
    files.push(`cell.${t}`);
  }
  const sizes = {};
  for (const b of nl.blocks) {
    const [sh, k] = drafted(() => blockLayout(b), !!PLACE[`block.${b.name}`]?.cols?.length);
    write(`block.${b.name}`, sh, k);
    files.push(`block.${b.name}`);
    const L = LAYOUTS[`block.${b.name}`];
    sizes[b.name] = [L.w / L.k, L.h / L.k];
  }
  const [sh, tagged] = chipLayout(sizes);
  sh.route(tagged);
  write('chip', sh, null, { tagged: [...tagged].sort() });
  files.unshift('chip');
  fs.writeFileSync(path.join(OUT, 'index.js'), '// Written by gen/draft.js: the layout files, loaded by a page in order, or by require().\n'
    + `const LAYOUT_FILES = ${JSON.stringify(files.map(f => f + '.js'))};\n`
    + "if (typeof module !== 'undefined') for (const f of LAYOUT_FILES) require(`./${f}`);\n"
    + 'else for (const f of LAYOUT_FILES) document.write(`<script src="${new URL(f, document.currentScript.src)}"></script>`);\n');
}

if (require.main === module) main();
module.exports = { Sheet, columns, inside, S };
