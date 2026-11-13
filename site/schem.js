// The chip as an openable schematic: the chip, its blocks, their cells, the cells' stages (gates) and the stages'
// transistors. Each is drawn closed as its symbol (site/symbols.js), or open as its layout
// (site/gen/layouts) scaled into the closed outline, so the wires outside it never move. Each part that opens has a
// label at its top left, sized with the part and shown once its text is MIN_LABEL_PX high on screen; a click on it
// opens or closes the part (toggle), and holds it so. Other parts open when drawn wider than OPEN_PX screen pixels
// and in view, and close below CLOSE_PX.
// Wires and leads carry data-key 'n<net>' (the netlist's index); a transistor's channel carries data-tr, its indices.
const OPEN_PX = 400, CLOSE_PX = 300;
const MIN_LABEL_PX = 9;   // a part's open/close label shows once its text is this high on screen
const LABEL = 9, LABEL_MIN_PX = 7, LABEL_MAX_PX = 16;   // a layout's small text, in its units; hidden below, shrunk above, in screen px
const ID = [1, 0, 0, 1, 0, 0];
const NS = 'http://www.w3.org/2000/svg';

function mul(A, B) {
  // The SVG matrix [a, b, c, d, e, f] applying B, then A.
  return [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
}

function junctions(L) {
  // Points where three or more wire ends of one net meet, or a wire ends on another's middle: [[x, y, net]].
  const ends = new Map(), out = [];
  for (const w of L.wires) for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) {
    const k = `${w.net} ${p}`;
    ends.set(k, (ends.get(k) || 0) + 1);
  }
  const inside = (p, [a, b]) => (a[0] === b[0] && p[0] === a[0] && p[1] > Math.min(a[1], b[1]) && p[1] < Math.max(a[1], b[1]))
    || (a[1] === b[1] && p[1] === a[1] && p[0] > Math.min(a[0], b[0]) && p[0] < Math.max(a[0], b[0]));
  const middle = (p, pts) => pts.slice(1).some((b, i) => inside(p, [pts[i], b])) || pts.slice(1, -1).some(q => q[0] === p[0] && q[1] === p[1]);
  for (const [k, n] of ends) {
    const i = k.lastIndexOf(' '), net = k.slice(0, i), p = k.slice(i + 1).split(',').map(Number);
    if (n >= 3 || L.wires.some(w => w.net === net && middle(p, w.pts))) out.push([...p, net]);
  }
  return out;
}

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

class SchemView {
  // svg: the <svg>; g: the <g> to draw the chip into, in the svg's user units; box: the chip's outline there.
  constructor(svg, g, nl, box) {
    Object.assign(this, { svg, g, nl, box });
    this.S = Symbols.build(nl);
    this.netIndex = new Map(nl.nets.map((n, i) => [n.name, i]));
    this.cellIndex = new Map(nl.cells.map((c, i) => [c.name, i]));
    this.forced = new Map();   // node id -> true (open) or false (closed), from label clicks
    this.dots = new Map();     // layout name -> junctions
    const L = LAYOUTS.chip;
    this.root = { id: 'chip', kind: 'chip', name: nl.name, layout: 'chip', x: box.x, y: box.y, w0: box.w, h0: box.w * L.h / L.w,
      key: n => this.globalKey(n), open: true };
    this.root.w = this.root.w0; this.root.h = this.root.h0;
    this.render(this.root);
    g.appendChild(this.root.el);
  }

  supplyKey(n) { return n === 'VDD' ? `n${this.nl.vdd}` : n === 'GND' ? `n${this.nl.gnd}` : null; }
  globalKey(n) { return this.supplyKey(n) ?? (this.netIndex.has(n) ? `n${this.netIndex.get(n)}` : ''); }

