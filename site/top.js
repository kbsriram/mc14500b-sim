// The page: site/card.js's board (handbook Figure 4.1) driving the chip on site/engine.js, the chip drawn
// by site/schem.js with its package pins, the rail's controls, the assembler and the waveforms
// (site/waves.js). Gestures: the wheel or a pinch zooms about the pointer (a trackpad's two-finger scroll
// pans); dragging pans; + − 0 zoom and fit. Zooming in opens parts; a click on a part's label (site/schem.js)
// opens or closes it. The 3D button (or V) shows the die instead (site/die3d.js), on the same engine.
// The engine runs in each animation frame for at most BUDGET_MS, so zooming and panning stay smooth.
const BUDGET_MS = 12;
const MIN_W = 0.05;  // the narrowest view, in chip layout units: a transistor deep in a stage still fills the screen
const ANIM_MS = 260;
const WAVES = ['X1', 'RST', 'I0', 'I1', 'I2', 'I3', 'DATA', 'WRITE', 'RR', 'JMP', 'RTN', 'O', 'F'];

const nl = NETLISTS.mc14500b, $ = id => document.getElementById(id);
const counter = {   // instructions completed (X1 rises) and X1 edges
  n: 0, edges: 0,
  update(e) {
    const x = e.get('X1');
    if (x !== this.x && this.x !== undefined) { this.edges++; this.n += x; }
    this.x = x;
  },
};
let prog = Asm.assemble(Asm.EXAMPLES.chaser);
const card = new Card(prog.rom), clock = new RcClock(1e6);
const e = new Engine(nl, [card, clock, counter]);
const period = 2 * clock.half;
const svg = $('svg'), world = $('world'), app = $('app');
const L = LAYOUTS.chip;
const hex = (v, n) => v.toString(16).toUpperCase().padStart(n, '0');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// ---- the chip and the card around it (site/board.js)
world.insertAdjacentHTML('beforeend', `<g id="board">${Board.draw(nl, L)}</g>`);
const view = new SchemView(svg, world, nl, { x: 0, y: 0, w: L.w });
world.appendChild(view.root.el);

// ---- the die in 3D (site/die3d.js), shown instead of the schematic; made before the page's key handler
let die = null, mode3d = false;
try { die = new DieView($('die'), nl, DIE3D, $('dielabels'), { canvas2d: /[?&]canvas2d\b/.test(location.search) }); } catch (err) { $('view3d').disabled = true; $('view3d').title = `The die in 3D is not available: ${err.message}`; }
function setMode(on) {
  if (!die) return;
  const first = on && !die.shown;
  mode3d = die.active = on; die.shown ||= on;
  app.classList.toggle('d3', on); $('view3d').classList.toggle('act', on);
  $('tip').style.display = 'none';
  if (first) die.fit(false);
  history.replaceState(null, '', on ? '#die' : location.pathname + location.search);
}
if (die) {
  die.onHover = (h, ev) => {
    if (!h) { $('tip').style.display = 'none'; return; }
    const t = h.layer === 'channel' && nl.transistors[h.shape.k];
    showTip(ev, t ? `${t.type}MOS ${t.id} ${e.on[h.shape.k] ? 'on' : 'off'} <small>gate ${esc(nl.nets[t.gate].name)}</small>`
      : h.shape.k >= 0 ? netText(h.shape.k) : h.layer);
  };
  die.onClick = h => {
    const n = !h ? -1 : h.layer === 'channel' ? nl.transistors[h.shape.k].gate : h.shape.k;
    if (n >= 0) { waves.add(n); app.classList.add('waves'); }
  };
  const METAL = { solid: ['clear', 'Metal: clear'], clear: ['off', 'Metal: off'], off: ['solid', 'Metal'] };
  $('lmetal').onclick = () => {
    const [m, label] = METAL[die.show.metal];
    die.show.metal = m; $('lmetal').textContent = label; $('lmetal').classList.toggle('act', m !== 'off');
  };
  for (const [id, k] of [['lcontact', 'contact'], ['ldiff', 'diffusion'], ['lchan', 'channel']])
    $(id).onclick = () => { die.show[k] = !die.show[k]; $(id).classList.toggle('act', die.show[k]); };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => die.colors());
}
$('view3d').onclick = () => setMode(!mode3d);

