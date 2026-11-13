// Check site/engine.js on a netlist: replay test/vectors.json as falstad/test_page.js does, with the
// data switch on the Data pad through 10 kohm, then run the RcClock at 1 Mohm and report X1's frequency;
// the datasheet's Figure 1 gives 32 kHz. Run from the repo root:
// node test/test.js [netlist.js] [vectors.json]
const path = require('path');
const Engine = require('../site/engine.js');
const { Source, RcClock } = require('../site/parts.js');

const SET = { DATA: 'DATA.src' };   // vectors.json's driven pads, as the engine's pins: DATA through its source
const DATA_OHMS = 1e4;   // falstad/blocks.py's data switch resistor
const OSC_OHMS = 1e6;

function load(file) {
  const before = new Set(Object.keys(globalThis.NETLISTS || {}));
  require(path.resolve(file));
  const key = Object.keys(globalThis.NETLISTS).find(k => !before.has(k));
  return globalThis.NETLISTS[key];
}

function replay(nl, vec) {
  const e = new Engine(nl, [new Source('DATA', DATA_OHMS)]);
  let bad = 0, checked = 0;
  vec.rows.forEach((row, r) => {
    e.set(Object.fromEntries(Object.entries(row.set).map(([k, v]) => [SET[k] || k, v])));
    if (!row.want) return;
    checked++;
    const diff = Object.entries(row.want).filter(([k, v]) => e.get(k) !== v);
    if (diff.length && bad++ < 8) console.log(`row ${r}: ` + diff.map(([k, v]) => `${k} want ${v} got ${e.get(k)}`).join(', '));
  });
  console.log(`vectors: ${checked} rows checked, ${bad} mismatched, ${e.shorts} equal-strength supply conflicts while settling`);
  return bad;
}

function clock(nl) {
  const e = new Engine(nl, [new RcClock(OSC_OHMS)]);
  const rises = [];
  let last = e.get('X1');
  for (let i = 0; i < 2000; i++) {
    e.run(1e-6);
    const v = e.get('X1');
    if (v && !last) rises.push(e.t);
    last = v;
  }
  const per = (rises[rises.length - 1] - rises[1]) / (rises.length - 2);
  console.log(`clock: ${rises.length} X1 rises in 2 ms, period ${(per * 1e6).toFixed(1)} us, ${(1e-3 / per).toFixed(1)} kHz`);
  return rises.length > 2 ? 0 : 1;
}

const nl = load(process.argv[2] || path.join(__dirname, '..', 'site', 'gen', 'mc14500b.js'));
const vec = require(path.resolve(process.argv[3] || path.join(__dirname, 'vectors.json')));
process.exit(replay(nl, vec) + clock(nl) ? 1 : 0);
