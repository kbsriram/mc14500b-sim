// The die in 3D, from site/gen/die.js: each traced layer extruded to a fixed height, coloured each frame from the
// engine. Metal, contacts and doped silicon take their net's value; a channel is green while its transistor conducts.
// Drawn with WebGL2 where the browser has it: colours come from a texture of states, one texel per net and per
// transistor. Otherwise with Canvas 2D: layers bottom to top, the shapes of a layer far to near, each shape's
// walls that face the eye, then its top.
// Gestures: drag rotates about the target point; right-drag or shift-drag pans; the wheel or a pinch zooms
// toward the pointer; arrows rotate; a double-click centres the point there. The tilt has no limit, so the eye
// can pass under the die: the silicon plane is then left out.
// Picking intersects the pointer's ray with each visible layer's top plane, highest first.
const DIE_Z = { resistor: [0, 1], nplus: [0, 6], pplus: [0, 6], channel: [0, 4], contact: [6, 30], metal: [30, 40], base: [0, 0] };
const DIE_FOV = 40 * Math.PI / 180;
const DIE_GRID = 256;   // px; cell of the picking index

class DieView {
  constructor(canvas, nl, geo, labels, opts = {}) {
    // opts.canvas2d: draw with Canvas 2D even where WebGL2 is available.
    const gl = opts.canvas2d ? null : canvas.getContext('webgl2', { antialias: true });
    const ctx = gl ? null : canvas.getContext('2d');
    if (!gl && !ctx) throw new Error('the canvas has no drawing context');
    Object.assign(this, { canvas, gl, ctx, nl, geo, labels, nn: nl.nets.length, active: false, hot: -2,
      show: { metal: 'solid', contact: true, diffusion: true, channel: true }, keys: new Set(), anim: null,
      onHover: () => {}, onClick: () => {} });
    this.layers = [...geo.layers, 'base'];
    this.index();
    if (gl) { this.build(); this.program(); } else this.prepare2d();
    this.colors();
    this.fit(false);
    this.listen();
    this.makeLabels();
  }

  // ---- geometry: one interleaved buffer, faces grouped by layer; outlines in a second buffer
  build() {
    const { geo } = this, faces = this.layers.map(() => []), lines = this.layers.map(() => []);
    const put = (a, x, y, z, nx, ny, nz, k, l) => a.push(x, -y, z, nx, ny, nz, k, l);
    const rings = s => { const n = s.p.length / 2, st = [0, ...s.r, n]; return st.slice(0, -1).map((a, i) => [a, st[i + 1]]); };
    geo.shapes.forEach(s => {
      const name = geo.layers[s.l], [z0, z1] = DIE_Z[name], F = faces[s.l], E = lines[s.l], p = s.p;
      const k = name === 'channel' ? this.nn + s.k : s.k;   // the state texture: nets, then transistors
      for (const i of s.t) put(F, p[2 * i], p[2 * i + 1], z1, 0, 0, 1, k, s.l);
      for (const [a, b] of rings(s)) for (let i = a; i < b; i++) {
        const j = i + 1 < b ? i + 1 : a, x0 = p[2 * i], y0 = p[2 * i + 1], x1 = p[2 * j], y1 = p[2 * j + 1];
        const len = Math.hypot(x1 - x0, y1 - y0) || 1, nx = (y1 - y0) / len, ny = (x1 - x0) / len;   // in world (y flipped)
        for (const [x, y, z] of [[x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z0], [x1, y1, z1], [x0, y0, z1]]) put(F, x, y, z, nx, ny, 0, k, s.l);
        put(E, x0, y0, z1, 0, 0, 1, k, s.l); put(E, x1, y1, z1, 0, 0, 1, k, s.l);
      }
    });
    const base = this.layers.length - 1, W = geo.w, H = geo.h;
    for (const [x, y] of [[0, 0], [W, 0], [W, H], [0, 0], [W, H], [0, H]]) put(faces[base], x, y, 0, 0, 0, 1, -1, base);
    const pack = arrs => {
      const ranges = [], n = arrs.reduce((m, a) => m + a.length, 0), buf = new Float32Array(n);
      let at = 0;
      for (const a of arrs) { buf.set(a, at); ranges.push([at / 8, a.length / 8]); at += a.length; }
      return { buf, ranges };
    };
    this.faces = pack(faces); this.lines = pack(lines);
  }

