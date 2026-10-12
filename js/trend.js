/*
 * Frame trends: reduce one frame of a channel to a single number over a time window (mean,
 * integral, min, …), and a small canvas chart that plots those numbers against the frame
 * number or the frame's trigger time, one stacked pane per measurement, one line per file.
 */
'use strict';

const Trend = (() => {
  const STATS = {
    mean: { label: 'Mean', unit: (u) => u },
    integ: { label: 'Integral', unit: (u) => MathExpr.umul(u, 's') },
    rms: { label: 'RMS', unit: (u) => u },
    min: { label: 'Min', unit: (u) => u },
    max: { label: 'Max', unit: (u) => u },
    pp: { label: 'Peak-peak', unit: (u) => u },
    at: { label: 'Value at', unit: (u) => u },
  };

  /**
   * Measure Series s over [a, b] (in the series' own, unshifted time). The waveform is treated
   * as piecewise linear, so window edges between samples are interpolated: mean is the time
   * average (integral / duration), not a plain sample average. NaN samples are skipped.
   */
  function measure(s, a, b, stat) {
    if (stat === 'at') return s.valueAt(a);
    if (b < a) [a, b] = [b, a];
    a = Math.max(a, s.tstart); b = Math.min(b, s.tend);
    if (!(b >= a)) return NaN;   // window outside the record
    const r = s.raw, k = s.scale, o = s.offset, dt = s.tstep, t0 = s.tstart;
    const i0 = Math.ceil((a - t0) / dt), i1 = Math.floor((b - t0) / dt);
    const va = s.valueAt(a), vb = s.valueAt(b);
    let lo = Infinity, hi = -Infinity, area = 0, area2 = 0, width = 0;
    let pt = a, pv = va;
    if (va === va) { lo = hi = va; }
    const visit = (t, v) => {
      if (v === v) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        if (pv === pv) {
          const w = t - pt;
          area += (v + pv) * 0.5 * w;
          area2 += (v * v + pv * pv) * 0.5 * w;
          width += w;
        }
      }
      pt = t; pv = v;
    };
    for (let i = Math.max(0, i0); i <= i1 && i < s.n; i++) visit(t0 + i * dt, r[i] * k + o);
    visit(b, vb);
    if (lo > hi) return NaN;
    switch (stat) {
      case 'mean': return width > 0 ? area / width : va;
      case 'integ': return area;
      case 'rms': return width > 0 ? Math.sqrt(area2 / width) : Math.abs(va);
      case 'min': return lo;
      case 'max': return hi;
      case 'pp': return hi - lo;
    }
    return NaN;
  }

  /** Index of the value in xs nearest to x. */
  function nearest(xs, x) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < xs.length; i++) { const d = Math.abs(xs[i] - x); if (d < bd) { bd = d; best = i; } }
    return best;
  }

  return { STATS, measure, nearest };
})();

/*
 * Pane: {title, unit, series: [{name, color, xs, ys}]}. xUnit '' means frame numbers (integer
 * ticks), 's' means trigger time. Callbacks: onHover(x | null), onPick(series, index, event).
 */
class TrendChart {
  constructor(canvas, cb = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = cb;
    this.panes = [];
    this.xUnit = '';
    this.x0 = 0; this.x1 = 1;
    this.hoverX = null;
    this.empty = '';
    this.minPaneH = 90;
    this.M = { l: 76, r: 16, t: 8, b: 28, gap: 10 };
    this.dpr = window.devicePixelRatio || 1;
    this._raf = 0;
    this.refreshTheme();
    this._bind();
  }

  setData(panes, xUnit, empty = '') {
    this.panes = panes.map((p) => ({ ...p, y0: 0, y1: 1, rect: null }));
    this.xUnit = xUnit;
    this.empty = empty;
    this._ranges();
    this.resize();
  }

  refreshTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.theme = {
      bg: v('--plot-bg'), pane: v('--plot-pane'), grid: v('--plot-grid'), axis: v('--plot-axis'),
      text: v('--plot-text'), muted: v('--plot-muted'), hover: v('--plot-hover'),
      font: '11px ' + (v('--mono') || 'monospace'),
    };
    this.redraw();
  }

  resize() {
    const host = this.cv.parentElement;
    const n = Math.max(1, this.panes.length);
    const cssW = host.clientWidth;
    const cssH = Math.max(host.clientHeight, this.M.t + this.M.b + n * this.minPaneH + (n - 1) * this.M.gap);
    this.dpr = window.devicePixelRatio || 1;
    this.cv.style.width = cssW + 'px';
    this.cv.style.height = cssH + 'px';
    this.cv.width = Math.round(cssW * this.dpr);
    this.cv.height = Math.round(cssH * this.dpr);
    this.W = cssW; this.H = cssH;
    const { l, r, t, b, gap } = this.M;
    const h = (cssH - t - b - gap * (n - 1)) / n;
    this.panes.forEach((p, i) => { p.rect = { x: l, y: t + i * (h + gap), w: cssW - l - r, h }; });
    this.redraw();
  }

  redraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _ranges() {
    let lo = Infinity, hi = -Infinity;
    for (const p of this.panes) {
      let ylo = Infinity, yhi = -Infinity;
      for (const s of p.series) {
        for (let i = 0; i < s.xs.length; i++) {
          const x = s.xs[i], y = s.ys[i];
          if (x < lo) lo = x;
          if (x > hi) hi = x;
          if (y < ylo) ylo = y;
          if (y > yhi) yhi = y;
        }
      }
      if (!(yhi >= ylo)) { ylo = 0; yhi = 1; }
      let pad = (yhi - ylo) * 0.08;
      if (pad === 0) pad = Math.abs(yhi) * 0.1 || 1;
      p.y0 = ylo - pad; p.y1 = yhi + pad;
    }
    if (!(hi >= lo)) { lo = 0; hi = 1; }
    const pad = this.xUnit ? (hi - lo) * 0.02 || 1e-6 : 0.5;
    this.x0 = lo - pad; this.x1 = hi + pad;
  }

  t2x(x) { return this.M.l + ((x - this.x0) / (this.x1 - this.x0)) * (this.W - this.M.l - this.M.r); }
  x2t(px) { return this.x0 + ((px - this.M.l) / (this.W - this.M.l - this.M.r)) * (this.x1 - this.x0); }
  v2y(p, v) { return p.rect.y + p.rect.h - ((v - p.y0) / (p.y1 - p.y0)) * p.rect.h; }

  /** Hover position snapped to whole frames when the x axis is the frame number. */
  _snap(x) { return this.xUnit ? x : Math.round(x); }

  _xTicks() {
    const w = this.W - this.M.l - this.M.r;
    const xt = Units.ticks(this.x0, this.x1, Math.max(2, Math.floor(w / 90)));
    if (this.xUnit || xt.step >= 1) return xt;
    const values = [];
    for (let v = Math.ceil(this.x0); v <= this.x1; v++) values.push(v);
    return { step: 1, values };
  }

  _draw() {
    const ctx = this.ctx, T = this.theme;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.font = T.font;
    if (!this.panes.length) {
      ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(this.empty, this.W / 2, this.H / 2);
      return;
    }
    const xt = this._xTicks();
    const hx = this.hoverX == null ? null : this._snap(this.hoverX);

    for (const p of this.panes) {
      const r = p.rect;
      ctx.fillStyle = T.pane;
      ctx.fillRect(r.x, r.y, r.w, r.h);

      ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const t of xt.values) { const x = Math.round(this.t2x(t)) + 0.5; ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); }
      const yt = Units.ticks(p.y0, p.y1, Math.max(2, Math.floor(r.h / 30)));
      for (const v of yt.values) { const y = Math.round(this.v2y(p, v)) + 0.5; ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); }
      ctx.stroke();

      ctx.fillStyle = T.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (const v of yt.values) {
        const y = this.v2y(p, v);
        if (y > r.y + 4 && y < r.y + r.h - 4) ctx.fillText(Units.tickLabel(v, yt.step, p.unit), r.x - 6, y);
      }

      ctx.save();
      ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
      for (const s of p.series) this._drawSeries(p, s, hx);
      ctx.restore();

      ctx.strokeStyle = T.axis; ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      const title = p.unit ? `${p.title}  [${p.unit}]` : p.title;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const tw = ctx.measureText(title).width;
      ctx.fillStyle = T.pane; ctx.globalAlpha = 0.85;
      ctx.fillRect(r.x + 1, r.y + 1, tw + 12, 17);
      ctx.globalAlpha = 1; ctx.fillStyle = T.text;
      ctx.fillText(title, r.x + 6, r.y + 4);
    }

    const last = this.panes[this.panes.length - 1].rect;
    ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const t of xt.values) {
      const x = this.t2x(t);
      if (x > last.x + 10 && x < last.x + last.w - 10) ctx.fillText(this.xUnit ? Units.tickLabel(t, xt.step, 's') : String(t), x, last.y + last.h + 7);
    }

    if (hx != null) {
      const x = Math.round(this.t2x(hx)) + 0.5;
      ctx.strokeStyle = T.hover; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, this.panes[0].rect.y); ctx.lineTo(x, last.y + last.h); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  _drawSeries(p, s, hx) {
    const ctx = this.ctx, n = s.xs.length;
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const y = s.ys[i];
      if (!isFinite(y)) { pen = false; continue; }
      const x = this.t2x(s.xs[i]), py = this.v2y(p, y);
      if (pen) ctx.lineTo(x, py); else { ctx.moveTo(x, py); pen = true; }
    }
    ctx.stroke();
    const w = this.W - this.M.l - this.M.r;
    if (n <= w / 4) {
      for (let i = 0; i < n; i++) {
        if (!isFinite(s.ys[i])) continue;
        ctx.beginPath(); ctx.arc(this.t2x(s.xs[i]), this.v2y(p, s.ys[i]), 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (hx != null) {
      const i = Trend.nearest(s.xs, hx);
      if (i >= 0 && isFinite(s.ys[i])) {
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(this.t2x(s.xs[i]), this.v2y(p, s.ys[i]), 5, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  _pos(e) { const b = this.cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }

  /** Point nearest (x, y) within `tol` px: {series, index}, or null. */
  _hit(x, y, tol = 10) {
    let best = null, bd = tol * tol;
    for (const p of this.panes) {
      if (y < p.rect.y - tol || y > p.rect.y + p.rect.h + tol) continue;
      for (const s of p.series) {
        for (let i = 0; i < s.xs.length; i++) {
          if (!isFinite(s.ys[i])) continue;
          const dx = this.t2x(s.xs[i]) - x, dy = this.v2y(p, s.ys[i]) - y, d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = { series: s, index: i }; }
        }
      }
    }
    return best;
  }

  _bind() {
    const cv = this.cv;
    cv.addEventListener('pointermove', (e) => {
      if (!this.panes.length) return;
      const { x, y } = this._pos(e);
      const inside = x >= this.M.l && x <= this.W - this.M.r;
      this.hoverX = inside ? this.x2t(x) : null;
      cv.style.cursor = this._hit(x, y) ? 'pointer' : 'crosshair';
      this.redraw();
      this.cb.onHover && this.cb.onHover(this.hoverX == null ? null : this._snap(this.hoverX));
    });
    cv.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.redraw();
      this.cb.onHover && this.cb.onHover(null);
    });
    cv.addEventListener('click', (e) => {
      const { x, y } = this._pos(e);
      const hit = this._hit(x, y);
      if (hit && this.cb.onPick) this.cb.onPick(hit.series, hit.index, e);
    });
    new ResizeObserver(() => this.resize()).observe(cv.parentElement);
  }
}
