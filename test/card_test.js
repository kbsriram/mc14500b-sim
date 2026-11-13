// Run site/card.js with the chip on site/engine.js, flipping input switches at random, and compare
// the output latch after each instruction with the datasheet's instruction table run on the same ROM.
// Run from the repo root: node test/card_test.js [instructions] [seed]
const Engine = require('../site/engine.js');
const Card = require('../site/card.js');
const Asm = require('../site/asm.js');
const { RcClock } = require('../site/parts.js');
require('../site/gen/mc14500b.js');

function reference(rom, ins, st) {
  // One instruction at st.pc on the card, as the datasheet's table gives it; st: {pc, rr, ien, oen, skip, out}.
  const w = rom[st.pc], op = w >> 4, a = w & 7;
  const din = a === 0 ? st.rr : ins >> a & 1, d = din & st.ien, rr = st.rr;
  st.pc = (st.pc + 1) % rom.length;
  if (st.skip) { st.skip = 0; return; }
  if (op === 15) st.pc = 0;   // NOPF: FLAG F clears the counter
  if (op >= 1 && op <= 7) st.rr = [0, d, 1 - d, rr & d, rr & (1 - d), rr | d, rr | (1 - d), +(rr === d)][op];
  if ((op === 8 || op === 9) && st.oen) st.out = st.out & ~(1 << a) | (op === 8 ? rr : 1 - rr) << a;
  if (op === 10) st.ien = din;
  if (op === 11) st.oen = din;
  st.skip = +(op === 13 || (op === 14 && rr === 0));
}

const n = +(process.argv[2] || 3000);
let seed = +(process.argv[3] || 1);
const rand = k => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
let bad = 0;
for (const [name, src] of Object.entries(Asm.EXAMPLES)) {
  const { rom } = Asm.assemble(src);
  const card = new Card(rom), clock = new RcClock(1e6);
  const e = new Engine(NETLISTS.mc14500b, [card, clock]);
  card.load(e, rom);
  while (card.halted) e.run(1e-6);
  while (e.get('X1') === 1) e.run(1e-6);   // to the first fall after reset: word 0 enters the chip
  const start = card.pc, st = { pc: card.pc, rr: 0, ien: 0, oen: 0, skip: 0, out: 0 };
  let wrong = 0;
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const held = e.get('F') && rom[st.pc] >> 4 === 15;   // NOPF's own FLAG F already clears the counter at this X1 fall
    if (st.pc !== card.pc && !(held && card.pc === 0)) { console.log(`${name}: instruction ${i}: card pc ${card.pc}, expected ${st.pc}`); wrong++; break; }
    reference(rom, card.ins, st);
    while (e.get('X1') === 0) e.run(1e-6);   // X1 rises: the instruction completes
    if (card.out !== st.out && wrong++ < 5) console.log(`${name}: instruction ${i}: outputs ${card.out.toString(2)}, expected ${st.out.toString(2)}`);
    seen.add(card.out);
    if (rand(50) === 0) card.toggle(e, 1 + rand(7));   // while X1 is high, before the next read
    while (e.get('X1') === 1) e.run(1e-6);
  }
  console.log(`${name}: ${n} instructions, ${wrong} mismatches, ${seen.size} distinct output bytes, first counter value ${start}, simulated ${(e.t * 1e3).toFixed(1)} ms`);
  bad += wrong;
}
process.exit(bad ? 1 : 0);
