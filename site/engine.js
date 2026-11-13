// Switch-level engine for a site/netlist.js netlist and its harness parts: site/base.js, extended.
// Transistors and resistors are both switches with a resistance; a resistor always conducts. A net takes
// the value of the fixed nets it reaches through the lowest bottleneck resistance (the largest resistance
// along a path), so a 10 kohm source loses to a transistor driving the same pad. Resistances at or below
// the strongest transistor's count as equal, so the chip itself settles as in site/base.js.
// A net that reaches no fixed net keeps its charge: the side holding more capacitance to a supply wins;
// with none, high if any net is high, as in site/base.js. Diodes and capacitors between signals only
// set timing, in harness parts such as site/parts.js's RcClock.
const _require = typeof module !== 'undefined' ? require : null;
const BaseSim = _require ? _require('./base.js') : Sim;
const NL = _require ? _require('./netlist.js') : Netlist;

class Engine extends BaseSim {
  // parts: harness parts; each may add nets (names, usable as pins) and resistors [a, b, ohms] between
  // pins or those nets, then gets attach(engine) once and update(engine) after every set.
  constructor(nl, parts = []) {
    NL.check(nl);
    const names = nl.nets.map(n => n.name), pins = { ...nl.pins };
    for (const p of parts) for (const k of p.nets || []) { pins[k] = names.length; names.push(k); }
    const sw = nl.transistors.map(t => [t.id, t.type, t.gate, t.a, t.b, t.ohms]);
    (nl.resistors || []).forEach((r, i) => sw.push([`R${i}`, 'N', nl.vdd, r.a, r.b, r.ohms]));
    for (const p of parts) for (const [a, b, ohms] of p.resistors || []) sw.push([`${a}-${b}`, 'N', nl.vdd, pins[a], pins[b], ohms]);
    const strong = Math.min(...nl.transistors.map(t => t.ohms));
    const ohms = sw.map(s => Math.max(s[5], strong));
    const cap = new Float64Array(names.length);
    for (const c of nl.capacitors || []) {
      if (c.b === nl.gnd || c.b === nl.vdd) cap[c.a] += c.farads;
      if (c.a === nl.gnd || c.a === nl.vdd) cap[c.b] += c.farads;
    }
    super({
      nets: names, gnd: nl.gnd, vdd: nl.vdd, pins, clocks: nl.clocks || [],
      ts: sw.map((s, i) => [s[0], s[1], ohms[i] > strong, s[2], s[3], s[4]]),
      ohms, levels: [...new Set(ohms)].sort((a, b) => a - b), cap,
    });
    this.nl = nl;
    this.t = 0;          // s, simulated time
    this.queue = [];     // [{t, fn}], in time order
    this.parts = [];     // attached parts, which get update calls
    for (const p of parts) { p.attach?.(this); this.parts.push(p); }
  }

  group(n, ohms) {
    // Nets reached from n through conducting switches of at most ohms, not through fixed nets.
    // ohms true or false: every switch, or the strongest only, as site/base.js's weak flag.
    const max = ohms === true ? Infinity : ohms === false ? this.chip.levels[0] : ohms;
    const seen = new Set([n]), todo = [n];
    while (todo.length) {
      const m = todo.pop();
      if (this.fixed.has(m)) continue;
      for (const i of this.terms[m]) {
        if (this.on[i] && this.chip.ohms[i] <= max) {
          const t = this.ts[i], o = t.a === m ? t.b : t.a;
          if (!seen.has(o)) { seen.add(o); todo.push(o); }
        }
      }
    }
    return seen;
  }

  recalc(n) {
    // n's strongest group and its value; see the header. Records each net's state for the views: DRIVEN,
    // CHARGE (reaches no fixed net, so keeps its charge) or SHORT (reaches both a high and a low one).
    const levels = this.chip.levels, strong = this.group(n, levels[0]);
    this.state ??= new Uint8Array(this.value.length);
    let grp = strong;
    for (const r of levels) {
      if (r !== levels[0]) grp = this.group(n, r);
      let lo = false, hi = false;
      for (const m of grp) if (this.fixed.has(m)) { if (this.fixed.get(m)) hi = true; else lo = true; }
      if (lo && hi) this.shorts++;
      if (lo || hi) {
        for (const m of strong) this.state[m] = lo && hi ? Engine.SHORT : Engine.DRIVEN;
        return [strong, lo ? 0 : 1];
      }
    }
    for (const m of strong) this.state[m] = Engine.CHARGE;
    return [strong, this.charge(grp)];
  }

  charge(grp) {
    // Value of a group that reaches no fixed net; see the header.
    let hi = 0, lo = 0;
    for (const m of grp) { if (this.value[m]) hi += this.chip.cap[m]; else lo += this.chip.cap[m]; }
    if (hi !== lo) return hi > lo ? 1 : 0;
    return [...grp].some(m => this.value[m]) ? 1 : 0;
  }

  set(pins) {
    super.set(pins);
    for (const [k, v] of Object.entries(pins)) if (v !== null && this.state) this.state[this.pins[k]] = Engine.DRIVEN;   // a driven pad
    for (const p of this.parts || []) p.update?.(this);
  }

  after(dt, fn) {
    // Call fn at dt seconds from now.
    const t = this.t + dt;
    let i = this.queue.length;
    while (i && this.queue[i - 1].t > t) i--;
    this.queue.splice(i, 0, { t, fn });
  }

  run(dt) {
    // Advance dt seconds, calling each queued fn at its time.
    const end = this.t + dt;
    while (this.queue.length && this.queue[0].t <= end) {
      const e = this.queue.shift();
      this.t = e.t;
      e.fn();
    }
    this.t = end;
  }

  capacitance(net) {
    // F, every capacitor with a plate on net.
    return (this.nl.capacitors || []).filter(c => c.a === net || c.b === net).reduce((s, c) => s + c.farads, 0);
  }
}

Object.assign(Engine, { DRIVEN: 0, CHARGE: 1, SHORT: 2 });
if (typeof module !== 'undefined') module.exports = Engine;
