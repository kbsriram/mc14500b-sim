// Waveforms of chosen nets, drawn on a canvas: one row per net, time running right in µs, the time axis in a strip
// below. Attached to the engine as a harness part, so it records every change, however many happen between two
// frames. The window follows the newest time until dragged or scrolled; a double-click follows again. Hovering a
// row's name shows its ×, which removes it; scrolling over the names scrolls the rows.
const ROW = 20, AXIS = 20, MAX_EVENTS = 50000;

class Waves {
  constructor(canvas, e, names) {
    Object.assign(this, { canvas, e, names, rows: [], span: 400e-6, end: null, follow: true, top: 0, hover: -1, labelW: 80 });
    e.parts.push(this);
    this.listen();
  }

  add(net) {
    if (this.rows.some(r => r.net === net)) return;
    this.rows.push({ net, ev: [[this.e.t, this.e.value[net], this.e.state?.[net] || 0]] });
  }

  remove(net) { this.rows = this.rows.filter(r => r.net !== net); }

  update(e) {
    // After every engine settle: record each row's net if it changed.
    for (const r of this.rows) {
      const last = r.ev[r.ev.length - 1], v = e.value[r.net], s = e.state?.[r.net] || 0;
      if (last[1] !== v || last[2] !== s) {
        r.ev.push([e.t, v, s]);
        if (r.ev.length > MAX_EVENTS) r.ev.splice(0, r.ev.length - MAX_EVENTS / 2);
      }
    }
  }

  rowAt(y) { const i = Math.floor(y / ROW) + this.top; return y < this.canvas.clientHeight - AXIS && i < this.rows.length ? i : -1; }

  listen() {
    const c = this.canvas;
    c.addEventListener('wheel', ev => {
      ev.preventDefault();
      if (ev.offsetX < this.labelW) {   // over the names: scroll the rows
        const fit = Math.floor((c.clientHeight - AXIS) / ROW);
        this.top = Math.max(0, Math.min(this.rows.length - fit, this.top + Math.sign(ev.deltaY)));
        return;
      }
      const t = this.timeAt(ev.offsetX);
      if (ev.ctrlKey || Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) {
        const f = Math.exp(ev.deltaY * 0.0025);
        this.span = Math.min(1, Math.max(5e-6, this.span * f));
        if (!this.follow) this.end = t + (this.end - t) * f;
      } else { this.follow = false; this.end = (this.end ?? this.e.t) + ev.deltaX * this.span / this.plotW(); }
    }, { passive: false });
    let drag = null;
    c.addEventListener('pointerdown', ev => {
      if (ev.offsetX < this.labelW) {   // the name column: its × removes the row
        const i = this.rowAt(ev.offsetY);
        if (i >= 0 && ev.offsetX > this.labelW - 22) { this.remove(this.rows[i].net); this.top = Math.max(0, Math.min(this.top, this.rows.length - 1)); }
        return;
      }
      drag = { x: ev.clientX, end: this.end ?? this.e.t };
      c.setPointerCapture(ev.pointerId);
    });
    c.addEventListener('pointermove', ev => {
      this.hover = ev.offsetX < this.labelW ? this.rowAt(ev.offsetY) : -1;
      c.style.cursor = this.hover >= 0 ? (ev.offsetX > this.labelW - 22 ? 'pointer' : 'default') : 'ew-resize';
      if (!drag) return;
      this.follow = false;
      this.end = drag.end - (ev.clientX - drag.x) * this.span / this.plotW();
    });
    c.addEventListener('pointerleave', () => { this.hover = -1; });
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('dblclick', () => { this.follow = true; this.end = null; });
  }

  plotW() { return Math.max(1, this.canvas.clientWidth - this.labelW - 12); }
  timeAt(x) { const end = this.follow ? this.e.t : this.end; return end - this.span + (x - this.labelW) / this.plotW() * this.span; }

  draw() {
    const c = this.canvas, dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
    const g = c.getContext('2d'), css = getComputedStyle(document.documentElement), col = k => css.getPropertyValue(k).trim();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const mono = col('--mono');
    g.font = `11px ${mono}`;
    this.labelW = Math.max(70, ...this.rows.map(r => g.measureText(this.names(r.net)).width)) + 34;
    const LW = this.labelW, end = this.follow ? Math.max(this.e.t, this.span) : this.end, t0 = end - this.span, pw = this.plotW(), PH = H - AXIS;
    const X = t => LW + (t - t0) / this.span * pw;
    // time grid: a round step giving about 8 lines; labels in the strip below the rows
    const step = [1, 2, 5].map(m => m * 10 ** Math.floor(Math.log10(this.span / 8))).find(s => this.span / s <= 10) || this.span / 8;
    g.strokeStyle = col('--line'); g.lineWidth = 1; g.fillStyle = col('--ink3'); g.font = `10px ${mono}`;
    g.beginPath(); g.moveTo(0, PH + 0.5); g.lineTo(W, PH + 0.5); g.stroke();
    for (let t = Math.ceil(t0 / step) * step; t <= end; t += step) {
      const x = Math.round(X(t)) + 0.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, PH); g.stroke();
      g.fillText(`${(t * 1e6).toFixed(step < 1e-6 ? 1 : 0)} µs`, x + 3, H - 6);
    }
    document.getElementById('wspan').textContent = `${(this.span * 1e6).toFixed(0)} µs window${this.follow ? ' · following' : ''}`;
    const fit = Math.floor(PH / ROW);
    this.rows.slice(this.top, this.top + fit).forEach((r, j) => {
      const i = j + this.top, y0 = j * ROW, hi = y0 + 5, lo = y0 + ROW - 5;
      g.fillStyle = col('--ink'); g.font = `11px ${mono}`;
      g.fillText(this.names(r.net), 10, y0 + ROW / 2 + 4);
      if (i === this.hover) { g.fillStyle = col('--ink2'); g.fillText('×', LW - 18, y0 + ROW / 2 + 4); }
      g.strokeStyle = col('--line'); g.beginPath(); g.moveTo(0, y0 + ROW + 0.5); g.lineTo(W, y0 + ROW + 0.5); g.stroke();
      // the events in view, and the one before
      let k = r.ev.length - 1;
      while (k > 0 && r.ev[k][0] > t0) k--;
      g.lineWidth = 1.6;
      for (; k < r.ev.length; k++) {
        const [t, v, s] = r.ev[k], tn = k + 1 < r.ev.length ? r.ev[k + 1][0] : this.e.t;
        if (t > end) break;
        const xa = Math.max(LW, X(t)), xb = Math.min(LW + pw, X(tn)), y = v ? hi : lo;
        g.strokeStyle = s === 2 ? col('--x') : v ? col('--hi') : col('--lo');
        g.setLineDash(s === 1 ? [4, 3] : []);
        g.beginPath();
        if (k > 0 && X(t) >= LW) { g.moveTo(xa, r.ev[k - 1][1] ? hi : lo); g.lineTo(xa, y); } else g.moveTo(xa, y);
        g.lineTo(xb, y);
        g.stroke();
        if (v) { g.fillStyle = g.strokeStyle; g.globalAlpha = 0.08; g.fillRect(xa, hi, xb - xa, lo - hi); g.globalAlpha = 1; }
      }
      g.setLineDash([]);
    });
    if (this.rows.length > fit) {   // more rows below: say how many
      g.fillStyle = col('--ink3'); g.font = `10px ${mono}`;
      g.fillText(`${this.top + 1}–${Math.min(this.rows.length, this.top + fit)} of ${this.rows.length}`, 10, H - 6);
    }
  }
}

if (typeof module !== 'undefined') module.exports = Waves;
