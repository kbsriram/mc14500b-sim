// Harness parts for site/engine.js: the board around the chip.

class Source {
  // A switch driving pin through ohms, as falstad/blocks.py's Data switch: the chip's own drive wins.
  // Set it with engine.set({[name]: 0 | 1 | null}).
  constructor(pin, ohms, name = `${pin}.src`) {
    this.name = name;
    this.nets = [name];
    this.resistors = [[name, pin, ohms]];
  }
}

class RcClock {
  // The datasheet's oscillator (docs/MC14500B_Rev3.pdf Figure 1): ohms from pin out to pin in, and
  // in's capacitors from the netlist. When out switches, in follows one half period later: in starts a
  // diode drop (vd, V) past the old supply, as the pad diodes clamp it, and decays through ohms to half
  // the supply, where the chip's inverter switches: half = ohms * C * ln((V + vd) / (V / 2)).
  constructor(ohms, { out = 'X1', into = 'X2', vd = 0.6 } = {}) {
    Object.assign(this, { ohms, out, into, vd });
  }

  attach(e) {
    const v = e.nl.volts;
    this.half = this.ohms * e.capacitance(e.pins[this.into]) * Math.log((v + this.vd) / (v / 2));
    this.last = null;
    this.update(e);
  }

  update(e) {
    const v = e.get(this.out);
    if (v === this.last) return;
    this.last = v;
    e.after(this.half, () => e.set({ [this.into]: v }));
  }
}

if (typeof module !== 'undefined') module.exports = { Source, RcClock };
