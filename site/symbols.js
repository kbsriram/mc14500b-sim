// Symbols for the schematic, built from the netlist's types (site/netlist.js): a stage type as its
// ANSI gate (an AND-OR-invert as AND gates into a NOR), a transmission gate as two opposed triangles, single
// transistors as MOS symbols; a cell type as its gate, a flip-flop as a box with D, clock, R and Q; a block as
// its outline from site/symbols_data.js. Units are the router's grid points (site/route.js): pins sit
// on multiples of 16. A symbol is {w, h, pins: {name: {at, dir, end, label?, mark?}}, svg}: dir is the side a pin's
// wire leaves by (w, e, n, s), end where its lead meets the body; svg is the body. draw() adds the leads, each a
// wire (class w) carrying its net's data-key, so a view colours it.
const _sreq = typeof module !== 'undefined' ? require : null;
if (_sreq) _sreq('./symbols_data.js');
const SYM = globalThis.SYMBOLS.data;

const DIR = { w: [-1, 0], e: [1, 0], n: [0, -1], s: [0, 1] };   // the way a pin's wire leaves the symbol
const B = 4;   // radius of an inversion bubble
const BACK = 0.3;   // an OR body's back curve: its control point's depth, as a fraction of the body's length
const OVER = { 'C̄': 'C', 'S̄': 'S' };   // labels drawn with a bar over them

const pin = (x, y, dir, ex, ey, label, mark) => ({ at: [x, y], dir, end: [ex, ey], ...(label ? { label } : {}), ...(mark ? { mark } : {}) });

const Path = {
  and: (x0, y0, x1, y1) => {
    const r = (y1 - y0) / 2, xm = Math.max(x0, x1 - r);
    return `M${x0},${y0} H${xm} A${x1 - xm},${r} 0 0 1 ${xm},${y1} H${x0} Z`;
  },
  or: (x0, y0, x1, y1) => {
    const m = (y0 + y1) / 2, k = x0 + 0.55 * (x1 - x0);
    return `M${x0},${y0} Q${k},${y0} ${x1},${m} Q${k},${y1} ${x0},${y1} Q${x0 + BACK * (x1 - x0)},${m} ${x0},${y0} Z`;
  },
  buf: (x0, y0, x1, y1) => `M${x0},${y0} L${x1},${(y0 + y1) / 2} L${x0},${y1} Z`,
};

function orBack(x0, y0, x1, y1, y) {
  // x of an OR body's curved back at height y.
  const t = (y - y0) / (y1 - y0);
  return x0 + 2 * t * (1 - t) * BACK * (x1 - x0);
}

function rows(n) {
  // Heights of n inputs on the grid, symmetric about an output on the grid: an even count skips the middle row.
  const r = n % 2 ? n : n + 1, ys = [];
  for (let i = 0; i < r; i++) if (n % 2 || i !== (r - 1) / 2) ys.push(16 * (i + 1));
  return { ys, h: 16 * (r + 1) };
}

function gate(kind, inv, names, out, { w = 80, weak = false, minRows = 0 } = {}) {
  // A gate (and, or, buf) with inputs names, top to bottom, and output out; inv adds the output bubble.
  let { ys, h } = rows(names.length);
  if (minRows > ys.length) { const pad = 16 * Math.floor((minRows - ys.length + 1) / 2); ys = ys.map(y => y + pad); h += 2 * pad; }
  const m = h / 2, x0 = 16, x1 = w - 16 - (inv ? 2 * B : 0);
  const y0 = Math.min(ys[0] - 12, m - (weak ? 8 : 12)), y1 = Math.max(ys[ys.length - 1] + 12, m + (weak ? 8 : 12));
  const bx0 = weak ? x0 + 8 : x0;
  const pins = {};
  names.forEach((n, i) => {
    const back = kind === 'or' ? orBack(x0, y0, x1, y1, ys[i]) : bx0;
    pins[n] = pin(0, ys[i], 'w', back, ys[i]);
  });
  pins[out] = pin(w, m, 'e', x1, m, null, inv ? 'bubble' : null);
  return { w, h, pins, svg: `<path class="sym${weak ? ' weak' : ''}" d="${Path[kind](bx0, y0, x1, y1)}"/>` };
}