  index() {
    // Per layer, a grid of cells DIE_GRID px square listing the shapes whose box meets each cell.
    this.grid = this.layers.map(() => new Map());
    this.geo.shapes.forEach((s, i) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let j = 0; j < s.p.length; j += 2) { x0 = Math.min(x0, s.p[j]); x1 = Math.max(x1, s.p[j]); y0 = Math.min(y0, s.p[j + 1]); y1 = Math.max(y1, s.p[j + 1]); }
      const g = this.grid[s.l];
      for (let cx = Math.floor(x0 / DIE_GRID); cx <= Math.floor(x1 / DIE_GRID); cx++)
        for (let cy = Math.floor(y0 / DIE_GRID); cy <= Math.floor(y1 / DIE_GRID); cy++) {
          const k = cx * 4096 + cy;
          if (!g.has(k)) g.set(k, []);
          g.get(k).push(i);
        }
    });
  }

  shapeAt(l, x, y) {
    // The shape of layer l containing die point (x, y), by the even-odd rule over its rings, or null.
    for (const i of this.grid[l].get(Math.floor(x / DIE_GRID) * 4096 + Math.floor(y / DIE_GRID)) || []) {
      const s = this.geo.shapes[i], p = s.p, st = [0, ...s.r, p.length / 2];
      let inside = false;
      for (let r = 0; r + 1 < st.length; r++)
        for (let a = st[r], j = st[r + 1] - 1; a < st[r + 1]; j = a++) {
          const xa = p[2 * a], ya = p[2 * a + 1], xb = p[2 * j], yb = p[2 * j + 1];
          if ((ya > y) !== (yb > y) && x < (xb - xa) * (y - ya) / (yb - ya) + xa) inside = !inside;
        }
      if (inside) return s;
    }
    return null;
  }

  // ---- shaders
  program() {
    const gl = this.gl;
    const vs = `#version 300 es
      in vec3 a_pos; in vec3 a_nrm; in float a_key; in float a_layer;
      uniform mat4 u_mvp; uniform highp usampler2D u_state;
      uniform vec3 u_pal[8]; uniform vec3 u_base[7]; uniform float u_mix[7];
      uniform float u_hot; uniform float u_edge; uniform float u_alpha;
      out vec4 v_color;
      void main() {
        int k = int(a_key), l = int(a_layer);
        vec3 c = u_base[l];
        if (k >= 0) {
          uint s = texelFetch(u_state, ivec2(k % 1024, k / 1024), 0).r;
          if (l == 3) c = s == 1u ? u_pal[5] : u_base[3];
          else c = mix(c, u_pal[int(s)], u_mix[l]);
        }
        c *= 0.66 + 0.34 * abs(dot(a_nrm, normalize(vec3(0.35, 0.55, 1.0))));
        if (u_edge > 0.5) c *= 0.72;
        if (k >= 0 && a_key == u_hot) c = mix(c, u_pal[7], 0.5);
        v_color = vec4(c, u_alpha);
        gl_Position = u_mvp * vec4(a_pos, 1.0);
      }`;
    const fs = `#version 300 es
      precision mediump float; in vec4 v_color; out vec4 o; void main() { o = v_color; }`;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p;
    this.u = Object.fromEntries(['u_mvp', 'u_state', 'u_pal', 'u_base', 'u_mix', 'u_hot', 'u_edge', 'u_alpha'].map(n => [n, gl.getUniformLocation(p, n)]));
    const vao = buf => {
      const v = gl.createVertexArray(), b = gl.createBuffer();
      gl.bindVertexArray(v); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
      [['a_pos', 3, 0], ['a_nrm', 3, 12], ['a_key', 1, 24], ['a_layer', 1, 28]].forEach(([n, size, off]) => {
        const at = gl.getAttribLocation(p, n);
        gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, size, gl.FLOAT, false, 32, off);
      });
      return v;
    };
    this.faceVao = vao(this.faces.buf); this.lineVao = vao(this.lines.buf);
    const n = this.nn + this.nl.transistors.length;
    this.state = new Uint8Array(1024 * Math.ceil(n / 1024));
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 1024, this.state.length / 1024, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.state);
  }

  colors() {
    // The page's colour tokens, read again after a theme change.
    const css = getComputedStyle(document.documentElement), c2d = document.createElement('canvas').getContext('2d');
    const rgb = v => { c2d.fillStyle = '#000'; c2d.fillStyle = v.trim() || '#888'; const h = c2d.fillStyle; return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
    const t = k => rgb(css.getPropertyValue(k)), dark = rgb(css.getPropertyValue('--bg'))[0] < 0.5;
    const mixc = (a, b, f) => a.map((x, i) => x + (b[i] - x) * f);
    this.bg = t('--bg');
    // state codes: 0 low, 1 high, 2 low by charge only, 3 high by charge only, 4 contention; 5 a conducting channel
    this.pal = [t('--lo'), t('--hi'), t('--loq'), t('--hiq'), t('--x'), t('--on'), t('--sym'), t('--hot')];
    const base = t('--line'), sym = t('--sym');
    this.base = [mixc(base, sym, 0.35), dark ? [0.30, 0.36, 0.30] : [0.72, 0.77, 0.69], dark ? [0.38, 0.31, 0.29] : [0.80, 0.72, 0.67],
      mixc(sym, [0, 0, 0], 0.25), t('--ink2'), dark ? [0.45, 0.47, 0.50] : [0.78, 0.79, 0.81], base];
    this.mix = [0, 0.5, 0.5, 0, 0.6, 0.8, 0];
    if (this.ctx) this.colors2d();
  }

  // ---- camera: a target point, an azimuth (yaw), an elevation (pitch) and a distance, all in die px
  fit(animate = true) {
    const a = this.aspect(), th = Math.tan(DIE_FOV / 2);
    const to = { tx: this.geo.w / 2, ty: -this.geo.h / 2, tz: 0, yaw: 0, pitch: Math.PI / 2,
      dist: 1.06 * Math.max(this.geo.h / 2 / th, this.geo.w / 2 / (th * a)) };
    if (animate && this.cam) this.flyTo(to); else this.cam = to;
  }

  aspect() { const r = this.canvas.getBoundingClientRect(); return r.width && r.height ? r.width / r.height : 1.5; }

  basis() {
    const c = this.cam, cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    const eye = [c.tx + c.dist * cp * Math.sin(c.yaw), c.ty - c.dist * cp * Math.cos(c.yaw), c.tz + c.dist * sp];
    // up: the eye's direction of motion as the tilt grows, so the view turns smoothly over the top and underneath
    const f = v3norm([c.tx - eye[0], c.ty - eye[1], c.tz - eye[2]]), u = [-sp * Math.sin(c.yaw), sp * Math.cos(c.yaw), cp], r = v3cross(f, u);
    return { eye, f, r, u };
  }

  matrix() {
    const { eye, f, r, u } = this.basis(), a = this.aspect(), n = Math.max(0.5, this.cam.dist * 0.01), far = this.cam.dist * 4 + 4 * this.geo.w;
    const k = 1 / Math.tan(DIE_FOV / 2);
    const P = [k / a, 0, 0, 0, 0, k, 0, 0, 0, 0, (far + n) / (n - far), -1, 0, 0, 2 * far * n / (n - far), 0];
    const V = [r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -v3dot(r, eye), -v3dot(u, eye), v3dot(f, eye), 1];
    return m4mul(P, V);
  }

  ray(cx, cy) {
    // The pointer's ray from the eye: [eye, direction], for client point (cx, cy).
    const rc = this.canvas.getBoundingClientRect(), { eye, f, r, u } = this.basis(), th = Math.tan(DIE_FOV / 2);
    const x = (2 * (cx - rc.left) / rc.width - 1) * th * this.aspect(), y = (1 - 2 * (cy - rc.top) / rc.height) * th;
    return [eye, v3norm([f[0] + r[0] * x + u[0] * y, f[1] + r[1] * x + u[1] * y, f[2] + r[2] * x + u[2] * y])];
  }

  onPlane(cx, cy, z) {
    const [e, d] = this.ray(cx, cy);
    if (Math.abs(d[2]) < 1e-6) return null;
    const t = (z - e[2]) / d[2];
    return t > 0 ? [e[0] + d[0] * t, e[1] + d[1] * t, z] : null;
  }

  pick(cx, cy) {
    // {shape, at: world point} under the pointer: the nearest visible layer whose top plane the ray meets inside
    // a shape; clear metal is tried last from above, so the layers under it can be picked.
    const order = ['metal', 'contact', 'nplus', 'pplus', 'channel'].filter(n => this.visible(n));
    if (this.show.metal === 'clear') order.push(order.shift());
    if (this.basis().eye[2] < 0) order.reverse();   // from below, the lowest layer is nearest
    for (const name of order) {
      const at = this.onPlane(cx, cy, DIE_Z[name][1]);
      const s = at && this.shapeAt(this.layers.indexOf(name), at[0], -at[1]);
      if (s) return { shape: s, layer: name, at };
    }
    return null;
  }

  visible(name) {
    return name === 'metal' ? this.show.metal !== 'off' : name === 'contact' ? this.show.contact
      : name === 'channel' ? this.show.channel : name === 'base' || this.show.diffusion;
  }

  zoomAt(cx, cy, f) {
    // Scale the distance by f about the point under (cx, cy), which stays under the pointer.
    const c = this.cam, hit = this.pick(cx, cy)?.at || this.onPlane(cx, cy, 0);
    const d = Math.min(Math.max(c.dist * f, 30), 8 * this.geo.w), k = d / c.dist;
    if (hit) { c.tx = hit[0] + (c.tx - hit[0]) * k; c.ty = hit[1] + (c.ty - hit[1]) * k; c.tz = hit[2] + (c.tz - hit[2]) * k; }
    c.dist = d;
  }

  panBy(x0, y0, x1, y1) {
    // Move the target so the ground point under (x0, y0) comes under (x1, y1); on screen axes when the view is low.
    const c = this.cam, a = this.onPlane(x0, y0, c.tz), b = this.onPlane(x1, y1, c.tz);
    if (a && b && Math.abs(Math.sin(c.pitch)) > 0.25 && Math.hypot(a[0] - b[0], a[1] - b[1]) < c.dist) { c.tx -= b[0] - a[0]; c.ty -= b[1] - a[1]; return; }
    const { r, u } = this.basis(), s = 2 * c.dist * Math.tan(DIE_FOV / 2) / this.canvas.getBoundingClientRect().height;
    for (let i = 0; i < 3; i++) { const v = -(x1 - x0) * s * r[i] + (y1 - y0) * s * u[i]; if (i === 0) c.tx += v; else if (i === 1) c.ty += v; else c.tz += v; }
  }

  rotate(dx, dy) {
    const c = this.cam;
    c.yaw -= dx * 0.005 * (Math.cos(c.pitch) < 0 ? -1 : 1);   // upside down, the same drag turns the other way
    c.pitch = Math.atan2(Math.sin(c.pitch + dy * 0.005), Math.cos(c.pitch + dy * 0.005));   // in (-π, π]
  }

  flyTo(to, ms = 320) {
    const from = { ...this.cam }, t0 = performance.now();
    this.anim = now => {
      const t = Math.min(1, (now - t0) / ms), s = t * t * (3 - 2 * t);
      for (const k of Object.keys(to)) this.cam[k] = from[k] + (to[k] - from[k]) * s;
      if (t >= 1) this.anim = null;
    };
  }

  // ---- input
  listen() {
    const cv = this.canvas, ptrs = new Map();
    let g = null, moved = false;
    cv.addEventListener('contextmenu', ev => ev.preventDefault());
    cv.addEventListener('wheel', ev => {
      ev.preventDefault(); this.anim = null;
      const mouse = ev.deltaMode === 1 || (ev.deltaX === 0 && Math.abs(ev.deltaY) >= 50 && Number.isInteger(ev.deltaY));
      if (ev.ctrlKey || mouse) this.zoomAt(ev.clientX, ev.clientY, Math.exp(ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0022)));
      else this.panBy(ev.clientX, ev.clientY, ev.clientX - ev.deltaX, ev.clientY - ev.deltaY);
    }, { passive: false });
    const two = () => { const [a, b] = [...ptrs.values()]; return { d: Math.hypot(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }; };
    cv.addEventListener('pointerdown', ev => {
      ptrs.set(ev.pointerId, [ev.clientX, ev.clientY]);
      moved = false; this.anim = null;
      g = ptrs.size === 2 ? { pinch: two() } : { x: ev.clientX, y: ev.clientY, pan: ev.button === 2 || ev.shiftKey };
    });
    cv.addEventListener('pointermove', ev => {
      if (!ptrs.has(ev.pointerId)) { this.hover(ev); return; }
      ptrs.set(ev.pointerId, [ev.clientX, ev.clientY]);
      if (ptrs.size === 2 && g?.pinch) {
        const p = two();
        this.zoomAt(p.m[0], p.m[1], g.pinch.d / p.d);
        this.panBy(g.pinch.m[0], g.pinch.m[1], p.m[0], p.m[1]);
        g = { pinch: p }; moved = true;
      } else if (g && !g.pinch) {
        const dx = ev.clientX - g.x, dy = ev.clientY - g.y;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        if (!moved) cv.setPointerCapture(ev.pointerId);
        moved = true;
        if (g.pan) this.panBy(g.x, g.y, ev.clientX, ev.clientY); else this.rotate(dx, dy);
        g.x = ev.clientX; g.y = ev.clientY;
        this.onHover(null, ev);
      }
    });
    const lift = ev => { ptrs.delete(ev.pointerId); g = null; };
    cv.addEventListener('pointerup', lift);
    cv.addEventListener('pointercancel', lift);
    cv.addEventListener('pointerleave', ev => { if (!ptrs.size) { this.hot = -2; this.onHover(null, ev); } });
    cv.addEventListener('click', ev => { if (!moved) this.onClick(this.pick(ev.clientX, ev.clientY), ev); });
    cv.addEventListener('dblclick', ev => {
      const h = this.pick(ev.clientX, ev.clientY);
      if (h) this.flyTo({ tx: h.at[0], ty: h.at[1], tz: h.at[2], dist: this.cam.dist * 0.6 });
    });
    // keys: registered before the page's own handler, which they stop
    const TURN = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
    addEventListener('keydown', ev => {
      if (!this.active || ev.target.closest?.('textarea, input, select') || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const k = ev.key;
      if (TURN.has(k)) { this.keys.add(k); ev.preventDefault(); ev.stopImmediatePropagation(); }
      else if (k === '+' || k === '=' || k === '-' || k === '_' || k === '0') {
        if (k === '0') this.fit(); else this.zoomCentre(k === '-' || k === '_' ? 1.6 : 1 / 1.6);
        ev.stopImmediatePropagation();
      }
    });
    addEventListener('keyup', ev => { this.keys.delete(ev.key); });
    addEventListener('blur', () => this.keys.clear());
  }

  zoomCentre(f) { const r = this.canvas.getBoundingClientRect(); this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); }

  hover(ev) {
    const h = this.pick(ev.clientX, ev.clientY);
    this.hot = h ? (h.layer === 'channel' ? this.nn + h.shape.k : h.shape.k) : -2;
    this.onHover(h, ev);
  }

  turn(dt) {
    // Held arrow keys rotate the view, 1.5 radians per second.
    const K = this.keys;
    if (K.has('ArrowLeft')) this.rotate(-300 * dt, 0); if (K.has('ArrowRight')) this.rotate(300 * dt, 0);
    if (K.has('ArrowUp')) this.rotate(0, -300 * dt); if (K.has('ArrowDown')) this.rotate(0, 300 * dt);
  }

  // ---- labels: package pins and block names, placed over the die each frame
  makeLabels() {
    const box = this.labels, nl = this.nl;
    this.marks = [];
    for (const [name, [x, y]] of Object.entries(nl.die.pins)) this.marks.push({ name, at: [x, -y, DIE_Z.metal[1]], cls: 'pin' });
    for (const b of nl.blocks) this.marks.push({ name: b.name, at: [(b.box[0] + b.box[2]) / 2, -(b.box[1] + b.box[3]) / 2, DIE_Z.metal[1] + 60], cls: 'blk' });
    box.innerHTML = '';
    for (const m of this.marks) { m.el = document.createElement('span'); m.el.className = m.cls; m.el.textContent = m.name; box.appendChild(m.el); }
  }

  placeLabels(M, W, H) {
    for (const m of this.marks) {
      const [x, y, z] = m.at, w = M[3] * x + M[7] * y + M[11] * z + M[15];
      const sx = ((M[0] * x + M[4] * y + M[8] * z + M[12]) / w + 1) / 2 * W, sy = (1 - (M[1] * x + M[5] * y + M[9] * z + M[13]) / w) / 2 * H;
      const on = w > 0 && sx > -40 && sx < W + 40 && sy > -20 && sy < H + 20;
      m.el.style.display = on ? '' : 'none';
      if (on) m.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%)`;
    }
  }

  // ---- a frame
  draw(e, now) {
    const gl = this.gl, cv = this.canvas, dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    const dt = Math.min(0.1, (now - (this.lastT ?? now)) / 1000);
    this.lastT = now;
    if (this.anim) this.anim(now);
    this.turn(dt);
    const k = gl ? dpr : Math.min(dpr, 1.5);   // Canvas 2D: fewer pixels to fill
    if (cv.width !== Math.round(W * k) || cv.height !== Math.round(H * k)) { cv.width = Math.round(W * k); cv.height = Math.round(H * k); }
    const M = this.matrix();
    if (gl) this.drawGL(e, M); else this.draw2d(e, M, W, H, k);
    this.placeLabels(M, W, H);
  }

  drawGL(e, M) {
    const gl = this.gl, cv = this.canvas;
    const st = this.state, nn = this.nn, es = e.state || [];
    for (let n = 0; n < nn; n++) st[n] = es[n] === Engine.SHORT ? 4 : (es[n] === Engine.CHARGE ? 2 : 0) + (e.value[n] ? 1 : 0);
    for (let i = 0; i < e.on.length; i++) st[nn + i] = e.on[i] ? 1 : 0;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, st.length / 1024, gl.RED_INTEGER, gl.UNSIGNED_BYTE, st);

    gl.viewport(0, 0, cv.width, cv.height);
    gl.clearColor(...this.bg, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.useProgram(this.prog);
    const u = this.u;
    gl.uniformMatrix4fv(u.u_mvp, false, M);
    gl.uniform1i(u.u_state, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform3fv(u.u_pal, this.pal.flat()); gl.uniform3fv(u.u_base, this.base.flat()); gl.uniform1fv(u.u_mix, this.mix);
    gl.uniform1f(u.u_hot, this.hot);
    const L = this.layers, show = l => this.visible(L[l] === 'resistor' ? 'base' : L[l]) && (L[l] !== 'resistor' || this.show.diffusion);
    const pass = (vao, ranges, mode, edge, alpha, which) => {
      gl.bindVertexArray(vao); gl.uniform1f(u.u_edge, edge); gl.uniform1f(u.u_alpha, alpha);
      ranges.forEach(([first, count], l) => { if (count && which(l)) gl.drawArrays(mode, first, count); });
    };
    const metal = L.indexOf('metal'), under = this.basis().eye[2] < 0;
    const solid = l => show(l) && (l !== metal || this.show.metal === 'solid') && !(under && L[l] === 'base');
    gl.disable(gl.BLEND); gl.depthMask(true);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
    pass(this.faceVao, this.faces.ranges, gl.TRIANGLES, 0, 1, solid);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    pass(this.lineVao, this.lines.ranges, gl.LINES, 1, 1, solid);
    if (this.show.metal === 'clear') {
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      pass(this.faceVao, this.faces.ranges, gl.TRIANGLES, 0, 0.28, l => l === metal);
      pass(this.lineVao, this.lines.ranges, gl.LINES, 1, 0.6, l => l === metal);
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
  }

  // ---- Canvas 2D
  prepare2d() {
    // Per shape: world vertices (y flipped), rings, each edge's outward normal, centroid, heights and draw group.
    const GROUP = { resistor: 1, nplus: 2, pplus: 2, channel: 2, contact: 3, metal: 4 };
    this.solids = this.geo.shapes.map(s => {
      const name = this.geo.layers[s.l], [z0, z1] = DIE_Z[name], n = s.p.length / 2;
      const x = new Float64Array(n), y = new Float64Array(n), nx = new Float64Array(n), ny = new Float64Array(n);
      for (let i = 0; i < n; i++) { x[i] = s.p[2 * i]; y[i] = -s.p[2 * i + 1]; }
      const st = [0, ...s.r, n], rings = st.slice(0, -1).map((a, i) => [a, st[i + 1]]);
      rings.forEach(([a, b], ri) => {
        let area = 0;
        for (let i = a; i < b; i++) { const j = i + 1 < b ? i + 1 : a; area += x[i] * y[j] - x[j] * y[i]; }
        const sign = (ri === 0) === (area > 0) ? 1 : -1;   // an outline counter-clockwise, a hole clockwise
        for (let i = a; i < b; i++) {
          const j = i + 1 < b ? i + 1 : a, dx = x[j] - x[i], dy = y[j] - y[i], len = Math.hypot(dx, dy) || 1;
          nx[i] = sign * dy / len; ny[i] = -sign * dx / len;
        }
      });
      let cx = 0, cy = 0;
      for (let i = 0; i < n; i++) { cx += x[i]; cy += y[i]; }
      return { l: s.l, name, k: name === 'channel' ? this.nn + s.k : s.k, x, y, nx, ny, rings, z0, z1, cx: cx / n, cy: cy / n,
        group: GROUP[name] };
    });
    this.groups = [1, 2, 3, 4].map(g => this.solids.filter(s => s.group === g));
  }

  colors2d() {
    // CSS colours by layer, state code (-1: no net) and kind: 0 top, 1 wall, 2 outline; kinds 3-5 the same, lit.
    const css = c => `rgb(${c.map(v => Math.round(Math.min(1, v) * 255)).join(',')})`;
    const mixc = (a, b, f) => a.map((x, i) => x + (b[i] - x) * f);
    this.css = this.layers.map((_, l) => [-1, 0, 1, 2, 3, 4, 5].map(code => {
      let c = this.base[l];
      if (code >= 0) c = l === 3 ? (code === 1 ? this.pal[5] : this.base[3]) : mixc(c, this.pal[Math.min(code, 4)], this.mix[l]);
      const kinds = [0.944, 0.75, 0.68].map(f => c.map(v => v * f));
      return [...kinds, ...kinds.map(k => mixc(k, this.pal[7], 0.5))].map(css);
    }));
    this.bgCss = css(this.bg);
  }

  draw2d(e, M, W, H, k) {
    const ctx = this.ctx, es = e.state || [], nn = this.nn, eye = this.basis().eye;
    const code = key => key < 0 ? -1 : key >= nn ? (e.on[key - nn] ? 1 : 0)
      : es[key] === Engine.SHORT ? 4 : (es[key] === Engine.CHARGE ? 2 : 0) + (e.value[key] ? 1 : 0);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = this.bgCss; ctx.fillRect(0, 0, W, H);
    ctx.lineJoin = 'round';
    this.view2d = { M, W, H, near: this.cam.dist * 0.01, eye };
    const base = { x: [0, this.geo.w, this.geo.w, 0], y: [0, 0, -this.geo.h, -this.geo.h], rings: [[0, 4]], z0: 0, z1: 0, l: 6, k: -1 };
    const under = eye[2] < 0;
    if (!under) this.shape2d(ctx, base, -1, false);
    const walls = Math.abs(Math.cos(this.cam.pitch)) > 0.07, show = { 1: this.show.diffusion, 3: this.show.contact, 4: this.show.metal !== 'off' };
    const order = [...this.groups.entries()];
    if (under) order.reverse();   // from below, metal is farthest
    for (const [gi, group] of order) {
      const g = gi + 1;
      if (g !== 2 && !show[g]) continue;
      ctx.globalAlpha = g === 4 && this.show.metal === 'clear' ? 0.3 : 1;
      const list = [];
      for (const s of group) {
        if (g === 2 && !(s.name === 'channel' ? this.show.channel : this.show.diffusion)) continue;
        const dx = s.cx - eye[0], dy = s.cy - eye[1], dz = (s.z0 + s.z1) / 2 - eye[2];
        s.depth = dx * dx + dy * dy + dz * dz;
        list.push(s);
      }
      list.sort((a, b) => b.depth - a.depth);
      for (const s of list) this.shape2d(ctx, s, code(s.k), walls);
    }
    ctx.globalAlpha = 1;
  }

  shape2d(ctx, s, c, walls) {
    // One shape: its walls that face the eye and its top, the nearer last, both clipped at the near plane.
    const { M, W, H, near, eye } = this.view2d, n = s.x.length;
    const P = (x, y, z) => {
      const w = M[3] * x + M[7] * y + M[11] * z + M[15];
      return [((M[0] * x + M[4] * y + M[8] * z + M[12]) / w + 1) / 2 * W, (1 - (M[1] * x + M[5] * y + M[9] * z + M[13]) / w) / 2 * H, w];
    };
    const top = [];
    for (let i = 0; i < n; i++) top.push(P(s.x[i], s.y[i], s.z1));
    // the top's rings, clipped where w < near: an edge that crosses gets its point at w = near
    const rings = [];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [a, b] of s.rings) {
      const out = [];
      for (let i = a; i < b; i++) {
        const j = i + 1 < b ? i + 1 : a, pi = top[i], pj = top[j];
        if (pi[2] >= near) out.push(pi);
        if ((pi[2] >= near) !== (pj[2] >= near)) {
          const t = (near - pi[2]) / (pj[2] - pi[2]);
          out.push(P(s.x[i] + (s.x[j] - s.x[i]) * t, s.y[i] + (s.y[j] - s.y[i]) * t, s.z1));
        }
      }
      if (out.length < 3) continue;
      for (const q of out) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
      rings.push(out);
    }
    if (!rings.length || x1 < 0 || x0 > W || y1 < 0 || y0 > H) return;
    const col = this.css[s.l][c + 1], hot = s.k >= 0 && s.k === this.hot ? 3 : 0;
    const drawTop = () => {
      ctx.beginPath();
      for (const r of rings) { ctx.moveTo(r[0][0], r[0][1]); for (let i = 1; i < r.length; i++) ctx.lineTo(r[i][0], r[i][1]); ctx.closePath(); }
      ctx.fillStyle = col[0 + hot]; ctx.fill('evenodd');
      if (s.l !== 6 && (x1 - x0 > 8 || y1 - y0 > 8)) { ctx.strokeStyle = col[2 + hot]; ctx.lineWidth = 1; ctx.stroke(); }
    };
    const below = eye[2] < s.z1;   // the top faces away: draw it first, under the walls
    if (below) drawTop();
    if (walls && s.z1 > s.z0) {
      const bot = [];
      for (let i = 0; i < n; i++) bot.push(P(s.x[i], s.y[i], s.z0));
      ctx.beginPath();
      let any = false;
      for (const [a, b] of s.rings) for (let i = a; i < b; i++) {
        const j = i + 1 < b ? i + 1 : a;
        if (s.nx[i] * (eye[0] - s.x[i]) + s.ny[i] * (eye[1] - s.y[i]) <= 0) continue;   // faces away
        if (top[i][2] < near || top[j][2] < near || bot[i][2] < near || bot[j][2] < near) continue;
        if (Math.abs(top[i][1] - bot[i][1]) + Math.abs(top[i][0] - bot[i][0]) < 0.5) continue;   // too short to see
        ctx.moveTo(top[i][0], top[i][1]); ctx.lineTo(top[j][0], top[j][1]); ctx.lineTo(bot[j][0], bot[j][1]); ctx.lineTo(bot[i][0], bot[i][1]); ctx.closePath();
        any = true;
      }
      if (any) { ctx.fillStyle = col[1 + hot]; ctx.fill(); }
    }
    if (!below) drawTop();
  }
}

function v3norm(v) { const n = Math.hypot(...v) || 1; return v.map(x => x / n); }
function v3cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function v3dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function m4mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

if (typeof module !== 'undefined') module.exports = DieView;
