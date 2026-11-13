// The handbook's minimal ICU system (docs/Motorola-MC14500B-IndustrialControlUnit-Handbook-1977.pdf,
// Figure 4.1), less the readable latch Y2, as a site/engine.js part. Each chip is a few lines of logic:
//   program counter (2 x MC14516B): counts on X1's rise, held at 0 while RST or FLAG F is high; 256 words, no jumps.
//     NOPF pulses FLAG F, so a program ending in NOPF repeats, as in the handbook's demonstration system (Figure 5.3).
//   ROM (MCM7641): the counter's word; opcode (bits 7-4) to I3-I0, I/O address (bits 2-0) to the selector and latch.
//   input selector (MC14512): drives the Data pad with input <address> while WRITE and X1 are both low;
//     otherwise its output is off. Input 0 is RR. The chip reads Data as X1 rises, and drives Data itself
//     from a store's X1 fall until X1 next falls.
//   output latch (MC14599B): output <address> follows the Data pad while WRITE is high; cleared while RST is high.
//   Run/Halt latch: holds RST high while halted. RST holds X1 high, so X1 falls as RST is released; the engine
//   settles both in one step, and the word latched at that fall runs as NOPO. Programs start with a NOPO.
const DATA_OHMS = 1e4;   // the selector's drive on the Data pad, so the chip's own drive wins, as falstad/blocks.py

class Card {
  constructor(rom) {
    this.rom = rom;
    this.pc = 0;          // program counter
    this.ins = 0;         // bits 1-7: the input switches
    this.out = 0;         // bits 0-7: the output latch
    this.halted = false;
    this.nets = ['DATA.src'];
    this.resistors = [['DATA.src', 'DATA', DATA_OHMS]];
    this.driven = {};     // pins as last driven
  }

  attach(e) {
    this.x1 = e.get('X1');
    this.update(e);
  }

  update(e) {
    // Run the board's logic on the chip's pads; drive the chip's inputs until nothing changes.
    if (this.busy) return;   // e.set below calls update again
    this.busy = true;
    for (let k = 0; k < 10; k++) {
      const x1 = e.get('X1'), w = e.get('WRITE'), rst = e.get('RST'), a = this.rom[this.pc] & 7;
      if (rst) this.out = 0;
      else if (w) this.out = this.out & ~(1 << a) | e.get('DATA') << a;
      if (rst || e.get('F')) this.pc = 0;
      else if (x1 && !this.x1) this.pc = (this.pc + 1) % this.rom.length;
      this.x1 = x1;
      const word = this.rom[this.pc];
      const want = { I0: word >> 4 & 1, I1: word >> 5 & 1, I2: word >> 6 & 1, I3: word >> 7 & 1,
        RST: +this.halted, 'DATA.src': this.enabled(e) ? this.read(e, word & 7) : null };
      const ch = Object.fromEntries(Object.entries(want).filter(([p, v]) => this.driven[p] !== v));
      if (!Object.keys(ch).length) break;
      Object.assign(this.driven, ch);
      e.set(ch);
    }
    this.busy = false;
  }

  enabled(e) {
    // The selector's enable, NOT Disable: WRITE and X1 both low.
    return +!(e.get('WRITE') || e.get('X1'));
  }

  read(e, a) {
    // The selector's output for address a, 0-7.
    return a === 0 ? e.get('RR') : this.ins >> a & 1;
  }

  toggle(e, k) { this.ins ^= 1 << k; this.update(e); }

  halt(e, v) { this.halted = v; this.update(e); }

  load(e, rom) {
    // New ROM contents, then RST high for 100 us: three clock periods at 1 Mohm.
    this.rom = rom;
    this.halt(e, true);
    e.after(1e-4, () => this.halt(e, false));
  }
}

if (typeof module !== 'undefined') module.exports = Card;