function compound(tree, out) {
  // A two-level gate: tree [op, kids] with kids leaves or [op2, leaves]; op2 gates feed an inverted op gate.
  const [op, kids] = tree, groups = kids.filter(k => typeof k !== 'string'), singles = kids.filter(k => typeof k === 'string');
  let r = 0;
  const g = groups.map(([op2, ls]) => { const r0 = r; r += ls.length + 1; return { op2, ls, r0 }; });
  if (!singles.length) r--;
  const sr = singles.map(() => r++);
  if ((r - 1) % 2) r++;   // the output sits on the grid between the first and last rows
  const y = i => 16 * (i + 1), h = y(r - 1) + 16, m = (y(0) + y(r - 1)) / 2, w = 144;
  const ox0 = 72, ox1 = 120, oy0 = y(0) - 12, oy1 = y(r - 1) + 12;
  const back = yy => op === 'or' ? orBack(ox0, oy0, ox1, oy1, yy) : ox0;
  const pins = {}, svg = [`<path class="sym" d="${Path[op](ox0, oy0, ox1, oy1)}"/>`];
  for (const { op2, ls, r0 } of g) {
    const gy0 = y(r0) - 10, gy1 = y(r0 + ls.length - 1) + 10, gm = (gy0 + gy1) / 2;
    ls.forEach((n, i) => { pins[n] = pin(0, y(r0 + i), 'w', op2 === 'or' ? orBack(16, gy0, 56, gy1, y(r0 + i)) : 16, y(r0 + i)); });
    svg.unshift(`<path class="inner" d="M56,${gm} H${back(gm)}"/>`);
    svg.push(`<path class="sym" d="${Path[op2](16, gy0, 56, gy1)}"/>`);
  }
  singles.forEach((n, i) => { pins[n] = pin(0, y(sr[i]), 'w', back(y(sr[i])), y(sr[i])); });
  pins[out] = pin(w, m, 'e', ox1, m, null, 'bubble');
  return { w, h, pins, svg: svg.join('') };
}

function mos(type, { weak = false, cls = 'sym' } = {}) {
  // A MOS transistor, 48 by 64: gate from the west, a north, b south; the channel line carries class ch.
  return `<path class="${cls}" d="M24,18 V46"/><path class="ch${weak ? ' weak' : ''}" d="M30,14 V50"/>`
    + `<path class="${cls}" d="M30,16 H32 M30,48 H32"/>` + (weak ? '<text class="pl" x="40" y="36">w</text>' : '');
}

function mosSym(type, weak = false) {
  const p = type === 'P';
  return { w: 48, h: 64, pins: { gate: pin(0, 32, 'w', 24, 32, null, p ? 'bubble' : null), a: pin(32, 0, 'n', 32, 16), b: pin(32, 64, 's', 32, 48) },
    svg: mos(type, { weak }) };
}

function box(w, h, labels, pins, title, my = 0) {
  // A rectangle from x 16 to w - 16 and y my to h - my, with pins {name: [x, y, dir]} labelled by labels
  // {name: [label, mark]}.
  const out = {};
  for (const [n, [x, y, dir]] of Object.entries(pins)) {
    const [dx, dy] = DIR[dir], [lb, mark] = labels[n] || [];
    out[n] = pin(x, y, dir, dx < 0 ? 16 : dx > 0 ? w - 16 : x, dy < 0 ? my : dy > 0 ? h - my : y, lb, mark);
  }
  return { w, h, pins: out, svg: `<rect class="sym" x="16" y="${my}" width="${w - 32}" height="${h - 2 * my}" rx="2"/>`
    + (title ? `<text class="pl dim" x="${w / 2}" y="${h - 6}" text-anchor="middle">${title}</text>` : '') };
}

const SCHMITT = (x, y) => `<path class="qual" d="M${x - 7},${y + 4} h9 v-8 M${x - 2},${y + 4} v-8 h9"/>`;

