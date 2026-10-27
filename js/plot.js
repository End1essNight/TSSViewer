/*
 * Canvas waveform plot: vertically stacked panes sharing one time axis.
 *
 *   drag a waveform        sideways: shift it in time (onShiftDrag); up/down: move its level (onLevelDrag)
 *   Alt+wheel              scale the selected waveform (onLevelScale)
 *   drag background        pan            Shift+drag / Zoom mode   box zoom
 *   wheel                  zoom time      Shift+wheel or wheel on the Y axis   zoom Y
 *   drag on the Y axis     pan Y          double-click            fit everything
 *
 * A trace is {id, series: Series, shift: seconds, color, visible, selected, name, yGain, yOff}; it is drawn at
 * value * yGain + yOff on its pane's axis (display only: readouts use the value itself).
 */
'use strict';

class Plot {
  constructor(canvas, cb = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = cb;
    this.panes = [];          // {key, title, unit, traces, y0, y1, yAuto, rect}
    this.x0 = 0; this.x1 = 1e-6;
    this.mode = 'pan';        // 'pan' | 'zoom'
    this.cursors = null;      // {a, b} in seconds
    this.band = null;         // {a, b} highlighted time window (frame-trend measurement)
    // Double-pulse extraction overlay: {bands: [{a, b, label, color, traceId}], lines: [{t, label, color, dash, traceId}]}.
    // A line gets a dot on its trace and its label in the pane that holds trace `traceId` (else the top pane).
    // Marks without a colour take their trace's colour; marks of a hidden trace are not drawn.
    this.marks = null;
    this.hover = null;        // {x, y, t}
    this.drag = null;
    this.minPaneH = 110;
    this.M = { l: 76, r: 16, t: 8, b: 30, gap: 10 };
    this.dpr = window.devicePixelRatio || 1;
    this._raf = 0;
    this._out = new Float64Array(2);
    this.refreshTheme();
    this._bind();
  }

  // ---------------------------------------------------------------- public API

  setPanes(list) {
    const old = new Map(this.panes.map((p) => [p.key, p]));
    this.panes = list.map((p) => {
      const o = old.get(p.key);
      return { ...p, y0: o ? o.y0 : 0, y1: o ? o.y1 : 1, yAuto: o ? o.yAuto : true, rect: null };
    });
    this.resize();
  }

  get traces() { return this.panes.flatMap((p) => p.traces); }

  paneOf(tr) { return this.panes.find((p) => p.traces.includes(tr)) || null; }

  /**
   * What fitting trace `tr` to its pane needs, over the shown time span: the drawn range of the pane's other traces
   * (or of the pane when it has none) and the raw range of `tr`.  Null if the trace is flat or not shown.
   */
  levelRanges(tr) {
    const p = this.paneOf(tr), out = this._out;
    if (!p) return null;
    let lo = Infinity, hi = -Infinity;
    for (const o of p.traces) {
      if (o === tr || !o.visible) continue;
      const [a, b] = this._idx(o, this.x0, this.x1);
      if (this._mm(o, a, b, out)) { lo = Math.min(lo, out[0]); hi = Math.max(hi, out[1]); }
    }
    if (!(hi > lo)) { lo = p.y0; hi = p.y1; }
    const [a, b] = this._idx(tr, this.x0, this.x1);
    if (!tr.series.minMax(a, b, out) || !(out[1] > out[0])) return null;
    return { pane: p, lo, hi, rawLo: out[0], rawHi: out[1] };
  }

  /** Time extent of all visible traces including their shifts. */
  extent() {
    let lo = Infinity, hi = -Infinity;
    for (const tr of this.traces) {
      if (!tr.visible) continue;
      lo = Math.min(lo, tr.series.tstart + tr.shift);
      hi = Math.max(hi, tr.series.tend + tr.shift);
    }
    return hi > lo ? [lo, hi] : null;
  }

  fitX() {
    const e = this.extent();
    if (e) { this.x0 = e[0]; this.x1 = e[1]; }
    this.redraw(); this._viewChanged();
  }

  fitAll() {
    for (const p of this.panes) p.yAuto = true;
    this.fitX();
  }