// ---- keyed elements: wires, leads and tags by net; transistor channels
let byKey = new Map(), trs = [], last = new Map(), hot = null;
const texts = [...svg.querySelectorAll('[data-text]')];
function index() {
  byKey = new Map(); last = new Map();
  for (const el of svg.querySelectorAll('[data-key]')) {
    const k = el.dataset.key;
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(el);
  }
  trs = [...svg.querySelectorAll('[data-tr]')].map(el => [el, el.dataset.tr.split(' ').filter(Boolean).map(Number), null]);
  if (hot) light(hot, true);
}

function refresh() {
  // Restyle what changed: each net by value and state, each transistor by whether it conducts.
  const st = e.state || [];
  for (const [k, els] of byKey) {
    const net = /^n\d+$/.test(k), n = net ? +k.slice(1) : -1;
    const v = net ? e.value[n] : Board.value(k, card, e), s = net ? st[n] || 0 : 0, code = v + 2 * s;
    if (last.get(k) === code) continue;
    last.set(k, code);
    for (const el of els) {
      el.classList.toggle('hi', !!v); el.classList.toggle('lo', !v);
      el.classList.toggle('q', s === Engine.CHARGE); el.classList.toggle('x', s === Engine.SHORT);
    }
  }
  for (const t of trs) {
    const on = t[1].some(i => e.on[i]);
    if (on !== t[2]) { t[2] = on; t[0].classList.toggle('on', on); }
  }
  for (const el of texts) el.textContent = Board.value(`text:${el.dataset.text}`, card, e);
}

// ---- the view: pan and zoom by viewBox
let vb = { x: 0, y: 0, w: 1, h: 1 }, anim = null, dirty = true;
function setVB(b) {
  // Show b, keeping its centre and width; the height follows the view's shape.
  const r = svg.getBoundingClientRect(), a = r.height / Math.max(1, r.width);
  const w = Math.max(MIN_W, b.w), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  vb = { x: cx - w / 2, y: cy - w * a / 2, w, h: w * a };
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  dirty = true;
}
function fitBox(x, y, w, h, margin = 0.08) {
  // The viewBox showing x, y, w, h whole, with a margin.
  const r = svg.getBoundingClientRect(), a = r.height / Math.max(1, r.width);
  const W = Math.max(w, h / a) * (1 + 2 * margin);
  return { x: x + w / 2 - W / 2, y: y + h / 2 - W * a / 2, w: W, h: W * a };
}
function animate(to) {
  const from = { ...vb }, t0 = performance.now();
  anim = now => {
    const k = Math.min(1, (now - t0) / ANIM_MS), s = 1 - (1 - k) ** 3, lerp = (a, b) => a + (b - a) * s;
    // zoom in log space, so the motion looks even
    const w = Math.exp(lerp(Math.log(from.w), Math.log(to.w)));
    const cx = lerp(from.x + from.w / 2, to.x + to.w / 2), cy = lerp(from.y + from.h / 2, to.y + to.h / 2);
    setVB({ x: cx - w / 2, y: cy - w * from.h / from.w / 2, w, h: w * from.h / from.w });
    if (k >= 1) anim = null;
  };
}
const fit = () => fitBox(...Board.bounds(L), 0.02);
function toSvg(cx, cy) { const p = new DOMPoint(cx, cy).matrixTransform(svg.getScreenCTM().inverse()); return p; }
function zoomAt(cx, cy, f) {
  const p = toSvg(cx, cy), w = Math.max(MIN_W, vb.w * f), k = w / vb.w;
  setVB({ x: p.x - (p.x - vb.x) * k, y: p.y - (p.y - vb.y) * k, w, h: vb.h * k });
}
function pan(dx, dy) {   // screen pixels
  const s = vb.w / svg.getBoundingClientRect().width;
  setVB({ x: vb.x - dx * s, y: vb.y - dy * s, w: vb.w, h: vb.h });
}
function nodeBox(node) {
  // node's outline in the svg's user units.
  const r = node.el.getBoundingClientRect(), a = toSvg(r.left, r.top), b = toSvg(r.right, r.bottom);
  return [a.x, a.y, b.x - a.x, b.y - a.y];
}