function stageSym(name, t) {
  // The symbol of stage type name, pins by its roles (extract/build.py).
  const weak = name.startsWith('weak_');
  if (t.kind === 'tg')
    return { w: 64, h: 64, pins: { a: pin(0, 32, 'w', 16, 32), b: pin(64, 32, 'e', 48, 32), gn: pin(32, 0, 'n', 32, 26),
      gp: pin(32, 64, 's', 32, 38, null, 'bubble') },
    svg: '<path class="sym" d="M16,20 L48,32 L16,44 Z"/><path class="sym" d="M48,20 L16,32 L48,44 Z"/>' };
  if (name === 'gated_pullup')
    return { w: 48, h: 64, pins: { a: pin(0, 32, 'w', 24, 32, null, 'bubble'), y: pin(32, 64, 's', 32, 48) },
      svg: '<path class="sym" d="M20,4 H44 M32,4 V16"/>' + mos('P') };
  if (name === 'weak_pulldown')
    return { w: 32, h: 64, pins: { y: pin(16, 0, 'n', 16, 12) },
      svg: '<polyline class="sym" points="16,12 16,16 8,20 24,26 8,32 24,38 16,42 16,46"/><path class="sym" d="M4,46 H28 M9,51 H23 M14,56 H18"/>' };
  if (name === 'split_inv')
    return { w: 80, h: 64, pins: { b: pin(0, 16, 'w', 16, 16, 'P'), a: pin(0, 48, 'w', 16, 48, 'N'), y: pin(80, 32, 'e', 48, 32, null, 'bubble') },
      svg: `<path class="sym" d="${Path.buf(16, 4, 48, 60)}"/>` };
  if (name === 'mux2_inv')
    return { w: 96, h: 64, pins: { a: pin(0, 16, 'w', 16, 16, '0'), c: pin(0, 48, 'w', 16, 48, '1'), d: pin(32, 64, 's', 32, 60.6, 'S'),
      b: pin(48, 64, 's', 48, 57.1, 'S̄'), y: pin(96, 32, 'e', 72, 32, null, 'bubble') },
    svg: '<path class="sym" d="M16,0 L72,12 V52 L16,64 Z"/>' };
  if (t.kind === 'pass')
    return { w: 48, h: 64, pins: {}, svg: mos('P', { cls: 'sym dummy' }) };
  if (t.kind === 'cmos' && t.n) {
    const n = t.n;
    if (typeof n === 'string') return gate('buf', true, [n], 'y', { w: 64, weak });
    if (n[1].every(k => typeof k === 'string')) return gate(n[0], true, n[1], 'y');
    if (n[1].every(k => typeof k === 'string' || k[1].every(j => typeof j === 'string'))) return compound(n, 'y');
  }
  const ins = t.ports.filter(r => r !== 'y' && !/^[mt]\d/.test(r)), { ys, h } = rows(Math.max(1, ins.length));
  return box(96, h, {}, { ...Object.fromEntries(ins.map((r, i) => [r, [0, ys[i], 'w']])), ...(t.ports.includes('y') ? { y: [96, h / 2, 'e'] } : {}) }, name);
}

