// Assembler for site/card.js's ROM. A line is `[label:] MNEMONIC [operand] [; comment]`.
// A ROM word is the opcode in bits 4-7 and the I/O address in bits 0-2 (handbook Figure 4.2, less bit 3,
// which the card does not use). An operand is an address, 0-7, or a name: RR (input 0, which the card wires to RR), IN1-IN7, OUT0-OUT7.

const OPS = 'NOPO LD LDC AND ANDC OR ORC XNOR STO STOC IEN OEN JMP RTN SKZ NOPF'.split(' ');
const IO = { RR: 0, ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(k => [`IN${k}`, k])),
  ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map(k => [`OUT${k}`, k])) };
const ROM_WORDS = 256;

function assemble(text) {
  // {rom: Uint8Array of ROM_WORDS, lines: [{at, word, src, n}], errors: [{n, msg}]}; n is the 1-based line number.
  const rom = new Uint8Array(ROM_WORDS), lines = [], errors = [];
  text.split('\n').forEach((raw, i) => {
    let s = raw.split(';')[0].trim();
    const n = i + 1;
    if (s.includes(':')) s = s.slice(s.indexOf(':') + 1).trim();
    if (!s) return;
    const [m, arg, ...rest] = s.split(/\s+/);
    const op = OPS.indexOf(m.toUpperCase());
    if (op < 0) return errors.push({ n, msg: `unknown instruction ${m}` });
    if (rest.length) return errors.push({ n, msg: `extra text ${rest.join(' ')}` });
    let a = 0;
    if (arg !== undefined) {
      const k = arg.toUpperCase();
      a = k in IO ? IO[k] : /^(0x[0-9a-f]+|\d+)$/i.test(k) ? Number(k) : NaN;
      if (!(a >= 0 && a < 8)) return errors.push({ n, msg: `operand ${arg}: an address 0-7, RR, IN1-IN7 or OUT0-OUT7` });
    }
    if (lines.length >= ROM_WORDS) return errors.push({ n, msg: `more than ${ROM_WORDS} instructions` });
    rom[lines.length] = op << 4 | a;
    lines.push({ at: lines.length, word: rom[lines.length], src: raw, n });
  });
  return { rom, lines, errors };
}

const Asm = { OPS, IO, ROM_WORDS, assemble };
if (typeof module !== 'undefined') module.exports = Asm;

// Example programs for the card. Reset clears RR, IEN and OEN; input 0 reads RR, so ORC RR sets RR to 1. Word 0 runs
// as NOPO after reset (site/card.js); each program ends in NOPF, whose FLAG F clears the counter, so it repeats.
// Those marked "Handbook" adapt that figure of docs/Motorola-MC14500B-IndustrialControlUnit-Handbook-1977.pdf to
// inputs IN1-IN7 and outputs OUT0-OUT7.
const SETUP = `    NOPO        ; skipped at reset
    ORC RR      ; RR = 1
    IEN RR      ; enable inputs
    OEN RR      ; enable outputs
`;
Asm.EXAMPLES = {
  chaser: `; A light runs along OUT0-OUT7.
${SETUP}    STO OUT0
    STOC OUT7
    STO OUT1
    STOC OUT0
    STO OUT2
    STOC OUT1
    STO OUT3
    STOC OUT2
    STO OUT4
    STOC OUT3
    STO OUT5
    STOC OUT4
    STO OUT6
    STOC OUT5
    STO OUT7
    STOC OUT6
    NOPF        ; FLAG F: start again
`,
  gates: `; Outputs as gates of the inputs.
${SETUP}    LD IN1
    AND IN2
    STO OUT0    ; OUT0 = IN1 AND IN2
    LD IN3
    OR IN4
    STO OUT1    ; OUT1 = IN3 OR IN4
    LD IN5
    XNOR IN6
    STOC OUT2   ; OUT2 = IN5 XOR IN6
    LDC IN7
    STO OUT3    ; OUT3 = NOT IN7
    LD IN1
    AND IN2
    AND IN3
    STO OUT7    ; OUT7 = IN1 AND IN2 AND IN3
    NOPF        ; FLAG F: start again
`,
  ladder: `; Handbook Fig. 5.5: a relay ladder rung,
; OUT1 = IN1 AND IN2 OR IN3.
${SETUP}    LD IN1
    AND IN2
    OR IN3
    STO OUT1
    NOPF        ; FLAG F: start again
`,
  chain: `; Handbook Fig. 3.4: a chain of contacts,
; OUT0 = IN1 AND NOT IN2 AND IN3 AND NOT IN4.
${SETUP}    LD IN1
    ANDC IN2
    AND IN3
    ANDC IN4
    STO OUT0
    NOPF        ; FLAG F: start again
`,
  master: `; Handbook Fig. 3.14: IN4 as a master contact.
; While IN4 is off, IEN = 0 reads every input as 0.
${SETUP}    LD IN1
    AND IN2
    AND IN3
    STO OUT0    ; W = IN1 AND IN2 AND IN3
    IEN IN4     ; master contact
    LD IN5
    AND IN6
    STO OUT1    ; Y = IN5 AND IN6, if IN4
    ORC RR
    IEN RR      ; IEN = 1 again
    LD IN7
    STO OUT2    ; Z = IN7
    NOPF        ; FLAG F: start again
`,
  pulses: `; Handbook Fig. 3.15: OEN skips a block.
; Two pulses on OUT0 if IN1 AND IN2, else one.
${SETUP}    LD IN1
    AND IN2
    OEN RR      ; OEN = IN1 AND IN2
    STO OUT0    ; two pulses
    STOC OUT0
    STO OUT0
    STOC OUT0
    LDC IN1
    ORC IN2
    OEN RR      ; OEN = NOT (IN1 AND IN2)
    STO OUT0    ; one pulse
    STOC OUT0
    ORC RR
    OEN RR      ; OEN = 1
    STO OUT7    ; Q = 1
    NOPF        ; FLAG F: start again
`,
};