svg.addEventListener('wheel', ev => {
  ev.preventDefault();
  anim = null;
  const mouse = ev.deltaMode === 1 || (ev.deltaX === 0 && Math.abs(ev.deltaY) >= 50 && Number.isInteger(ev.deltaY));
  if (ev.ctrlKey || mouse) zoomAt(ev.clientX, ev.clientY, Math.exp(ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0022)));
  else pan(-ev.deltaX, -ev.deltaY);
}, { passive: false });

const ptrs = new Map();
let gesture = null, moved = false;
svg.addEventListener('pointerdown', ev => {
  ptrs.set(ev.pointerId, [ev.clientX, ev.clientY]);
  moved = false; anim = null;
  gesture = ptrs.size === 2 ? { pinch: dist(), mid: mid() } : { x: ev.clientX, y: ev.clientY };
});
const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
const mid = () => { const [a, b] = [...ptrs.values()]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
svg.addEventListener('pointermove', ev => {
  if (!ptrs.has(ev.pointerId)) return hover(ev);
  ptrs.set(ev.pointerId, [ev.clientX, ev.clientY]);
  if (ptrs.size === 2 && gesture?.pinch) {
    const d = dist(), m = mid();
    zoomAt(m[0], m[1], gesture.pinch / d);
    pan(m[0] - gesture.mid[0], m[1] - gesture.mid[1]);
    gesture = { pinch: d, mid: m };
    moved = true;
  } else if (gesture && !gesture.pinch) {
    const dx = ev.clientX - gesture.x, dy = ev.clientY - gesture.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) svg.setPointerCapture(ev.pointerId);   // a drag: keep it when the pointer leaves the view
    moved = true;
    svg.classList.add('panning');
    pan(dx, dy);
    gesture = { x: ev.clientX, y: ev.clientY };
  }
});
const lift = ev => { ptrs.delete(ev.pointerId); if (!ptrs.size) { gesture = null; svg.classList.remove('panning'); } else gesture = { x: [...ptrs.values()][0][0], y: [...ptrs.values()][0][1] }; };
svg.addEventListener('pointerup', lift);
svg.addEventListener('pointercancel', lift);
svg.addEventListener('click', ev => {
  if (moved) return;
  const act = ev.target.closest('[data-act]');   // a switch on the card
  if (act) { const [a, k] = act.dataset.act.split(':'); if (a === 'toggle') card.toggle(e, +k); else card.halt(e, !card.halted); return; }
  const tg = ev.target.closest('[data-toggle]'), node = tg && view.find(tg.dataset.toggle);
  if (node) return (node.open ? closePart : openPart)(node);
  const k = ev.target.closest('[data-key]');
  if (k && /^n\d+$/.test(k.dataset.key)) { waves.add(+k.dataset.key.slice(1)); app.classList.add('waves'); }
});
// ---- opening and closing parts: a click on a part's label; the view stays where it is
function openPart(node) { if (view.toggle(node.id, true)) { index(); dirty = true; } }
function closePart(node) { if (view.toggle(node.id, false)) { index(); dirty = true; } }
svg.addEventListener('dblclick', ev => {   // on the background: zoom in about the pointer
  if (ev.target.closest('[data-toggle], [data-node]:not([data-node="chip"])')) return;
  const p = toSvg(ev.clientX, ev.clientY);
  animate({ x: p.x - vb.w / 4, y: p.y - vb.h / 4, w: vb.w / 2, h: vb.h / 2 });
});

// ---- hover: light the whole net, name it and give its value
const tip = $('tip');
function light(k, on) { for (const el of byKey.get(k) || []) el.classList.toggle('hot', on); }
function netText(n) {
  const v = e.value[n], s = e.state?.[n] || 0;
  return `${esc(nl.nets[n].name)} <small>${nl.nets[n].key}</small> = ${v}${s === Engine.CHARGE ? ' <small>charge only</small>' : s === Engine.SHORT ? ' <small>contention</small>' : ''}`;
}
function showTip(ev, html) {
  const r = $('view').getBoundingClientRect();
  tip.style.display = 'block';
  tip.style.left = `${ev.clientX - r.left + 14}px`; tip.style.top = `${ev.clientY - r.top + 14}px`;
  tip.innerHTML = html;
}
function hover(ev) {
  const t = ev.target.closest?.('[data-key]'), k = t?.dataset.key || null;
  if (k !== hot) { if (hot) light(hot, false); hot = k; if (k) light(k, true); }
  const tr = ev.target.closest?.('[data-tr]');
  if (k || tr) {
    const r = $('view').getBoundingClientRect();
    tip.style.display = 'block';
    tip.style.left = `${ev.clientX - r.left + 14}px`; tip.style.top = `${ev.clientY - r.top + 14}px`;
    tip.innerHTML = k ? (/^n\d+$/.test(k) ? netText(+k.slice(1)) : `${esc(Board.INFO[k] || k)} = ${Board.value(k, card, e)}`) : tr.dataset.tr.split(' ').map(i => `${nl.transistors[i].type}MOS ${nl.transistors[i].id} ${e.on[i] ? 'on' : 'off'}`).join(', ');
  } else tip.style.display = 'none';
}
svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; if (hot) light(hot, false); hot = null; });