function cellSym(name, c) {
  // The symbol of a cell type of several stages, pins by its roles; null for a one-stage type, drawn as its stage.
  if (c.stages.length === 1) return null;
  const L = SYM.cells[name] || {};
  switch (name) {
    case 'buf': return gate('buf', false, ['in0'], 'out0', { w: 64 });
    case 'or2': case 'and2': return gate(name.slice(0, -1), false, ['in0', 'in1'], 'out0');
    case 'schmitt': {
      const s = gate('buf', true, ['in0'], 'out0', { minRows: 3 });
      s.svg += SCHMITT(31, s.h / 2);
      return s;
    }
    case 'mux2':
      return { w: 96, h: 64, pins: { in1: pin(0, 16, 'w', 16, 16, '0'), in2: pin(0, 48, 'w', 16, 48, '1'), in0: pin(48, 64, 's', 48, 57.1, 'S'),
        out0: pin(96, 32, 'e', 72, 32, null, 'bubble') }, svg: '<path class="sym" d="M16,0 L72,12 V52 L16,64 Z"/>' };
    case 'tristate_out':
      return { w: 80, h: 64, pins: { in0: pin(0, 32, 'w', 16, 32), in1: pin(32, 64, 's', 32, 48.8), out0: pin(80, 32, 'e', 56, 32, null, 'bubble') },
        svg: `<path class="sym" d="${Path.buf(16, 4, 56, 60)}"/><path class="qual" d="M21,29 h8 l-4,7 z"/>`
          + '<text class="pl" x="36" y="62">EN</text>' };
  }
  if (name.startsWith('dff')) {
    const left = Object.keys(L).filter(r => r.startsWith('in') && !['S', 'R'].includes(L[r][0]));
    const set = Object.keys(L).find(r => L[r][0] === 'S'), reset = Object.keys(L).find(r => L[r][0] === 'R');
    const h = 16 * (left.length + 4), pins = Object.fromEntries(left.map((r, i) => [r, [0, 16 * (i + 2), 'w']]));
    pins.out0 = [96, 32, 'e'];
    if (set) pins[set] = [48, 0, 'n'];
    if (reset) pins[reset] = [48, h, 's'];
    return box(96, h, L, pins, null, 16);
  }
  const { ys, h } = rows(Math.max(c.ins.length, c.outs.length));
  return box(96, h, L, { ...Object.fromEntries(c.ins.map((r, i) => [r, [0, ys[i], 'w']])),
    ...Object.fromEntries(c.outs.map((r, i) => [r, [96, ys[i], 'e']])) }, name);
}

function symMark(x, y, dir, kind) {
  // A pin mark at the body edge (x, y): a clock wedge pointing inward, a bubble outside, or both.
  const [dx, dy] = DIR[dir], out = [];
  if (kind === 'bubble' || kind === 'nclock') out.push(`<circle class="sym" cx="${x + dx * B}" cy="${y + dy * B}" r="${B}"/>`);
  if (kind === 'clock' || kind === 'nclock') {
    const [px, py] = [-dy, dx];   // along the edge
    out.push(`<path class="qual" d="M${x + 5 * px},${y + 5 * py} L${x - 7 * dx},${y - 7 * dy} L${x - 5 * px},${y - 5 * py}"/>`);
  }
  return out.join('');
}

function symLabel(x, y, dir, s, inset, vertical = false) {
  // A pin's name inside the body, next to the pin.
  const [dx, dy] = DIR[dir], anchor = dx < 0 ? 'start' : dx > 0 ? 'end' : 'middle';
  const bar = OVER[s] ? ' style="text-decoration:overline"' : '';
  const t = OVER[s] || s;
  if (dy && vertical) {   // on a block's top or bottom edge, turned to read upward, so close pins' names fit
    const ty = y - dy * inset;
    return `<text class="pl" x="${x + 3}" y="${ty}" text-anchor="${dy > 0 ? 'start' : 'end'}" transform="rotate(-90 ${x + 3} ${ty})"${bar}>${t}</text>`;
  }
  if (dy) return `<text class="pl" x="${x}" y="${dy < 0 ? y + inset + 8 : y - inset - 1}" text-anchor="middle"${bar}>${t}</text>`;
  return `<text class="pl" x="${x - dx * inset}" y="${y + 3.5}" text-anchor="${anchor}"${bar}>${t}</text>`;
}