  child(node, id, lp) {
    // The node for part id of node's layout, placed at lp.
    const c = { id: `${node.id}/${id}`, lid: id, lp, x: lp.at[0], y: lp.at[1], parent: node, open: false };
    const sup = this.supplyKey.bind(this);
    if (lp.sym === 'vdd' || lp.sym === 'gnd') Object.assign(c, { kind: 'supply', sym: lp.sym });
    else if (lp.sym === 'block') {
      const L = LAYOUTS[`block.${lp.block}`];
      Object.assign(c, { kind: 'block', name: lp.block, layout: L ? `block.${lp.block}` : null, w0: lp.w, h0: lp.h, key: node.key });
    } else if (node.kind === 'stage') {
      const st = this.nl.stages[node.stage];
      Object.assign(c, { kind: 'mos', sym: lp.sym, tr: st.ts[id] || [] });
    } else {
      let si = null, ci = null;
      if (node.kind === 'block') ci = this.cellIndex.get(id);
      else if (node.kind === 'cell') si = this.nl.cells[node.cell].stages[+id.slice(1)];
      const cell = ci !== null ? this.nl.cells[ci] : null;
      if (cell && this.nl.types.cell[cell.type].stages.length === 1) si = cell.stages[0];
      if (si !== null) {
        const st = this.nl.stages[si];
        Object.assign(c, { kind: 'stage', stage: si, name: cell ? cell.name : `${id}`, type: st.type, sym: lp.sym,
          layout: LAYOUTS[`stage.${st.type}`] ? `stage.${st.type}` : null, key: r => sup(r) ?? (r in st.nets ? `n${st.nets[r]}` : '') });
      } else {
        Object.assign(c, { kind: 'cell', cell: ci, name: cell.name, type: cell.type, sym: lp.sym,
          layout: LAYOUTS[`cell.${cell.type}`] ? `cell.${cell.type}` : null, key: r => sup(r) ?? (r in cell.nets ? `n${cell.nets[r]}` : '') });
      }
    }
    if (c.sym) { const s = this.S[c.sym]; c.w0 = s.w; c.h0 = s.h; }
    c.turn = Symbols.orient({ rot: lp.rot, flip: lp.flip }, c.w0, c.h0);
    c.w = c.turn.w; c.h = c.turn.h;
    c.open = !!c.layout && (this.forced.get(c.id) ?? false);
    return c;
  }

  title(node) {
    // An open part's name tab: its name and type.
    if (node.kind === 'chip') return node.name;
    if (node.kind === 'block') return `${node.name} · ${(Symbols.data.blocks[node.name] || {}).sub || 'block'}`;
    const where = node.parent.kind === 'cell' ? `${node.parent.name}.${node.lid}` : node.name;
    return `${where} · ${node.type}`;
  }

  render(node) {
    // (Re)draw node's group: closed, or open with its children.
    const el = node.el || (node.el = document.createElementNS(NS, 'g'));
    el.setAttribute('transform', `translate(${node.x},${node.y})`);
    node.children = [];
    const m = node.turn?.turned ? node.turn.m : ID;
    const L = node.open && node.layout && LAYOUTS[node.layout];
    if (!L) {
      node.open = false;
      el.innerHTML = `<g data-node="${node.id}" class="part ${node.kind}"${node.turn?.turned ? ` transform="matrix(${m})"` : ''}>`
        + (node.kind === 'supply' || node.kind === 'mos' ? '' : `<rect class="hit" width="${node.w0}" height="${node.h0}"/>`)
        + this.closed(node) + '</g>' + this.toggleLabel(node);
      this.upright(el, node);
      return;
    }
    const s = node.sc = node.w0 / L.w;
    const out = [`<g transform="matrix(${m})"><rect class="frame ${node.kind}" data-node="${node.id}" data-frame="1" width="${node.w0}" height="${node.h0}" rx="${Math.min(node.w0, node.h0) * 0.012}"/>`,
      `<g transform="scale(${s})">`];
    L.wires.forEach((w, i) => out.push(`<polyline class="w" data-key="${node.key(w.net)}" data-w="${node.id}|${i}" points="${w.pts.join(' ')}"/>`));
    if (!this.dots.has(node.layout)) this.dots.set(node.layout, junctions(L));
    for (const [x, y, net] of this.dots.get(node.layout)) out.push(`<circle class="dot" data-key="${node.key(net)}" cx="${x}" cy="${y}" r="4"/>`);
    L.tags.forEach(t => out.push(this.tag(t, node.key(t.net))));
    for (const [n, p] of Object.entries(L.pins)) if (p.label && node.kind !== 'chip') out.push(this.pinLabel(p));
    out.push('</g>');
    out.push('</g>', this.toggleLabel(node));
    el.innerHTML = out.join('');
    const inner = el.firstElementChild.children[1];
    for (const [id, lp] of Object.entries(L.parts)) {
      const c = this.child(node, id, lp);
      node.children.push(c);
      this.render(c);
      inner.appendChild(c.el);
    }
  }