// ---- rail: run controls, card, program
let running = true;
const ips = () => Math.round(10 ** (+$('speed').value / 25));   // instructions per second, 1 to 10000
function setRun(v) { running = v; $('run').innerHTML = v ? '❚❚ Pause' : '▶ Run'; }
$('run').onclick = () => setRun(!running);
function stepTo(done) {
  // Pause, then run in quarter half-periods until done() or 16 half-periods pass (as while halted).
  setRun(false);
  for (let i = 0; i < 64 && !done(); i++) e.run(clock.half / 4);
}
$('half').onclick = () => { const k = counter.edges; stepTo(() => counter.edges !== k); };
$('step').onclick = () => { const n = counter.n; stepTo(() => counter.n !== n); };
$('reset').onclick = () => card.load(e, prog.rom);
$('halt').onclick = () => card.halt(e, !card.halted);
$('speed').oninput = () => { $('speedv').textContent = `${ips()} instr/s`; };
$('speed').oninput();
$('clock').textContent = `X1 ${(1e-3 / period).toFixed(1)} kHz`;

$('ins').innerHTML = [0, 1, 2, 3, 4, 5, 6, 7].map(k => `<button class="sw${k ? '' : ' fixed'}" data-in="${k}" title="${k ? `input switch IN${k}` : 'input 0 reads RR'}"><i></i>${k ? 'IN' + k : 'RR'}</button>`).join('');
$('ins').onclick = ev => { const b = ev.target.closest('[data-in]'); if (b && +b.dataset.in) card.toggle(e, +b.dataset.in); };
$('outs').innerHTML = [0, 1, 2, 3, 4, 5, 6, 7].map(k => `<div class="led" data-out="${k}"><b></b>${k}</div>`).join('');
const PINS = ['X1', 'RST', 'DATA', 'I0', 'I1', 'I2', 'I3', 'RR', 'WRITE', 'JMP', 'RTN', 'O', 'F'];
$('pins').innerHTML = PINS.map(k => `<div class="led" data-pin="${k}" title="pin ${k}"><b></b>${k}</div>`).join('');
const leds = { outs: [...$('outs').children], ins: [...$('ins').children], pins: [...$('pins').children] };

const src = $('src'), hl = $('hl'), gut = $('gut');
for (const k of Object.keys(Asm.EXAMPLES)) $('example').add(new Option(k, k));
$('example').onchange = () => { src.value = Asm.EXAMPLES[$('example').value]; load(); };
src.value = Asm.EXAMPLES.chaser;
let curLine = -1, errLines = new Set();
function paint() {
  const lines = src.value.split('\n');
  hl.innerHTML = lines.map((l, i) => `<div class="${i + 1 === curLine ? 'cur' : errLines.has(i + 1) ? 'err' : ''}">${esc(l) || ' '}</div>`).join('');
  gut.innerHTML = lines.map((_, i) => errLines.has(i + 1) ? `<span class="e">${i + 1}</span>` : i + 1).join('\n');
  hl.scrollTop = src.scrollTop; hl.scrollLeft = src.scrollLeft; gut.scrollTop = src.scrollTop;
}
src.addEventListener('input', () => { errLines = new Set(); paint(); });
src.addEventListener('scroll', () => { hl.scrollTop = src.scrollTop; hl.scrollLeft = src.scrollLeft; gut.scrollTop = src.scrollTop; });
src.addEventListener('keydown', ev => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); load(); } });
function load() {
  const p = Asm.assemble(src.value);
  $('errors').textContent = p.errors.map(x => `line ${x.n}: ${x.msg}`).join('\n');
  errLines = new Set(p.errors.map(x => x.n));
  if (!p.errors.length) { prog = p; card.load(e, prog.rom); counter.n = 0; }
  paint();
}
$('assemble').onclick = load;

