// The card around the chip (handbook Figure 4.1, site/card.js), drawn in the chip layout's units beside its
// package pins (site/gen/layouts/chip.js): the input selector, Rx, ROM and program counter left of the chip, as its
// inputs are; the output latch, its LEDs and the flag lamps right of it. Every wire, lamp and switch carries a
// data-key: 'n<net>' for a chip net, or a board signal's name (Board.value). A switch carries data-act.
const Board = {
  STUB: 220,   // package pin length outside the chip

  INFO: {   // what a board signal is, for the hover note
    halt: 'Run/Halt latch: holds RST high', en: 'selector enable: WRITE and X1 both low', clr: 'counter reset: RST OR FLAG F',
    ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map(k => [`pc${k}`, `program counter bit ${k}, ROM A${k}`])),
    ...Object.fromEntries([0, 1, 2].map(k => [`a${k}`, `I/O address A${k}, ROM D${k}`])),
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(k => [`in${k}`, `input switch IN${k}, selector X${k}`])),
    ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map(k => [`out${k}`, `output latch Q${k}`])),
  },

  value(k, card, e) {
    // A board signal's value, 0 or 1; text for a 'text:' key.
    const w = card.rom[card.pc];
    switch (k) {
      case 'halt': return +card.halted;
      case 'en': return card.enabled(e);
      case 'clr': return e.get('RST') | e.get('F');
      case 'text:pc': return `PC = ${card.pc}`;
      case 'text:rom': return `word ${w.toString(16).toUpperCase().padStart(2, '0')}: ${Asm.OPS[w >> 4]} ${w & 7}`;
      case 'text:adr': return `A2–A0 = ${w & 7}`;
    }
    if (/^pc\d$/.test(k)) return card.pc >> +k.slice(2) & 1;
    if (/^a\d$/.test(k)) return w >> +k.slice(1) & 1;
    if (k.startsWith('in')) return card.ins >> +k.slice(2) & 1;
    if (k.startsWith('out')) return card.out >> +k.slice(3) & 1;
    return 0;
  },

  draw(nl, L) {
    // The card's markup, around a chip of L.w by L.h at the origin.
    const S = Board.STUB, P = k => L.pins[k].at[1], xl = -S, xr = L.w + S, out = [];
    const key = k => `n${nl.pins[k]}`;
    const wire = (k, pts) => out.push(`<polyline class="w" data-key="${k}" points="${pts.map(p => p.join(',')).join(' ')}"/>`);
    const dot = (k, x, y) => out.push(`<circle class="dot" data-key="${k}" cx="${x}" cy="${y}" r="14"/>`);
    const text = (x, y, s, cls = 'blab', anchor = 'start') => out.push(`<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${s}</text>`);
    const box = (x, y, w, h, title, sub) => {
      out.push(`<rect class="bx" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>`);
      text(x + 40, y + 84, title, 'btitle');
      if (sub) text(x + 40, y + 140, sub, 'bsub');
    };
    const tag = (k, x, y, s, anchor = 'start') => {   // a net label: the net continues elsewhere under this name
      const w = 34 * s.length + 48, x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
      out.push(`<g data-key="${k}"><rect class="btag" data-key="${k}" x="${x0}" y="${y - 32}" width="${w}" height="64" rx="32"/>`
        + `<text class="btagt" x="${x0 + w / 2}" y="${y + 15}" text-anchor="middle">${s}</text></g>`);
    };
    const lamp = (k, x, y, label, lx, ly, anchor = 'middle', cls = 'lamp') => {
      out.push(`<circle class="${cls}" data-key="${k}" cx="${x}" cy="${y}" r="30"/>`);
      text(lx, ly, label, 'blab', anchor);
    };
    const sw = (k, x, y, act, label) => {   // a slide switch, its knob right while on; its label to the left
      out.push(`<g class="bsw" data-act="${act}"><rect class="swb" data-key="${k}" x="${x}" y="${y - 28}" width="112" height="56" rx="28"/>`
        + `<circle class="knob" data-key="${k}" cx="${x + 28}" cy="${y}" r="19"/></g>`);
      text(x - 24, y + 15, label, 'blab', 'end');
    };
    const orRight = (x, y, ins) => {   // an OR gate facing right, its back at x, centred on y; ins: [[tag, key, y]]
      const h = 140, w = 110, t = y - h / 2, b = y + h / 2;
      for (const [s, k, iy] of ins) { wire(k, [[x - 120, iy], [x + 16, iy]]); tag(k, x - 120, iy, s, 'end'); }
      out.push(`<path class="bgate" d="M${x},${t} Q${x + 0.55 * w},${t} ${x + w},${y} Q${x + 0.55 * w},${b} ${x},${b} Q${x + 0.3 * w},${y} ${x},${t}Z"/>`);
      return [x + w, y];
    };
    const norLeft = (x, y, ins) => {   // a NOR gate facing left, its back at x, centred on y; ins: [[key, y]]
      const h = 140, w = 90, t = y - h / 2, b = y + h / 2;
      for (const [k, iy] of ins) wire(k, [[x + 40, iy], [x - 20, iy]]);
      out.push(`<path class="bgate" d="M${x},${t} Q${x - w / 2},${t} ${x - w},${y} Q${x - w / 2},${b} ${x},${b} Q${x - 32},${y} ${x},${t}Z"/>`,
        `<circle class="bgate" cx="${x - w - 13}" cy="${y}" r="13"/>`);
      return [x - w - 26, y];
    };

    // package pins: stubs, named just outside the chip
    for (const [k, p] of Object.entries(L.pins)) {
      const dx = p.dir === 'w' ? -1 : 1;
      wire(key(k), [p.at, [p.at[0] + dx * S, p.at[1]]]);
      text(p.at[0] + dx * 24, p.at[1] - 22, p.label, 'pinlbl', dx < 0 ? 'end' : 'start');
    }

    // input selector: drives DATA with input <address> while enabled; X0 is RR
    const sx = -1900, sy = -250, sw_ = 700, sh = 780;
    box(sx, sy, sw_, sh, 'input selector', 'MC14512');
    wire(key('DATA'), [[sx + sw_, P('DATA')], [xl, P('DATA')]]);
    text(sx + sw_ - 24, P('DATA') + 15, 'Z', 'blab', 'end');
    for (let k = 0; k < 8; k++) {
      const y = sy + 200 + 70 * k;   // below the title
      text(sx + 24, y + 15, `X${k}`);
      if (k === 0) { wire(key('RR'), [[sx - 110, y], [sx, y]]); tag(key('RR'), sx - 110, y, 'RR', 'end'); }
      else { wire(`in${k}`, [[sx - 300, y], [sx, y]]); sw(`in${k}`, sx - 412, y, `toggle:${k}`, `IN${k}`); }
    }
    // its enable: NOR of WRITE (over the chip) and X1
    const ny = (sy + sh + P('I0') - 100) / 2, en = norLeft(-860, ny, [[key('WRITE'), ny - 35], [key('X1'), ny + 35]]);   // between the selector and the ROM
    wire('en', [en, [sx + 350, en[1]], [sx + 350, sy + sh]]);
    text(sx + 350, sy + sh - 24, 'EN', 'blab', 'middle');
    const ox = L.w + 400;   // the output latch's left edge
    wire(key('WRITE'), [[xr, P('WRITE')], [ox, P('WRITE')]]);
    wire(key('WRITE'), [[xr + 120, P('WRITE')], [xr + 120, -380], [-760, -380], [-760, ny - 35], [-820, ny - 35]]);
    dot(key('WRITE'), xr + 120, P('WRITE'));
    // DATA over the chip to the latch's D
    wire(key('DATA'), [[-1000, P('DATA')], [-1000, -300], [ox - 120, -300], [ox - 120, -120], [ox, -120]]);
    dot(key('DATA'), -1000, P('DATA'));

    // the oscillator's Rx between X1 and X2, and X1 down to the enable gate
    const rx = -500;
    wire(key('X1'), [[xl, P('X1')], [-640, P('X1')], [-640, ny + 35], [-820, ny + 35]]);
    dot(key('X1'), rx, P('X1'));
    wire(key('X1'), [[rx, P('X1')], [rx, P('X1') + 50]]);
    wire(key('X2'), [[rx, P('X2') - 50], [rx, P('X2')], [xl, P('X2')]]);
    const ry0 = P('X1') + 50, ry1 = P('X2') - 50, zz = [];
    for (let i = 0; i <= 8; i++) zz.push(`${rx + (i % 2 ? (i % 4 === 1 ? 26 : -26) : 0)},${ry0 + (ry1 - ry0) * i / 8}`);
    out.push(`<polyline class="bres" points="${zz.join(' ')}"/>`);
    text(rx + 50, (ry0 + ry1) / 2 + 15, 'Rx 1 MΩ');

    // ROM: opcode D7-D4 to I3-I0; I/O address D2-D0 up the left, over the top to the selector and the latch
    const romX = -1300, romY = P('I0') - 100, romW = 600, romH = P('I3') - P('I0') + 400;
    box(romX, romY, romW, romH, 'ROM', 'MCM7641, 256 words');
    out.push(`<text class="bval" data-text="rom" x="${romX + 40}" y="${romY + 200}"></text>`);
    ['I0', 'I1', 'I2', 'I3'].forEach((k, i) => {
      text(romX + romW - 24, P(k) + 15, `D${4 + i}`, 'blab', 'end');
      wire(key(k), [[romX + romW, P(k)], [xl, P(k)]]);
    });
    for (let i = 0; i < 3; i++) {
      const k = `a${2 - i}`, y = romY + romH - 240 + 80 * i, bx = -2780 + 40 * i, top = -560 + 40 * i;
      text(romX + 24, y + 15, `D${2 - i}`);
      wire(k, [[romX, y], [bx, y], [bx, top], [ox + 200 + 60 * i, top], [ox + 200 + 60 * i, -400]]);
      const sxa = sx + 200 + 100 * i;
      wire(k, [[sxa, top], [sxa, sy]]);
      dot(k, sxa, top);
      text(ox + 200 + 60 * i, -424, `A${2 - i}`, 'blab', 'middle');
    }
    out.push(`<text class="bval" data-text="adr" x="${sx}" y="-600"></text>`);

    // program counter: counts X1's rises, cleared while RST or FLAG F is high
    const pcY = romY + romH + 200, pcH = 300;
    box(romX, pcY, romW, pcH, 'program counter', '2 × MC14516B');
    for (let i = 0; i < 8; i++) wire(`pc${i}`, [[romX + 520 - 50 * i, pcY], [romX + 520 - 50 * i, romY + romH]]);
    out.push(`<text class="bval" data-text="pc" x="${romX + 40}" y="${pcY + 210}"></text>`);
    text(romX + 24, pcY + 270, 'CLK');
    wire(key('X1'), [[romX - 140, pcY + 255], [romX, pcY + 255]]);
    tag(key('X1'), romX - 140, pcY + 255, 'X1', 'end');
    text(romX + romW - 100, pcY + pcH - 24, 'R', 'blab', 'middle');
    const gx = romX + 260, gy = pcY + pcH + 170;   // R = RST OR FLAG F
    const clr = orRight(gx, gy, [['RST', key('RST'), gy - 35], ['FLAG F', key('F'), gy + 35]]);
    wire('clr', [clr, [romX + romW - 100, gy], [romX + romW - 100, pcY + pcH]]);

    // RST from the Run/Halt latch
    wire(key('RST'), [[xl, P('RST')], [-400, P('RST')], [-400, pcY + 120], [-340, pcY + 120]]);
    sw('halt', -340, pcY + 120, 'halt', '');
    text(-340, pcY + 210, 'Run/Halt', 'blab');

    // output latch: output <address> follows DATA while WRITE is high; cleared while RST is high
    const oy = -400, ow = 860, oh = 860;
    box(ox, oy, ow, oh, 'output latch', 'MC14599B');
    text(ox + 24, -105, 'D'); text(ox + 24, P('WRITE') + 15, 'W'); text(ox + 24, oy + oh - 85, 'R');
    wire(key('RST'), [[ox - 130, oy + oh - 100], [ox, oy + oh - 100]]);
    tag(key('RST'), ox - 130, oy + oh - 100, 'RST', 'end');
    for (let k = 0; k < 8; k++) {
      const x = ox + ow * (k + 1) / 9;
      wire(`out${k}`, [[x, oy + oh], [x, oy + oh + 110]]);
      lamp(`out${k}`, x, oy + oh + 140, `${k}`, x, oy + oh + 240, 'middle', 'lamp lampled');
    }
    text(ox + ow / 2, oy + oh + 320, 'OUT0–OUT7', 'blab', 'middle');

    // RR, and the flags as lamps
    tag(key('RR'), xr + 10, P('RR'), 'RR');
    for (const k of ['JMP', 'RTN', 'O', 'F']) {
      wire(key(k), [[xr, P(k)], [xr + 80, P(k)]]);
      lamp(key(k), xr + 110, P(k), k.length === 1 ? `FLAG ${k}` : k, xr + 170, P(k) + 15, 'start');
    }
    return out.join('');
  },

  bounds(L) { return [-2900, -700, L.w + 4300, L.h + 1300]; },   // x, y, w, h of the card around the chip
};

if (typeof module !== 'undefined') module.exports = Board;