  upright(el, node) {
    // Turn a turned part's text back upright about its anchor.
    if (!node.turn?.turned) return;
    const q = node.turn.m, inv = [q[0], q[2], q[1], q[3], 0, 0];   // a turn's inverse is its transpose
    for (const t of el.querySelectorAll('text')) {
      const x = +t.getAttribute('x'), y = +t.getAttribute('y');
      t.setAttribute('transform', `translate(${x} ${y}) matrix(${inv}) translate(${-x} ${-y})`);
    }
  }

  closed(node) {
    // node's closed symbol; its leads carry the parent layout's nets' keys.
    if (node.kind === 'block') {
      const L = LAYOUTS[node.layout], k = L ? L.k : 1;
      const pins = L ? Object.values(L.pins).map(p => ({ ...p, at: [p.at[0] / k, p.at[1] / k] })) : [];
      return Symbols.block(node.name, node.w0, node.h0, pins);
    }
    const nets = node.lp.nets || {}, pk = node.parent.key;
    if (node.kind === 'supply') return Symbols.draw(this.S[node.sym], () => pk(node.sym.toUpperCase()));
    let s = Symbols.draw(this.S[node.sym], p => pk(nets[p]));
    if (node.kind === 'mos') s = s.replace('class="ch', `data-tr="${node.tr.join(' ')}" class="ch`);
    return s;
  }

  toggleLabel(node) {
    // The label that opens or closes node, above its top left corner; update() sizes it.
    if (!node.layout) return '';
    const s = node.open ? `▾ ${this.title(node)}` : `▸ ${node.parent.kind === 'cell' ? node.type : node.name}`;
    const F = node.labelF = Math.max(6, Math.min(24, 0.12 * Math.min(node.w, 2 * node.h))), w = 0.62 * F * s.length + F, h = 1.6 * F;
    return `<g class="olab${node.open ? ' open' : ''}" data-toggle="${node.id}" style="display:none">`
      + `<rect class="olabbg" x="0" y="${-h - 2}" width="${w}" height="${h}" rx="${F / 4}"/>`
      + `<text class="olabt" x="${F / 2}" y="${-0.48 * F - 2}" style="font-size:${F}px">${escHtml(s)}</text></g>`;
  }

  tag(t, key) {
    // A net label at a pin, pointing away from it; upright text runs up from a top or bottom pin, so close pins' tags fit.
    const s = t.net, len = 6.5 * s.length + 10, th = 14, v = t.dir === 'n' || t.dir === 's';
    const [w, h] = v ? [th, len] : [len, th];
    const x = t.dir === 'w' ? t.at[0] - w - 4 : t.dir === 'e' ? t.at[0] + 4 : t.at[0] - w / 2;
    const y = t.dir === 's' ? t.at[1] + 4 : t.dir === 'n' ? t.at[1] - h - 4 : t.at[1] - h / 2;
    const [x1, y1] = t.dir === 'w' ? [x + w, t.at[1]] : t.dir === 'e' ? [x, t.at[1]] : t.dir === 's' ? [t.at[0], y] : [t.at[0], y + h];
    const cx = x + w / 2, cy = y + h / 2;
    return `<g class="tagg" data-key="${key}" data-ax="${t.at[0]}" data-ay="${t.at[1]}"><line class="w" data-key="${key}" x1="${t.at[0]}" y1="${t.at[1]}" x2="${x1}" y2="${y1}"/>`
      + `<rect class="tag" data-key="${key}" x="${x}" y="${y}" width="${w}" height="${h}" rx="7"/>`
      + `<text class="tt" x="${cx}" y="${cy + 3.5}" text-anchor="middle"${v ? ` transform="rotate(-90 ${cx} ${cy})"` : ''}>${escHtml(s)}</text></g>`;
  }