function rail() {
  const w = card.rom[card.pc], line = prog.lines[card.pc];
  $('pc').textContent = `${card.pc}`;
  $('ir').textContent = `${Asm.OPS[w >> 4]} ${w & 7}  (word ${hex(w, 2)})`;
  $('count').textContent = `${counter.n} instructions`;
  $('time').textContent = `${(e.t * 1e3).toFixed(3)} ms`;
  $('halt').textContent = card.halted ? 'Run' : 'Halt';
  leds.outs.forEach((el, k) => el.classList.toggle('on', !!(card.out >> k & 1)));
  leds.ins.forEach((el, k) => el.classList.toggle('on', !!(k ? card.ins >> k & 1 : e.get('RR'))));
  leds.pins.forEach(el => el.classList.toggle('on', !!e.get(el.dataset.pin)));
  const n = line && card.pc < prog.lines.length ? line.n : -1;
  if (n !== curLine) {
    curLine = n;
    paint();
    const top = (n - 1) * 18, ta = src;
    if (n > 0 && (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - 36)) ta.scrollTop = top - ta.clientHeight / 3;
  }
}

// ---- waveforms, theme, keys
const waves = new Waves($('waves'), e, n => nl.nets[n].name);
for (const k of WAVES) waves.add(nl.pins[k]);
$('wavesbtn').onclick = $('wavetabb').onclick = () => app.classList.toggle('waves');
$('railt').onclick = () => app.classList.toggle('norail');
$('zin').onclick = () => { if (mode3d) return die.zoomCentre(1 / 1.6); const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.6); };
$('zout').onclick = () => { if (mode3d) return die.zoomCentre(1.6); const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.6); };
$('fit').onclick = () => (mode3d ? die.fit() : animate(fit()));
function closeAll() { view.release(); index(); dirty = true; animate(fit()); }
$('collapse').onclick = closeAll;
$('theme').onclick = () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches, cur = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
  document.documentElement.dataset.theme = cur === 'dark' ? 'light' : 'dark';
  die?.colors();
  try { localStorage.setItem('mc14500b.theme', document.documentElement.dataset.theme); } catch { /* storage off */ }
};
try { const t = localStorage.getItem('mc14500b.theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* storage off */ }
die?.colors();
addEventListener('keydown', ev => {
  if (ev.target.closest('textarea, input, select')) return;
  const r = svg.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  switch (ev.key) {
    case ' ': ev.preventDefault(); setRun(!running); break;
    case '+': case '=': zoomAt(cx, cy, 1 / 1.6); break;
    case '-': case '_': zoomAt(cx, cy, 1.6); break;
    case '0': animate(fit()); break;
    case 'w': case 'W': app.classList.toggle('waves'); break;
    case '[': app.classList.toggle('norail'); break;
    case 'c': case 'C': if (!mode3d) closeAll(); break;
    case 'v': case 'V': setMode(!mode3d); break;
    case 'ArrowLeft': pan(80, 0); break;
    case 'ArrowRight': pan(-80, 0); break;
    case 'ArrowUp': pan(0, 80); break;
    case 'ArrowDown': pan(0, -80); break;
  }
});
new ResizeObserver(() => { setVB(vb); }).observe(svg);


// ---- the frame loop
let lastT = performance.now(), frames = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (anim) anim(now);
  if (running) {
    const target = e.t + ips() * dt * period, t0 = performance.now();
    while (e.t < target && performance.now() - t0 < BUDGET_MS) e.run(Math.min(target - e.t, clock.half));
  }
  if (mode3d) die.draw(e, now);
  else {
    if (dirty) { dirty = false; if (view.update()) index(); }
    refresh();
  }
  if (app.classList.contains('waves')) waves.draw();
  if (frames++ % 3 === 0) rail();
  requestAnimationFrame(frame);
}
setRun(true);
paint();
card.load(e, prog.rom);
setVB(fit());
index();
if (location.hash === '#die') setMode(true);
requestAnimationFrame(frame);