  setView(x0, x1) {
    if (!(x1 > x0)) return;
    this.x0 = x0; this.x1 = x1;
    this.redraw(); this._viewChanged();
  }

  setCursors(on) {
    if (on && !this.cursors) {
      const w = this.x1 - this.x0;
      this.cursors = { a: this.x0 + w / 3, b: this.x0 + (2 * w) / 3 };
    } else if (!on) this.cursors = null;
    this.redraw();
    this.cb.onCursors && this.cb.onCursors(this.cursors);
  }

  refreshTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.theme = {
      bg: v('--plot-bg'), pane: v('--plot-pane'), grid: v('--plot-grid'), axis: v('--plot-axis'),
      text: v('--plot-text'), muted: v('--plot-muted'), hover: v('--plot-hover'),
      curA: v('--cursor-a'), curB: v('--cursor-b'), box: v('--accent'),
      font: '11px ' + (v('--mono') || 'monospace'),
    };
    this.redraw();
  }

  resize() {
    const host = this.cv.parentElement;
    const cssW = host.clientWidth;
    const n = Math.max(1, this.panes.length);
    const need = this.M.t + this.M.b + n * this.minPaneH + (n - 1) * this.M.gap;
    const cssH = Math.max(host.clientHeight, need);
    this.dpr = window.devicePixelRatio || 1;
    this.cv.style.width = cssW + 'px';
    this.cv.style.height = cssH + 'px';
    this.cv.width = Math.round(cssW * this.dpr);
    this.cv.height = Math.round(cssH * this.dpr);
    this.W = cssW; this.H = cssH;
    this._layout();
    this.redraw();
  }

  redraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  // ---------------------------------------------------------------- geometry

  _layout() {
    const { l, r, t, b, gap } = this.M;
    const n = this.panes.length;
    if (!n) return;
    const h = (this.H - t - b - gap * (n - 1)) / n;
    this.panes.forEach((p, i) => { p.rect = { x: l, y: t + i * (h + gap), w: this.W - l - r, h }; });
  }

  _plotRect() { return { x: this.M.l, w: this.W - this.M.l - this.M.r }; }
  t2x(t) { const r = this._plotRect(); return r.x + ((t - this.x0) / (this.x1 - this.x0)) * r.w; }
  x2t(x) { const r = this._plotRect(); return this.x0 + ((x - r.x) / r.w) * (this.x1 - this.x0); }
  v2y(p, v) { return p.rect.y + p.rect.h - ((v - p.y0) / (p.y1 - p.y0)) * p.rect.h; }
  y2v(p, y) { return p.y0 + ((p.rect.y + p.rect.h - y) / p.rect.h) * (p.y1 - p.y0); }

  _paneAt(y) {
    let best = null, bd = Infinity;
    for (const p of this.panes) {
      const d = y < p.rect.y ? p.rect.y - y : y > p.rect.y + p.rect.h ? y - p.rect.y - p.rect.h : 0;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /** Visible sample index range of a trace for [t0, t1]. */
  _idx(tr, t0, t1) {
    const s = tr.series;
    return [Math.floor((t0 - tr.shift - s.tstart) / s.tstep), Math.ceil((t1 - tr.shift - s.tstart) / s.tstep) + 1];
  }

  /** A trace's value as drawn: scaled and offset by its level settings (yGain, yOff); readouts use the raw value. */
  _lv(tr, v) { return v * (tr.yGain === undefined ? 1 : tr.yGain) + (tr.yOff || 0); }

  /** Drawn min/max of a trace over sample indices [a, b) into out[0..1]; false if empty. */
  _mm(tr, a, b, out) {
    if (!tr.series.minMax(a, b, out)) return false;
    const u = this._lv(tr, out[0]), w = this._lv(tr, out[1]);
    out[0] = Math.min(u, w); out[1] = Math.max(u, w);
    return true;
  }

  _autoY(p) {
    let lo = Infinity, hi = -Infinity;
    const out = this._out;
    for (const tr of p.traces) {
      if (!tr.visible) continue;
      const [a, b] = this._idx(tr, this.x0, this.x1);
      if (this._mm(tr, a, b, out)) { lo = Math.min(lo, out[0]); hi = Math.max(hi, out[1]); }
    }
    if (!(hi >= lo)) return;
    let pad = (hi - lo) * 0.06;
    if (pad === 0) pad = Math.abs(hi) * 0.1 || 1;
    p.y0 = lo - pad; p.y1 = hi + pad;
  }

  /** Nearest trace under (x, y) within `tol` px in pane p. */
  _hitTrace(p, x, y, tol = 6) {
    if (!p) return null;
    const out = this._out;
    let best = null, bd = tol;
    const tA = this.x2t(x - 3), tB = this.x2t(x + 3);
    for (const tr of p.traces) {
      if (!tr.visible) continue;
      let [a, b] = this._idx(tr, tA, tB);
      if (b - a < 2) b = a + 2;
      if (!this._mm(tr, a, b, out)) continue;
      const yt = this.v2y(p, out[1]), yb = this.v2y(p, out[0]);
      const d = y < yt ? yt - y : y > yb ? y - yb : 0;
      // On ties prefer what is drawn on top: the selected trace, else the later one.
      if (d < bd || (d === bd && (tr.selected || !(best && best.selected)))) { bd = d; best = tr; }
    }
    return best;
  }

  _hitCursor(x) {
    if (!this.cursors) return null;
    for (const k of ['a', 'b']) if (Math.abs(this.t2x(this.cursors[k]) - x) < 6) return k;
    return null;
  }

  // ---------------------------------------------------------------- drawing

  _draw() {
    const ctx = this.ctx, T = this.theme, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, this.W, this.H);
    if (!this.panes.length) return;
    ctx.font = T.font;
    const xt = Units.ticks(this.x0, this.x1, Math.max(2, Math.floor(this._plotRect().w / 110)));

    for (const p of this.panes) {
      if (p.yAuto) this._autoY(p);
      const r = p.rect;
      ctx.fillStyle = T.pane;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      if (this.band) this._drawBand(r);
      if (this.marks && p === this.panes[0]) this._markTraces = new Map(this.traces.map((t) => [t.id, t]));
      if (this.marks) this._drawMarkBands(p, p === this.panes[0]);

      // grid
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const t of xt.values) { const x = Math.round(this.t2x(t)) + 0.5; ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); }
      const yt = Units.ticks(p.y0, p.y1, Math.max(2, Math.floor(r.h / 34)));
      for (const v of yt.values) { const y = Math.round(this.v2y(p, v)) + 0.5; ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); }
      ctx.stroke();

      // y labels
      ctx.fillStyle = T.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (const v of yt.values) {
        const y = this.v2y(p, v);
        if (y > r.y + 4 && y < r.y + r.h - 4) ctx.fillText(Units.tickLabel(v, yt.step, p.unit), r.x - 6, y);
      }

      // traces
      ctx.save();
      ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
      const order = p.traces.filter((t) => t.visible).sort((a, b) => (a.selected ? 1 : 0) - (b.selected ? 1 : 0));
      for (const tr of order) this._drawTrace(p, tr);
      if (this.marks) this._drawMarkLines(p);
      ctx.restore();

      // frame + title
      ctx.strokeStyle = T.axis; ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      const title = p.unit ? `${p.title}  [${p.unit}]` : p.title;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const tw = ctx.measureText(title).width;
      ctx.fillStyle = T.pane; ctx.globalAlpha = 0.85;
      ctx.fillRect(r.x + 1, r.y + 1, tw + 12, 17);
      ctx.globalAlpha = 1; ctx.fillStyle = T.text;
      ctx.fillText(title, r.x + 6, r.y + 4);
      if (!p.yAuto) { ctx.fillStyle = T.muted; ctx.fillText('Y locked', r.x + tw + 18, r.y + 4); }
    }

    // x labels below the last pane
    const last = this.panes[this.panes.length - 1].rect;
    ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const t of xt.values) {
      const x = this.t2x(t);
      if (x > last.x + 20 && x < last.x + last.w - 20) ctx.fillText(Units.tickLabel(t, xt.step, 's'), x, last.y + last.h + 7);
    }

    const top = this.panes[0].rect.y, bottom = last.y + last.h;
    this._drawCursors(top, bottom);
    this._drawHover(top, bottom);
    this._drawDragOverlay();
  }

  _drawTrace(p, tr) {
    const ctx = this.ctx, s = tr.series, r = p.rect, dpr = this.dpr, out = this._out;
    const cols = Math.max(1, Math.round(r.w * dpr));
    const tPerCol = (this.x1 - this.x0) / cols;
    const spp = tPerCol / s.tstep;   // samples per device pixel
    ctx.strokeStyle = tr.color;
    ctx.fillStyle = tr.color;
    ctx.lineWidth = tr.selected ? 2 : 1;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (spp < 2) {
      let [a, b] = this._idx(tr, this.x0, this.x1);
      a = Math.max(0, a - 1); b = Math.min(s.n, b + 1);
      for (let i = a; i < b; i++) {
        const x = this.t2x(s.tstart + i * s.tstep + tr.shift), y = this.v2y(p, this._lv(tr, s.value(i)));
        if (i === a) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (spp < 0.12) {   // individual samples become visible: mark them
        const d = tr.selected ? 3 : 2.4;
        for (let i = a; i < b; i++) {
          ctx.fillRect(this.t2x(s.tstart + i * s.tstep + tr.shift) - d / 2, this.v2y(p, this._lv(tr, s.value(i))) - d / 2, d, d);
        }
      }
      return;
    }
    let started = false;
    const base = (this.x0 - tr.shift - s.tstart) / s.tstep;
    for (let c = 0; c < cols; c++) {
      const fa = base + c * spp;
      const lo = Math.floor(fa), hi = Math.floor(fa + spp) + 1;
      if (hi <= 0) continue;
      if (lo >= s.n) break;
      if (!this._mm(tr, lo, hi, out)) continue;
      const x = r.x + (c + 0.5) / dpr;
      const yTop = this.v2y(p, out[1]);
      let yBot = this.v2y(p, out[0]);
      if (yBot - yTop < 0.6) yBot = yTop + 0.6;
      if (!started) { ctx.moveTo(x, yTop); started = true; } else ctx.lineTo(x, yTop);
      ctx.lineTo(x, yBot);
    }
    ctx.stroke();
  }

  _drawBand(r) {
    const ctx = this.ctx;
    const xa = Math.max(r.x, Math.min(r.x + r.w, this.t2x(Math.min(this.band.a, this.band.b))));
    const xb = Math.max(r.x, Math.min(r.x + r.w, this.t2x(Math.max(this.band.a, this.band.b))));
    ctx.fillStyle = this.theme.box;
    ctx.globalAlpha = 0.1; ctx.fillRect(xa, r.y, xb - xa, r.h);
    ctx.globalAlpha = 0.6; ctx.fillRect(xa, r.y, 1, r.h); ctx.fillRect(xb - 1, r.y, 1, r.h);
    ctx.globalAlpha = 1;
  }

  /** Shaded integration windows; their labels stack up from the bottom of the top pane. */
  _drawMarkBands(p, labels) {
    const ctx = this.ctx, r = p.rect;
    const rows = [];
    ctx.font = this.theme.font; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    for (const b of this.marks.bands) {
      const tr = this._markTraces.get(b.traceId);
      if (tr && !tr.visible) continue;
      const xa = Math.max(r.x, Math.min(r.x + r.w, this.t2x(b.a)));
      const xb = Math.max(r.x, Math.min(r.x + r.w, this.t2x(b.b)));
      if (xb <= xa) continue;
      ctx.fillStyle = b.color || (tr ? tr.color : this.theme.muted);
      ctx.globalAlpha = 0.13; ctx.fillRect(xa, r.y, xb - xa, r.h);
      ctx.globalAlpha = 1;
      if (!labels || !b.label) continue;
      const w = ctx.measureText(b.label).width + 6, x = Math.min(xa + 3, r.x + r.w - w);
      let k = rows.findIndex((right) => x > right);
      if (k < 0) { k = rows.length; rows.push(0); }
      rows[k] = x + w;
      ctx.fillText(b.label, x, r.y + r.h - 3 - k * 14);
    }
  }

  /** Dashed marker lines; in the pane of each line's trace also a dot on the trace and a label. */
  _drawMarkLines(p) {
    const ctx = this.ctx, r = p.rect, T = this.theme;
    const labels = [];
    ctx.lineWidth = 1;
    for (const ln of this.marks.lines) {
      const tr = this._markTraces.get(ln.traceId);
      if (tr && !tr.visible) continue;
      const x = Math.round(this.t2x(ln.t)) + 0.5;
      if (x < r.x || x > r.x + r.w) continue;
      const color = ln.color || (tr ? tr.color : T.muted);
      ctx.strokeStyle = color; ctx.globalAlpha = 0.75; ctx.setLineDash(ln.dash || [4, 3]);
      ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
      ctx.globalAlpha = 1;
      if (tr ? !p.traces.includes(tr) : p !== this.panes[0]) continue;   // dot and label in the trace's own pane
      if (tr) {
        const v = tr.series.valueAt(ln.t - tr.shift);
        if (isFinite(v)) {
          ctx.fillStyle = color;
          ctx.beginPath(); ctx.arc(x, this.v2y(p, this._lv(tr, v)), 3.5, 0, 2 * Math.PI); ctx.fill();
        }
      }
      if (ln.label) labels.push({ x, text: ln.label, color });
    }
    ctx.setLineDash([]);
    // Stack labels in rows under the pane title so that neighbours do not overlap; when the pane has no row
    // left a label is dropped (its line and dot stay; zoom in to separate them).
    ctx.font = T.font; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    labels.sort((a, b) => a.x - b.x);
    const rows = [], maxRows = Math.max(1, Math.floor((r.h - 40) / 14));
    for (const lb of labels) {
      const w = ctx.measureText(lb.text).width + 6;
      const x = Math.min(lb.x + 3, r.x + r.w - w);
      let k = rows.findIndex((right) => x > right);
      if (k < 0) { if (rows.length >= maxRows) continue; k = rows.length; rows.push(0); }
      rows[k] = x + w + 4;
      const y = r.y + 22 + k * 14;
      ctx.fillStyle = T.pane; ctx.globalAlpha = 0.8; ctx.fillRect(x, y - 1, w, 14); ctx.globalAlpha = 1;
      ctx.fillStyle = lb.color; ctx.fillText(lb.text, x + 3, y);
    }
  }

  _drawCursors(top, bottom) {
    if (!this.cursors) return;
    const ctx = this.ctx, T = this.theme;
    for (const [k, col] of [['a', T.curA], ['b', T.curB]]) {
      const x = Math.round(this.t2x(this.cursors[k])) + 0.5;
      if (x < this.M.l || x > this.W - this.M.r) continue;
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillRect(x - 7, top, 14, 15);
      ctx.fillStyle = T.bg; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(k.toUpperCase(), x, top + 2);
    }
  }

  _drawHover(top, bottom) {
    const h = this.hover;
    if (!h || this.drag || h.x < this.M.l || h.x > this.W - this.M.r) return;
    const ctx = this.ctx, T = this.theme;
    const x = Math.round(h.x) + 0.5;
    ctx.strokeStyle = T.hover; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.setLineDash([]);
    const label = Units.fmt(h.t, 's', 6);
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = T.text; ctx.fillRect(x - w / 2, bottom + 3, w, 17);
    ctx.fillStyle = T.bg; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(label, x, bottom + 6);
  }

  _drawDragOverlay() {
    const d = this.drag, ctx = this.ctx, T = this.theme;
    if (!d) return;
    if (d.type === 'box') {
      const x = Math.min(d.sx, d.cx), y = Math.min(d.sy, d.cy);
      ctx.strokeStyle = T.box; ctx.fillStyle = T.box; ctx.lineWidth = 1;
      ctx.globalAlpha = 0.12; ctx.fillRect(x, y, Math.abs(d.cx - d.sx), Math.abs(d.cy - d.sy));
      ctx.globalAlpha = 1; ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(d.cx - d.sx), Math.abs(d.cy - d.sy));
    } else if (d.type === 'shift' && d.axis) {
      const u = d.pane.unit || '';
      const txt = d.axis === 'y'
        ? `Δ ${d.totalY >= 0 ? '+' : ''}${Units.fmt(d.totalY, u, 4)}   (offset ${Units.fmt(d.trace.yOff || 0, u, 5)})`
        : `Δt ${d.total >= 0 ? '+' : ''}${Units.fmt(d.total, 's', 5)}   (shift ${Units.fmt(d.trace.shift, 's', 6)})`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      const w = ctx.measureText(txt).width + 12;
      const x = Math.min(d.cx + 12, this.W - w - 4), y = Math.max(d.cy - 10, 20);
      ctx.fillStyle = d.trace.color; ctx.fillRect(x, y - 18, w, 18);
      ctx.fillStyle = T.bg; ctx.fillText(txt, x + 6, y - 4);
    }
  }

  // ---------------------------------------------------------------- interaction

  _viewChanged() { this.cb.onView && this.cb.onView(this.x0, this.x1); }

  _pos(e) { const b = this.cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }

  _bind() {
    const cv = this.cv;
    cv.addEventListener('pointerdown', (e) => this._down(e));
    cv.addEventListener('pointermove', (e) => this._move(e));
    cv.addEventListener('pointerup', (e) => this._up(e));
    cv.addEventListener('pointercancel', () => { this.drag = null; this.redraw(); });
    cv.addEventListener('pointerleave', () => {
      if (!this.drag) { this.hover = null; this.redraw(); this.cb.onHover && this.cb.onHover(null); }
    });
    cv.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    cv.addEventListener('dblclick', () => this.fitAll());
    new ResizeObserver(() => this.resize()).observe(cv.parentElement);
    window.addEventListener('resize', () => this.resize());
  }

  _down(e) {
    if (e.button !== 0 || !this.panes.length) return;
    const { x, y } = this._pos(e);
    const p = this._paneAt(y);
    cv: {
      const cur = this._hitCursor(x);
      if (cur) { this.drag = { type: 'cursor', which: cur }; break cv; }
      if (x < this.M.l) { this.drag = { type: 'ypan', pane: p, sy: y, y0: p.y0, y1: p.y1 }; break cv; }
      if (this.mode === 'zoom' || e.shiftKey) { this.drag = { type: 'box', pane: p, sx: x, sy: y, cx: x, cy: y }; break cv; }
      const hit = this._hitTrace(p, x, y);
      if (hit) {
        // The drag direction is decided by the first few pixels: sideways shifts time, up/down moves the level.
        this.drag = { type: 'shift', trace: hit, pane: p, axis: null, sx: x, sy: y, lastX: x, lastY: y, total: 0, totalY: 0, cx: x, cy: y };
        this.cb.onSelect && this.cb.onSelect(hit);
        this.cb.onShiftStart && this.cb.onShiftStart(hit);
        break cv;
      }
      this.drag = { type: 'pan', sx: x, sy: y, x0: this.x0, x1: this.x1, pane: p, y0: p.y0, y1: p.y1 };
    }
    this.cv.setPointerCapture(e.pointerId);
    this._updateCursorStyle(x, y);
    this.redraw();
  }

  _move(e) {
    const { x, y } = this._pos(e);
    const d = this.drag;
    const w = this._plotRect().w;
    if (!d) {
      this.hover = { x, y, t: this.x2t(x) };
      this._updateCursorStyle(x, y);
      this.redraw();
      this.cb.onHover && this.cb.onHover(x >= this.M.l && x <= this.W - this.M.r ? this.hover.t : null);
      return;
    }
    if (d.type === 'pan') {
      const dt = ((x - d.sx) / w) * (d.x1 - d.x0);
      this.x0 = d.x0 - dt; this.x1 = d.x1 - dt;
      if (!d.pane.yAuto) {
        const dv = ((y - d.sy) / d.pane.rect.h) * (d.y1 - d.y0);
        d.pane.y0 = d.y0 + dv; d.pane.y1 = d.y1 + dv;
      }
      this._viewChanged();
    } else if (d.type === 'ypan') {
      const dv = ((y - d.sy) / d.pane.rect.h) * (d.y1 - d.y0);
      d.pane.yAuto = false; d.pane.y0 = d.y0 + dv; d.pane.y1 = d.y1 + dv;
    } else if (d.type === 'box') {
      d.cx = x; d.cy = y;
    } else if (d.type === 'shift') {
      d.cx = x; d.cy = y;
      if (!d.axis) {
        const ax = Math.abs(x - d.sx), ay = Math.abs(y - d.sy);
        if (Math.max(ax, ay) < 4) return;
        d.axis = ay > 1.5 * ax ? 'y' : 'x';
        if (d.axis === 'y') d.pane.yAuto = false;   // keep the axis still while the waveform moves on it
        this._updateCursorStyle(x, y);
      }
      if (d.axis === 'x') {
        const dt = ((x - d.lastX) / w) * (this.x1 - this.x0);
        d.lastX = x;
        if (dt !== 0) { d.total += dt; this.cb.onShiftDrag && this.cb.onShiftDrag(d.trace, dt); }
      } else {
        const dv = -((y - d.lastY) / d.pane.rect.h) * (d.pane.y1 - d.pane.y0);
        d.lastY = y;
        if (dv !== 0) { d.totalY += dv; this.cb.onLevelDrag && this.cb.onLevelDrag(d.trace, dv); }
      }
    } else if (d.type === 'cursor') {
      this.cursors[d.which] = this.x2t(x);
      this.cb.onCursors && this.cb.onCursors(this.cursors);
    }
    this.redraw();
  }

  _up(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.type === 'box') {
      const p = d.pane;
      if (Math.abs(d.cx - d.sx) > 5) {
        const a = this.x2t(Math.min(d.sx, d.cx)), b = this.x2t(Math.max(d.sx, d.cx));
        this.x0 = a; this.x1 = b; this._viewChanged();
      }
      if (Math.abs(d.cy - d.sy) > 5) {
        p.yAuto = false;
        const a = this.y2v(p, Math.max(d.sy, d.cy)), b = this.y2v(p, Math.min(d.sy, d.cy));
        p.y0 = a; p.y1 = b;
      }
    }
    if (d.type === 'shift' && d.axis === 'y') this.cb.onLevelEnd && this.cb.onLevelEnd(d.trace, d.totalY);
    else if (d.type === 'shift') this.cb.onShiftEnd && this.cb.onShiftEnd(d.trace, d.total);
    this.redraw();
  }

  _wheel(e) {
    if (!this.panes.length) return;
    e.preventDefault();
    const { x, y } = this._pos(e);
    const delta = e.deltaY || e.deltaX;
    const k = Math.exp(Math.max(-1, Math.min(1, delta * (e.deltaMode ? 0.05 : 0.0015))));
    const sel = e.altKey && this.traces.find((t) => t.selected && t.visible);
    if (sel) {
      // Alt+wheel: scale the selected waveform about the level under the mouse (its pane's axis stays still)
      const p = this.paneOf(sel);
      const v = y >= p.rect.y && y <= p.rect.y + p.rect.h ? this.y2v(p, y) : (p.y0 + p.y1) / 2;
      p.yAuto = false;
      this.cb.onLevelScale && this.cb.onLevelScale(sel, 1 / k, v);
    } else if (e.shiftKey || x < this.M.l) {
      const p = this._paneAt(y);
      const v = this.y2v(p, y);
      p.yAuto = false;
      p.y0 = v - (v - p.y0) * k; p.y1 = v + (p.y1 - v) * k;
    } else {
      const t = this.x2t(Math.max(this.M.l, Math.min(this.W - this.M.r, x)));
      this.x0 = t - (t - this.x0) * k; this.x1 = t + (this.x1 - t) * k;
      this._viewChanged();
    }
    this.redraw();
  }

  _updateCursorStyle(x, y) {
    let c = 'crosshair';
    const d = this.drag;
    if (d) c = d.type === 'pan' || d.type === 'ypan' ? 'grabbing' : d.type === 'box' ? 'crosshair' : d.type === 'shift' && !d.axis ? 'move' : d.axis === 'y' ? 'ns-resize' : 'ew-resize';
    else if (this._hitCursor(x)) c = 'ew-resize';
    else if (x < this.M.l) c = 'ns-resize';
    else if (this.mode !== 'zoom' && this._hitTrace(this._paneAt(y), x, y)) c = 'move';
    else if (this.mode !== 'zoom') c = 'grab';
    this.cv.style.cursor = c;
  }
}