const Symbols = {
  data: SYM,
  DIR,

  build(nl) {
    // {key: symbol} for the netlist: nmos, pmos (and _w, weak), vdd, gnd, stage.<type>, cell.<type> of several stages.
    const out = { nmos: mosSym('N'), pmos: mosSym('P'), nmos_w: mosSym('N', true), pmos_w: mosSym('P', true),
      vdd: { w: 32, h: 32, pins: { p: pin(16, 32, 's', 16, 8) }, svg: '<path class="sym" d="M4,8 H28"/>' },
      gnd: { w: 32, h: 32, pins: { p: pin(16, 0, 'n', 16, 16) }, svg: '<path class="sym" d="M4,16 H28 M9,21 H23 M14,26 H18"/>' } };
    for (const [k, t] of Object.entries(nl.types.stage)) out[`stage.${k}`] = stageSym(k, t);
    for (const [k, c] of Object.entries(nl.types.cell)) { const s = cellSym(k, c); if (s) out[`cell.${k}`] = s; }
    return out;
  },

  draw(sym, key = () => '', cls = '') {
    // sym's markup: leads (wires keyed key(pin)), body, marks and labels.
    const out = [];
    for (const [n, p] of Object.entries(sym.pins)) {
      const [dx, dy] = DIR[p.dir], b = p.mark === 'bubble' || p.mark === 'nclock' ? 2 * B : 0;
      out.push(`<line class="w" data-key="${key(n)}" x1="${p.at[0]}" y1="${p.at[1]}" x2="${p.end[0] + dx * b}" y2="${p.end[1] + dy * b}"/>`);
    }
    out.push(cls ? `<g class="${cls}">${sym.svg}</g>` : sym.svg);
    for (const p of Object.values(sym.pins)) {
      if (p.mark) out.push(symMark(p.end[0], p.end[1], p.dir, p.mark));
      if (p.label) out.push(symLabel(p.end[0], p.end[1], p.dir, p.label, p.mark === 'clock' || p.mark === 'nclock' ? 10 : 3));
    }
    return out.join('');
  },

  orient(o, w, h) {
    // A part of w by h turned by o {rot: 0, 90, 180 or 270 degrees clockwise, flip: mirrored left to right
    // first}: its size {w, h}, map([x, y]) and dir(d) for its points and pin directions, and the SVG matrix m.
    let m = o.flip ? [-1, 0, 0, 1, w, 0] : [1, 0, 0, 1, 0, 0], cw = w, ch = h;
    for (let r = 0; r < (o.rot || 0); r += 90) {   // (x, y) -> (ch - y, x)
      const [a, b, c, d, e, f] = m;
      m = [-b, a, -d, c, ch - f, e];
      [cw, ch] = [ch, cw];
    }
    const map = ([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const dir = d => { const [dx, dy] = DIR[d], x = m[0] * dx + m[2] * dy, y = m[1] * dx + m[3] * dy;
      return x < 0 ? 'w' : x > 0 ? 'e' : y < 0 ? 'n' : 's'; };
    return { w: cw, h: ch, m, map, dir, turned: !!(o.flip || o.rot) };
  },

  block(name, w, h, pins = []) {
    // A block's outline at w by h, its title, subtitle and qualifier, and pin marks and labels;
    // pins: [{at: [x, y], dir, label?, mark?}] on the outline. The wires to the pins belong to the layout.
    const b = SYM.blocks[name] || { shape: 'box', title: name }, sh = SYM.shapes[b.shape];
    const pts = sh.outline.map(([fx, fy]) => `${fx * w},${fy * h}`).join(' ');
    const fs = Math.min(h / 4, 36, 0.75 * w / (0.68 * b.title.length));   // the title as large as fits, for reading at the chip's scale
    const out = [`<polygon class="sym blk" points="${pts}"/>`,
      `<text class="bt" x="${w / 2}" y="${h / 2 + fs * 0.1}" text-anchor="middle" style="font-size:${fs}px">${b.title}</text>`];
    if (b.sub) out.push(`<text class="bs" x="${w / 2}" y="${h / 2 + fs * 0.1 + fs * 0.8}" text-anchor="middle" style="font-size:${fs * 0.55}px">${b.sub}</text>`);
    const qx = w / 2, qy = h / 2 - fs * 1.3;
    if (b.qualifier === 'astable')   // a pulse train: IEEE Std 91's astable element
      out.push(`<path class="qual" d="M${qx - 16},${qy + 4} h4 v-8 h8 v8 h8 v-8 h8 v8 h4"/>`);
    else if (b.qualifier === 'schmitt') out.push(SCHMITT(qx, qy));
    else if (b.qualifier) out.push(`<text class="pl" x="${qx}" y="${qy + 4}" text-anchor="middle">${b.qualifier}</text>`);
    for (const p of pins) {
      if (p.mark) out.push(symMark(p.at[0], p.at[1], p.dir, p.mark));
      if (p.label) out.push(symLabel(p.at[0], p.at[1], p.dir, p.label, 4, true));
    }
    return out.join('');
  },
};

if (typeof module !== 'undefined') module.exports = Symbols;
