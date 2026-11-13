// Wire router on a 16-unit grid, ported from falstad/route.py: a net's wire grows one terminal at a time, by A*
// search from the terminal to the nearest point already on the net's wire, in horizontal and vertical steps.
// A step may not enter a part's body or another net's post, may not run along another net's wire, and may
// cross one only straight across. Bends and crossings cost extra, so wires stay straight and apart.
const G = 16;
const BEND = 6, CROSS = 4;   // extra cost of a bend and of crossing another net, in grid steps
const STEPS = [[G, 0], [-G, 0], [0, G], [0, -G]];
const OFF = 1 << 15;   // keeps negative coordinates' keys apart
const pk = (x, y) => (x + OFF) * 65536 + (y + OFF);
const unpk = k => [Math.floor(k / 65536) - OFF, k % 65536 - OFF];

class Heap {
  // A binary min-heap of [f, c, ...] arrays, ordered by f then c.
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  less(i, j) { const x = this.a[i], y = this.a[j]; return x[0] < y[0] || x[0] === y[0] && x[1] < y[1]; }
  push(v) {
    const a = this.a;
    a.push(v);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(l, m)) m = l;
        if (r < a.length && this.less(r, m)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

class Router {
  constructor([x0, y0, x1, y1]) {
    Object.assign(this, { x0, y0, x1, y1 });   // search area
    this.blocked = new Set();   // points no wire may use
    this.owner = new Map();     // point -> net whose post it is
    this.wire = new Map();      // point -> Map(net -> Set of 'h'/'v', the ways its wire runs there)
    this.ends = new Map();      // point -> net with a wire end or bend there
  }

  blockRect(x0, y0, x1, y1) {
    for (let x = x0 - ((x0 % G) + G) % G; x <= x1; x += G)
      for (let y = y0 - ((y0 % G) + G) % G; y <= y1; y += G) this.blocked.add(pk(x, y));
  }

  post([x, y], net) { this.owner.set(pk(x, y), net); }

  free(p, x, y, net, axis, ends) {
    // Whether net's wire may pass through point p (= pk(x, y)) along axis; ends: p is an end or bend there.
    if (x < this.x0 || x > this.x1 || y < this.y0 || y > this.y1) return false;
    const own = this.owner.get(p);
    if (own !== undefined && own !== net) return false;
    if (this.blocked.has(p) && own !== net) return false;
    const w = this.wire.get(p);
    if (w) for (const [n, d] of w) if (n !== net && (ends || d.has(axis))) return false;
    const e = this.ends.get(p);
    return e === undefined || e === net;
  }

  commit(net, runs) {
    // Mark runs [[a, b]] as net's wire.
    for (const [a, b] of runs) {
      const axis = a[1] === b[1] ? 'h' : 'v';
      for (const [x, y] of Router.points(a, b)) {
        const p = pk(x, y);
        if (!this.wire.has(p)) this.wire.set(p, new Map());
        const m = this.wire.get(p);
        if (!m.has(net)) m.set(net, new Set());
        m.get(net).add(axis);
      }
      this.ends.set(pk(...a), net);
      this.ends.set(pk(...b), net);
    }
  }

  route(net, terminals) {
    // A wire joining terminals [[x, y]]: [[a, b]] straight runs, or null if one cannot be reached.
    const tree = new Set([pk(...terminals[0])]), edges = new Set();
    const t0 = terminals[0], dist = t => Math.abs(t[0] - t0[0]) + Math.abs(t[1] - t0[1]);
    for (const t of terminals.slice(1).sort((a, b) => dist(a) - dist(b))) {
      if (tree.has(pk(...t))) continue;
      const path = this.search(net, t, tree);
      if (!path) return null;
      for (let i = 1; i < path.length; i++) edges.add(Math.min(path[i - 1], path[i]) + ' ' + Math.max(path[i - 1], path[i]));
      for (const p of path) tree.add(p);
    }
    const runs = Router.runs(edges);
    this.commit(net, runs);
    return runs;
  }

  search(net, [sx, sy], goal) {
    // A* from (sx, sy) to any point of goal; returns the path's point keys.
    const gs = goal.size < 40 ? [...goal].map(unpk) : null;
    const h = (x, y) => gs ? Math.floor(Math.min(...gs.map(g => Math.abs(x - g[0]) + Math.abs(y - g[1]))) / G) : 0;
    const AX = [null, 'h', 'v'], s0 = pk(sx, sy) * 4;   // state: point key * 4 + axis (0 none, 1 h, 2 v)
    const came = new Map([[s0, null]]), cost = new Map([[s0, 0]]), todo = new Heap();
    todo.push([h(sx, sy), 0, sx, sy, 0]);
    while (todo.size) {
      const [, c, x, y, d] = todo.pop(), p = pk(x, y), st = p * 4 + d;
      if (goal.has(p)) {
        const path = [];
        for (let s = st; s !== null; s = came.get(s)) path.push(Math.floor(s / 4));
        return path.reverse();
      }
      if (c > (cost.get(st) ?? Infinity)) continue;
      for (const [dx, dy] of STEPS) {
        const qx = x + dx, qy = y + dy, q = pk(qx, qy), ax = dy === 0 ? 1 : 2;
        const bend = d !== 0 && d !== ax;
        if (!this.free(q, qx, qy, net, AX[ax], goal.has(q)) || bend && !this.free(p, x, y, net, AX[ax], true)) continue;
        const nc = c + 1 + (bend ? BEND : 0) + (this.wire.has(q) ? CROSS : 0), qs = q * 4 + ax;
        if (nc < (cost.get(qs) ?? Infinity)) {
          cost.set(qs, nc);
          came.set(qs, st);
          todo.push([nc + h(qx, qy), nc, qx, qy, ax]);
        }
      }
    }
    return null;
  }

  static points(a, b) {
    const out = [];
    if (a[0] === b[0]) for (let y = Math.min(a[1], b[1]); y <= Math.max(a[1], b[1]); y += G) out.push([a[0], y]);
    else for (let x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x += G) out.push([x, a[1]]);
    return out;
  }

  static runs(edges) {
    // Merge grid edges ('k1 k2' point-key pairs) into straight runs, split where three or more meet or it bends.
    const adj = new Map(), add = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
    for (const e of edges) { const [a, b] = e.split(' ').map(Number); add(a, b); add(b, a); }
    const through = p => {
      const n = adj.get(p);
      if (n.size !== 2) return false;
      const [a, b] = [...n].map(unpk), q = unpk(p);
      return a[0] === b[0] && b[0] === q[0] || a[1] === b[1] && b[1] === q[1];
    };
    const done = new Set(), out = [], ek = (a, b) => Math.min(a, b) + ' ' + Math.max(a, b);
    for (const a of adj.keys()) {
      if (through(a)) continue;
      for (const b of adj.get(a)) {
        if (done.has(ek(a, b))) continue;
        let prev = a, cur = b;
        done.add(ek(prev, cur));
        while (through(cur)) {
          const nxt = [...adj.get(cur)].find(n => n !== prev);
          [prev, cur] = [cur, nxt];
          done.add(ek(prev, cur));
        }
        out.push([unpk(a), unpk(cur)]);
      }
    }
    return out;
  }
}

function routeSheet(sheet, nets, keep = [], tagged = new Set(), passes = 6) {
  // Wire nets of sheet {box, rects, posts: {net: [[x, y, dir]]}} around the wires kept [{net, pts}]. Nets in
  // tagged, and any the router cannot place, get tags instead. A pass that leaves nets unplaced is retried with
  // those nets first; the pass with fewest unplaced nets wins. Returns {wires, tags, failed}.
  const [bx0, by0, bx1, by1] = sheet.box;
  let order = nets.filter(n => !tagged.has(n) && sheet.posts[n])
    .sort((a, b) => sheet.posts[a].length - sheet.posts[b].length || (a < b ? -1 : a > b ? 1 : 0));
  let best = null;
  for (let i = 0; i < passes; i++) {
    const r = new Router(sheet.box);
    for (const rc of [...sheet.rects, [bx0, by0, bx1, by0], [bx0, by1, bx1, by1], [bx0, by0, bx0, by1], [bx1, by0, bx1, by1]])
      r.blockRect(...rc);   // parts, and the outline: wires leave a pin straight inward
    for (const [net, ps] of Object.entries(sheet.posts)) for (const p of ps) r.post(p, net);
    for (const w of keep) r.commit(w.net, w.pts.slice(1).map((b, j) => [w.pts[j], b]));
    const wires = [], failed = [];
    for (const net of order) {
      const pts = sheet.posts[net].map(p => [p[0], p[1]]);
      const runs = pts.length > 1 ? r.route(net, pts) : [];
      if (runs === null) failed.push(net);
      else for (const [a, b] of runs) wires.push({ net, pts: [a, b] });
    }
    if (!best || failed.length < best.failed.length) best = { wires, failed };
    if (!failed.length) break;
    order = [...failed, ...order.filter(n => !failed.includes(n))];
  }
  const tags = [];
  for (const net of nets) if ((tagged.has(net) || best.failed.includes(net)) && sheet.posts[net])
    for (const [x, y, dir] of sheet.posts[net]) tags.push({ net, at: [x, y], dir });
  return { wires: best.wires, tags, failed: best.failed };
}

const SUPPLIES = ['VDD', 'GND'];

function layoutSheet(L, S) {
  // Layout L's routing problem {box, rects, posts}: its pins, and its parts' pins (placed, turned and flipped as
  // the layout says, a block's from its own layout), with the parts' bodies as obstacles. VDD and GND are left
  // out: a supply symbol's short wire joins each pin on them. S: site/symbols.js's Symbols.build.
  const posts = {}, rects = [], add = (net, x, y, dir) => { if (!SUPPLIES.includes(net)) (posts[net] ??= []).push([x, y, dir]); };
  for (const [net, p] of Object.entries(L.pins)) add(net, ...p.at, p.dir);
  for (const lp of Object.values(L.parts)) {
    const s = S[lp.sym], w = s ? s.w : lp.w, h = s ? s.h : lp.h, o = Symbols.orient(lp, w, h);
    rects.push([lp.at[0], lp.at[1], lp.at[0] + o.w, lp.at[1] + o.h]);
    let pins;
    if (s) pins = Object.entries(s.pins).map(([n, p]) => [lp.nets?.[n], p.at, p.dir]);
    else { const B = LAYOUTS[`block.${lp.block}`]; pins = Object.entries(B.pins).map(([n, p]) => [n, [p.at[0] / B.k, p.at[1] / B.k], p.dir]); }
    for (const [net, at, dir] of pins) if (net != null) { const [x, y] = o.map(at); add(net, lp.at[0] + x, lp.at[1] + y, o.dir(dir)); }
  }
  return { box: [0, 0, L.w, L.h], rects, posts };
}

const Route = { G, Router, routeSheet, layoutSheet, SUPPLIES };
if (typeof module !== 'undefined') module.exports = Route;
