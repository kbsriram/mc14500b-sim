// Switch-level simulator for the traced MC14500B: a port of py/sim.py over jssim/chip.js.
// Each transistor is a switch: an NMOS conducts while its gate is high, a PMOS while it is low.
// A net takes the value of a supply or pin it reaches through conducting switches; a weak
// transistor counts only when the strong switches reach none. A net that reaches neither keeps
// its charge: high if any net in its group is high.
const LOOPS = 100;

class Sim {
  constructor(chip) {
    this.chip = chip;
    const n = chip.nets.length;
    this.ts = chip.ts.map(([id, type, weak, gate, a, b]) => ({ id, n: type === 'N', weak: !!weak, gate, a, b }));
    this.gates = Array.from({ length: n }, () => []);
    this.terms = Array.from({ length: n }, () => []);
    this.ts.forEach((t, i) => { this.gates[t.gate].push(i); this.terms[t.a].push(i); this.terms[t.b].push(i); });
    this.value = new Uint8Array(n);
    this.fixed = new Map([[chip.gnd, 0], [chip.vdd, 1]]);
    for (const [k, v] of this.fixed) this.value[k] = v;
    this.on = this.ts.map((_, i) => this.conducts(i));
    this.pins = chip.pins;
    this.clocks = new Set(chip.clocks);
    this.shorts = 0;   // groups that reached both a high and a low fixed net
    this.settle(new Set(Array.from({ length: n }, (_, i) => i)), true);
  }

  conducts(i) {
    const t = this.ts[i];
    return !!this.value[t.gate] === t.n;
  }

  group(n, weak) {
    // Nets reached from n through conducting switches, not through fixed nets.
    const seen = new Set([n]), todo = [n];
    while (todo.length) {
      const m = todo.pop();
      if (this.fixed.has(m)) continue;
      for (const i of this.terms[m]) {
        const t = this.ts[i];
        if (this.on[i] && (weak || !t.weak)) {
          const o = t.a === m ? t.b : t.a;
          if (!seen.has(o)) { seen.add(o); todo.push(o); }
        }
      }
    }
    return seen;
  }

  resolve(grp) {
    // A group's value from its fixed nets, or null if it reaches none; low wins a short.
    let lo = false, hi = false;
    for (const m of grp) if (this.fixed.has(m)) { if (this.fixed.get(m)) hi = true; else lo = true; }
    return lo ? 0 : hi ? 1 : null;
  }

  recalc(n) {
    const strong = this.group(n, false);
    let v = this.resolve(strong);
    if (v === 0 && [...strong].some(m => this.fixed.get(m) === 1)) this.shorts++;
    if (v === null) {
      const full = this.group(n, true);
      v = this.resolve(full);
      if (v === null) v = [...full].some(m => this.value[m]) ? 1 : 0;
    }
    return [strong, v];
  }

  apply(neu) {
    // Set nets to new values; return the nets to recalculate next.
    const changed = [...neu].filter(([m, v]) => this.value[m] !== v).map(([m]) => m);
    for (const m of changed) this.value[m] = neu.get(m);
    const nxt = new Set();
    for (const m of changed) {
      for (const i of this.terms[m]) {
        const t = this.ts[i];
        if (t.weak && this.on[i]) { nxt.add(t.a); nxt.add(t.b); }   // a weak neighbour may change with m
      }
      for (const i of this.gates[m]) {
        const on = this.conducts(i);
        if (on !== this.on[i]) { this.on[i] = on; nxt.add(this.ts[i].a); nxt.add(this.ts[i].b); }
      }
    }
    return nxt;
  }

  step(todo, ordered) {
    // One pass over todo; return the nets to recalculate next.
    const neu = new Map(), nxt = new Set();
    for (const n of [...todo].sort((a, b) => a - b)) {
      if (neu.has(n)) continue;
      const [strong, v] = this.recalc(n);
      const grp = new Map([...strong].filter(m => !this.fixed.has(m)).map(m => [m, v]));
      for (const [m, x] of grp) neu.set(m, x);
      if (ordered) for (const m of this.apply(grp)) nxt.add(m);
    }
    return ordered ? nxt : this.apply(neu);
  }

  settle(todo, ordered = false) {
    // Recalculate nets until no value changes; see py/sim.py's settle for the pass order.
    for (let k = 0; k < LOOPS; k++) {
      todo = new Set([...todo].filter(n => !this.fixed.has(n)));
      if (!ordered) {
        let j = 0;
        for (; j < LOOPS; j++) {
          const clk = [...todo].filter(n => this.clocks.has(n));
          if (!clk.length) break;
          const rest = [...todo].filter(n => !this.clocks.has(n));
          todo = new Set([...rest, ...this.step(clk, false)]);
        }
        if (j === LOOPS) throw new Error(`clock nets unstable after ${LOOPS} passes`);
        todo = new Set([...todo].filter(n => !this.fixed.has(n)));
      }
      if (!todo.size) return;
      todo = this.step(todo, ordered);
    }
    throw new Error(`no stable state after ${LOOPS} passes`);
  }

  set(pins) {
    // Drive input pads high (1) or low (0), or release them (null), then settle.
    const todo = new Set();
    for (const [k, v] of Object.entries(pins)) {
      const n = this.pins[k];
      if (v === null) this.fixed.delete(n);
      else { this.fixed.set(n, v ? 1 : 0); this.value[n] = v ? 1 : 0; }
      todo.add(n);
      for (const i of this.gates[n]) { this.on[i] = this.conducts(i); todo.add(this.ts[i].a); todo.add(this.ts[i].b); }
      for (const i of this.terms[n]) { todo.add(this.ts[i].a); todo.add(this.ts[i].b); }
    }
    this.settle(todo);
  }

  get(pin) { return this.value[this.pins[pin]]; }

  driven(pin) {
    // Whether the pad's net reaches a supply through conducting switches.
    return this.resolve(this.group(this.pins[pin], true)) !== null;
  }
}

if (typeof module !== 'undefined') module.exports = Sim;