  pinLabel(p) {
    // An open block's pin name, just inside its frame.
    const [dx, dy] = Symbols.DIR[p.dir], anchor = dx < 0 ? 'start' : dx > 0 ? 'end' : 'middle';
    return `<text class="pinl" data-ax="${p.at[0]}" data-ay="${p.at[1]}" x="${p.at[0] - dx * 8}" y="${p.at[1] - dy * 10 + 4 - 6 * Math.abs(dx)}" text-anchor="${anchor}">${escHtml(p.label)}</text>`;
  }

  find(id, node = this.root) {
    if (node.id === id) return node;
    for (const c of node.children || []) { const f = this.find(id, c); if (f) return f; }
    return null;
  }

  toggle(id, open) {
    // Open a closed part, or close an open one and the parts open inside it.
    const node = this.find(id);
    if (!node || !node.layout || node === this.root) return false;
    node.open = open ?? !node.open;
    for (const k of [...this.forced.keys()]) if (k.startsWith(`${id}/`)) this.forced.delete(k);
    this.forced.set(id, node.open);
    this.render(node);
    return true;
  }

  release() {
    // Close every part.
    this.forced.clear();
    this.render(this.root);
  }

  update() {
    // Open or close parts by their size on screen, unless a label click holds them; size labels for
    // the zoom. Returns whether any part opened or closed.
    const ctm = this.svg.getScreenCTM(), r = this.svg.getBoundingClientRect();
    if (!ctm) return false;
    let changed = false;
    const visit = (node, P) => {   // P: node's parent frame to screen pixels
      const S = mul(P, [1, 0, 0, 1, node.x, node.y]);
      if (node !== this.root && node.layout) {
        const [ax, ay] = [S[4], S[5]], [bx, by] = [S[0] * node.w + S[2] * node.h + S[4], S[1] * node.w + S[3] * node.h + S[5]];
        const seen = Math.min(ax, bx) < r.right && Math.max(ax, bx) > r.left && Math.min(ay, by) < r.bottom && Math.max(ay, by) > r.top;
        const px = Math.hypot(S[0], S[1]) * node.w;
        const want = this.forced.get(node.id) ?? (seen && px > (node.open ? CLOSE_PX : OPEN_PX));
        if (want !== node.open) { node.open = want; this.render(node); changed = true; }
        this.sizeLabel(node, Math.hypot(S[0], S[1]));
      }
      if (node.open) {
        const m = node.turn?.turned ? node.turn.m : ID;
        const Q = mul(mul(S, m), [node.sc, 0, 0, node.sc, 0, 0]);
        this.labels(node, Math.hypot(Q[0], Q[1]));
        for (const c of node.children) visit(c, Q);
      }
    };
    visit(this.root, [ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f]);
    return changed;
  }

  sizeLabel(node, k) {
    // Show node's open/close label once its text is MIN_LABEL_PX high; k: screen px per unit of node's frame.
    const el = node.el.querySelector(':scope > .olab');
    if (el) el.style.display = k * node.labelF >= MIN_LABEL_PX ? '' : 'none';
  }

  labels(node, k) {
    // Hide node's small text when it would be under LABEL_MIN_PX on screen; shrink its tags and pin names about
    // their pins when they would be over LABEL_MAX_PX. k: screen px per unit of node's layout.
    const inner = node.el.firstElementChild?.children[1];
    if (!inner) return;
    inner.classList.toggle('tiny', k * LABEL < LABEL_MIN_PX);
    const f = Math.min(1, LABEL_MAX_PX / (k * LABEL));
    if (node.tfEl === inner && Math.abs(node.tf - f) < 0.01) return;
    node.tf = f; node.tfEl = inner;
    for (const el of inner.querySelectorAll(':scope > .tagg, :scope > .pinl')) {
      const x = +el.dataset.ax, y = +el.dataset.ay;
      el.setAttribute('transform', f < 1 ? `translate(${x} ${y}) scale(${f}) translate(${-x} ${-y})` : '');
    }
  }

  path(id) {
    // The nodes from the root to id.
    const out = [];
    for (let n = this.find(id); n; n = n.parent) out.unshift(n);
    return out;
  }
}

if (typeof module !== 'undefined') module.exports = { SchemView, junctions, mul };
