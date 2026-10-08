/*
 * One frame of one channel: raw samples plus scaling and timing, with a lazily built
 * min/max pyramid so any time window can be reduced to per-pixel envelopes quickly.
 */
'use strict';

const BLOCK = 8;   // pyramid fan-out

class Series {
  constructor(raw, scale, offset, tstart, tstep) {
    this.raw = raw;
    this.scale = scale;
    this.offset = offset;
    this.tstart = tstart;
    this.tstep = tstep;
    this.n = raw.length;
    this.levels = null;   // [{size, min, max}] block sizes 8, 64, 512, ...
  }

  get tend() { return this.tstart + (this.n - 1) * this.tstep; }

  value(i) { return this.raw[i] * this.scale + this.offset; }

  _build() {
    this.levels = [];
    let src = null, srcLen = this.n, size = 1;
    while (srcLen > BLOCK * 4) {
      const m = Math.ceil(srcLen / BLOCK);
      const mn = new Float32Array(m), mx = new Float32Array(m);
      for (let b = 0; b < m; b++) {
        const s = b * BLOCK, e = Math.min(s + BLOCK, srcLen);
        let lo = Infinity, hi = -Infinity;
        if (!src) {
          const r = this.raw;
          for (let i = s; i < e; i++) { const v = r[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        } else {
          for (let i = s; i < e; i++) { if (src.min[i] < lo) lo = src.min[i]; if (src.max[i] > hi) hi = src.max[i]; }
        }
        mn[b] = lo; mx[b] = hi;
      }
      size *= BLOCK;
      src = { size, min: mn, max: mx };
      this.levels.push(src);
      srcLen = m;
    }
  }

  /** Raw-unit min/max over sample indices [lo, hi). Writes into out[0], out[1]. */
  _rawMinMax(lo, hi, out) {
    if (!this.levels) this._build();
    let mn = Infinity, mx = -Infinity;
    const stack = [lo, hi];
    while (stack.length) {
      const h = stack.pop(), l = stack.pop();
      if (h <= l) continue;
      let k = -1;
      for (let j = this.levels.length - 1; j >= 0; j--) {
        if (this.levels[j].size * 2 <= h - l) { k = j; break; }
      }
      if (k < 0) {
        const r = this.raw;
        for (let i = l; i < h; i++) { const v = r[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        continue;
      }
      const L = this.levels[k], b = L.size;
      const a = Math.ceil(l / b), z = Math.floor(h / b);
      for (let i = a; i < z; i++) { if (L.min[i] < mn) mn = L.min[i]; if (L.max[i] > mx) mx = L.max[i]; }
      stack.push(l, a * b, z * b, h);
    }
    out[0] = mn; out[1] = mx;
  }

  /** Scaled min/max over sample indices [lo, hi) (clamped). Returns false if empty. */
  minMax(lo, hi, out) {
    lo = Math.max(0, lo | 0); hi = Math.min(this.n, hi | 0);
    if (hi <= lo) return false;
    this._rawMinMax(lo, hi, out);
    const a = out[0] * this.scale + this.offset, b = out[1] * this.scale + this.offset;
    if (a <= b) { out[0] = a; out[1] = b; } else { out[0] = b; out[1] = a; }
    return true;
  }

  /** Linearly interpolated value at time t (unshifted), or NaN outside the record. */
  valueAt(t) {
    const f = (t - this.tstart) / this.tstep;
    if (f < 0 || f > this.n - 1) return NaN;
    const i = Math.floor(f), w = f - i;
    return i + 1 < this.n ? this.value(i) * (1 - w) + this.value(i + 1) * w : this.value(i);
  }
}
