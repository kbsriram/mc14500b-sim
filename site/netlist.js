// The netlist format the site reads, and a check of it. A netlist is one object, format 'netlist/2';
// a file registers it as globalThis.NETLISTS[<key>], so a page loads it with a <script> tag and Node with
// require(). extract/build.py writes the MC14500B's. Nets are numbered by their index in nets.
//   name, volts         chip name; supply voltage, V
//   nets                [{key, name}]: key is the source's id, name the readable one
//   gnd, vdd            supply nets
//   pins                {pin name: net}
//   clocks              nets the engine settles first in each pass; optional, see site/base.js settle
//   transistors         [{id, type 'N' | 'P', gate, a, b, ohms, cell}]: ohms while conducting; cell indexes cells
//   resistors           [{a, b, ohms}]
//   capacitors          [{a, b, farads}]
//   diodes              [{anode, cathode}]
// Optional, for the views (extract/build.py names roles):
//   types               {stage: {name: {kind, ports, ts, n?, p?, nsw?, psw?}}, cell: {name: {ins, outs, storage, stages}}}:
//                       a stage type's transistors {role: {type, weak, gate, a, b}} with nets by role, its N and P
//                       networks as gate trees (n, p) and transistor trees (nsw, psw), each a role or [op, [trees]];
//                       a cell type's stages [{role, type, ports: {stage role: cell role}}]
//   blocks              [{name, cells, ports, box}]: cells index cells; ports are nets other blocks or pins reach
//   cells               [{name, type, block, nets: {role: net}, stages, at, box}]: at and box in die photo pixels
//   stages              [{type, cell, role, nets: {role: net}, ts: {role: [transistors]}}]: parallel transistors
//                       drawn as one share a role
//   die                 {w, h, pins: {pin: [x, y]}}: die photo pixels
const FORMAT = 'netlist/2';

function check(nl) {
  // Throw on the first field that does not fit the format above; return nl.
  const bad = msg => { throw new Error(`netlist ${nl.name || '?'}: ${msg}`); };
  if (nl.format !== FORMAT) bad(`format ${nl.format}, expected ${FORMAT}`);
  const n = nl.nets.length;
  const isNet = (v, what) => { if (!(Number.isInteger(v) && v >= 0 && v < n)) bad(`${what} is ${v}, not a net`); };
  isNet(nl.gnd, 'gnd'); isNet(nl.vdd, 'vdd');
  for (const [k, v] of Object.entries(nl.pins)) isNet(v, `pin ${k}`);
  (nl.clocks || []).forEach((v, i) => isNet(v, `clocks[${i}]`));
  nl.transistors.forEach((t, i) => {
    if (t.type !== 'N' && t.type !== 'P') bad(`transistors[${i}] type ${t.type}`);
    for (const k of ['gate', 'a', 'b']) isNet(t[k], `transistors[${i}].${k}`);
    if (!(t.ohms > 0)) bad(`transistors[${i}] ohms ${t.ohms}`);
  });
  (nl.resistors || []).forEach((r, i) => { isNet(r.a, `resistors[${i}].a`); isNet(r.b, `resistors[${i}].b`); if (!(r.ohms > 0)) bad(`resistors[${i}] ohms`); });
  (nl.capacitors || []).forEach((c, i) => { isNet(c.a, `capacitors[${i}].a`); isNet(c.b, `capacitors[${i}].b`); if (!(c.farads > 0)) bad(`capacitors[${i}] farads`); });
  (nl.diodes || []).forEach((d, i) => { isNet(d.anode, `diodes[${i}].anode`); isNet(d.cathode, `diodes[${i}].cathode`); });
  const isIndex = (v, len, what) => { if (!(Number.isInteger(v) && v >= 0 && v < len)) bad(`${what} is ${v}`); };
  const cells = nl.cells || [], stages = nl.stages || [], types = nl.types || { stage: {}, cell: {} };
  (nl.blocks || []).forEach(b => b.cells.forEach(i => isIndex(i, cells.length, `block ${b.name} cell`)));
  cells.forEach((c, i) => {
    if (!types.cell[c.type]) bad(`cells[${i}] type ${c.type}`);
    for (const [r, v] of Object.entries(c.nets)) isNet(v, `cells[${i}].nets.${r}`);
    c.stages.forEach(s => isIndex(s, stages.length, `cells[${i}].stages`));
  });
  stages.forEach((s, i) => {
    if (!types.stage[s.type]) bad(`stages[${i}] type ${s.type}`);
    for (const [r, v] of Object.entries(s.nets)) isNet(v, `stages[${i}].nets.${r}`);
    for (const ts of Object.values(s.ts)) ts.forEach(t => isIndex(t, nl.transistors.length, `stages[${i}].ts`));
  });
  return nl;
}

const Netlist = { FORMAT, check };
if (typeof module !== 'undefined') module.exports = Netlist;
