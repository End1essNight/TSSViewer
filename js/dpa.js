/*
 * Config-free double-pulse (DP) waveform analysis, ported from double-pulse-analytics dpa/analysis.py
 * (algorithm version 3.5). Every constant is in physical time units; nothing needs tuning.
 *
 * 1. Events.  Vd is thresholded with hysteresis at 30 % / 70 % of the bus voltage, which finds the
 *    four switching events of a low-side double pulse test:
 *         F1  1st turn-on  (soft)        R1  1st turn-off (hard, at peak current)
 *         F2  2nd turn-on  (hard)        R2  2nd turn-off
 *    Glitches shorter than 20 ns are ignored, so ringing or probe noise cannot create fake edges.
 *
 * 2. Reference levels.  0 % / 100 % levels are medians of the steady plateaus around each event
 *    (pre-pulse, pulse-1 on-state, inter-pulse off-state, pulse-2 on-state), placed as fractions of the
 *    measured plateau lengths.  Ramping currents use a straight-line fit evaluated at the edge.
 *    Gate signals use their pulse-1 on-level for both pulses.
 *
 * 3. Threshold crossings.  Each X % crossing is searched outward from the Vd 50 % point of the event,
 *    so it is always the crossing closest to the switching event.  Signals are lightly smoothed with a
 *    Gaussian whose width is fixed in nanoseconds, so results do not depend on the scope sample rate.
 *
 * Input is one frame: {t0, tstep, n, raw: {vd, vg, is, ig, vgi}} with Float64Array values in V / A
 * (missing roles null). Times in results are seconds on that frame's time axis.
 */
'use strict';

const Dpa = (() => {
  const NS = 1e-9, US = 1e-6;
  const VERSION = '3.5';

  // Gaussian smoothing (sigma, ns) applied before searching for threshold crossings.
  const SMOOTH_NS = { vd: 0.3, is: 0.3, vg: 0.5, vgi: 2.0, ig: 1.0, vcl: 0.3 };
  const DERIV_SMOOTH_NS = 0.5;   // sigma used before taking dV/dt or dI/dt peaks
  const MIN_PULSE_NS = 20;       // state changes shorter than this are treated as glitches

  /** Signal roles the analysis uses, with the scope labels recognised for each (case-insensitive). */
  const ROLES = [
    { key: 'vd', name: 'Vd', unit: 'V', desc: 'Drain-source voltage of the low-side device (required)', aliases: ['Vd', 'Vds', 'Vmid'] },
    { key: 'vg', name: 'Vg', unit: 'V', desc: 'Gate voltage', aliases: ['Vg', 'Vgs', 'VgLS', 'Vg1_LS', 'Vg_LS', 'VGO_S1', 'VGO_LS'] },
    { key: 'is', name: 'Is', unit: 'A', desc: 'Source / drain current', aliases: ['Is', 'Ids', 'Id', 'IsR'] },
    { key: 'ig', name: 'Ig', unit: 'A', desc: 'Gate current', aliases: ['Ig'] },
    { key: 'vgi', name: 'Vgi', unit: 'V', desc: 'Internal gate voltage (optional, widens the gate-charge window)', aliases: ['Vgi'] },
  ];

  /** Parameter groups offered; `needs` are the roles a group cannot do without. */
  const PARAMETERS = {
    time: { label: 'Switching times', detail: 'tdon, tf, tdoff, tr', method: 'timing', needs: ['vd', 'vg'],
      columns: ['tdon (ns)', 'tf (ns)', 'tdoff (ns)', 'tr (ns)'] },
    energy: { label: 'Switching energy', detail: 'Eon, Eoff', method: 'energy', needs: ['vd', 'is'],
      columns: ['Eon (uJ)', 'Eoff (uJ)'] },
    Qg: { label: 'Gate charge', detail: 'Qgoff, Qgon', method: 'gateCharge', needs: ['vd', 'vg', 'ig'],
      columns: ['Qgoff (nC)', 'Qgon (nC)'] },
    dvdt: { label: 'dV/dt', detail: '10-90 % and peak', method: 'dvdt', needs: ['vd'],
      columns: ['dV/dt_on_90_10 (V/ns)', 'dV/dt_on_MAX (V/ns)', 'dV/dt_off_10_90 (V/ns)', 'dV/dt_off_MAX (V/ns)'] },
    didt: { label: 'dIs/dt', detail: '10-90 % and peak', method: 'didt', needs: ['vd', 'is'],
      columns: ['dIs/dt_on_90_10 (A/ns)', 'dIs/dt_on_MAX (A/ns)', 'dIs/dt_off_10_90 (A/ns)', 'dIs/dt_off_MAX (A/ns)'] },
    Vd_overshoot: { label: 'Vd overshoot', detail: 'turn-off peak', method: 'overshoot', needs: ['vd'],
      columns: ['Vd_overshoot (V)'] },
  };
  const DEFAULT_PARAMETERS = Object.keys(PARAMETERS);
  const CONDITIONS = ['Vdc (V)', 'Ioff (A)', 'Ion (A)'];

  /**
   * Adjustable thresholds of each parameter group.  Percentages are of the signal's 0 % -> 100 % swing at the
   * switching event (see levels()).  The defaults are the dpa v3.5 definitions; the result columns keep their
   * default names (e.g. "dV/dt_on_90_10") whatever the thresholds.
   */
  const SETTINGS = [
    { key: 'timeVgOn', group: 'time', label: 'Vg at turn-on (tdon starts)', def: 10 },
    { key: 'timeVgOff', group: 'time', label: 'Vg at turn-off (tdoff starts)', def: 90 },
    { key: 'timeVdHi', group: 'time', label: 'Vd upper level (tdon ends, tf starts; tr ends)', def: 90 },
    { key: 'timeVdLo', group: 'time', label: 'Vd lower level (tf ends; tdoff ends, tr starts)', def: 10 },
    { key: 'eonVd', group: 'energy', label: 'Eon starts at Vd …', def: 99 },
    { key: 'eonIs', group: 'energy', label: '… or at Is, whichever is earlier', def: 10 },
    { key: 'eonEndVd', group: 'energy', label: 'Eon ends at Vd', def: 1 },
    { key: 'eoffVd', group: 'energy', label: 'Eoff starts at Vd', def: 1 },
    { key: 'eoffEnd', group: 'energy', label: 'Eoff ends on', def: 'is', choices: [['is', 'Is'], ['vd', 'Vd']] },
    { key: 'eoffEndIs', group: 'energy', label: 'Eoff ends at Is', def: 0, when: ['eoffEnd', 'is'] },
    { key: 'eoffEndVd', group: 'energy', label: 'Eoff ends at Vd', def: 99, when: ['eoffEnd', 'vd'] },
    { key: 'qgOffVg', group: 'Qg', label: 'Qgoff starts at Vg', def: 99 },
    { key: 'qgOnVg', group: 'Qg', label: 'Qgon starts at Vg', def: 1 },
    { key: 'qgOffEnd', group: 'Qg', label: 'Qgoff lasts until Vg (and Vgi) fall to', def: 1 },
    { key: 'qgOnEnd', group: 'Qg', label: 'Qgon lasts until Vg (and Vgi) rise to', def: 99 },
    { key: 'qgIgBand', group: 'Qg', label: '… and Ig is back within this % of its peak', def: 5 },
    { key: 'dvdtHi', group: 'dvdt', label: 'Vd upper level', def: 90 },
    { key: 'dvdtLo', group: 'dvdt', label: 'Vd lower level', def: 10 },
    { key: 'didtHi', group: 'didt', label: 'Is upper level', def: 90 },
    { key: 'didtLo', group: 'didt', label: 'Is lower level', def: 10 },
    { key: 'ovStart', group: 'Vd_overshoot', label: 'Search for the peak from Vd', def: 90 },
    { key: 'ovWindow', group: 'Vd_overshoot', label: '… for this long', def: 1000, unit: 'ns', min: 1, max: 1e6 },
  ];
  const DEFAULT_SETTINGS = Object.fromEntries(SETTINGS.map((s) => [s.key, s.def]));
  const ORDERED = [['timeVdLo', 'timeVdHi'], ['dvdtLo', 'dvdtHi'], ['didtLo', 'didtHi']];   // lower < upper

  /** Does a setting apply with these settings?  (E.g. the Is level of the Eoff end only when Eoff ends on Is.) */
  const settingActive = (s, opts) => !s.when || opts[s.when[0]] === s.when[1];

  /** Problems with a set of settings: {key: message}, empty when every value is usable. */
  function checkSettings(opts) {
    const bad = {};
    for (const s of SETTINGS) {
      if (s.choices) {
        if (!s.choices.some(([v]) => v === opts[s.key])) bad[s.key] = `must be one of ${s.choices.map(([v]) => v).join(', ')}`;
        continue;
      }
      const v = opts[s.key], min = s.min !== undefined ? s.min : 0, max = s.max !== undefined ? s.max : 100;
      if (typeof v !== 'number' || !isFinite(v) || v < min || v > max) bad[s.key] = `must be ${min} to ${max} ${s.unit || '%'}`;
    }
    for (const [lo, hi] of ORDERED) {
      if (bad[lo] || bad[hi] || opts[lo] < opts[hi]) continue;
      bad[lo] = 'must be below the upper level';
      bad[hi] = 'must be above the lower level';
    }
    return bad;
  }

  class AnalysisError extends Error {}
  const fail = (msg) => { throw new AnalysisError(msg); };

  // ================================================================ numpy / scipy equivalents

  /** Python's round(): half to even. */
  function pyRound(x) {
    const r = Math.round(x);
    return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  }

  const trunc = Math.trunc;

  /** scipy.ndimage.gaussian_filter1d(x, sigma) with its defaults: mode 'reflect', truncate 4. */
  function gaussian(x, sigma) {
    const n = x.length, r = trunc(4 * sigma + 0.5);
    const w = new Float64Array(r + 1);
    let sum = 0;
    for (let j = 0; j <= r; j++) { w[j] = Math.exp(-0.5 * (j * j) / (sigma * sigma)); sum += j ? 2 * w[j] : w[j]; }
    for (let j = 0; j <= r; j++) w[j] /= sum;
    const at = (k) => {   // 'reflect': d c b a | a b c d | d c b a
      while (k < 0 || k >= n) k = k < 0 ? -k - 1 : 2 * n - k - 1;
      return x[k];
    };
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = x[i] * w[0];
      if (i >= r && i + r < n) for (let j = 1; j <= r; j++) s += w[j] * (x[i + j] + x[i - j]);
      else for (let j = 1; j <= r; j++) s += w[j] * (at(i + j) + at(i - j));
      out[i] = s;
    }
    return out;
  }

  /** Median of x[a:b] (numpy: mean of the middle two for an even count; NaN when empty). */
  function median(x, a = 0, b = x.length) {
    a = Math.max(0, a); b = Math.min(x.length, b);
    if (b <= a) return NaN;
    const s = Float64Array.from(x.subarray ? x.subarray(a, b) : x.slice(a, b)).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }

  /** numpy.percentile with linear interpolation. */
  function percentile(arr, q) {
    const s = Float64Array.from(arr).sort();
    const pos = (q / 100) * (s.length - 1), i = Math.floor(pos);
    return i + 1 < s.length ? s[i] + (pos - i) * (s[i + 1] - s[i]) : s[i];
  }

  const maxOf = (x) => { let m = -Infinity; for (const v of x) if (v > m) m = v; return m; };
  const minOf = (x) => { let m = Infinity; for (const v of x) if (v < m) m = v; return m; };

  /** Index of the first max (or min) of x[a:b]. */
  function argExt(x, a, b, max) {
    let k = a;
    for (let i = a + 1; i < b; i++) if (max ? x[i] > x[k] : x[i] < x[k]) k = i;
    return k;
  }

  /** numpy.gradient(x[a:b], dt): central differences inside, one-sided at the ends of the slice. */
  function gradient(x, a, b, dt) {
    b = Math.min(b, x.length);
    const m = b - a;
    if (m < 2) fail('window too short for a derivative');
    const g = new Float64Array(m);
    g[0] = (x[a + 1] - x[a]) / dt;
    g[m - 1] = (x[b - 1] - x[b - 2]) / dt;
    for (let i = 1; i < m - 1; i++) g[i] = (x[a + i + 1] - x[a + i - 1]) / (2 * dt);
    return g;
  }

  /**
   * [[index, 'rise'|'fall'], ...] where x completes a loTh <-> hiTh transition.
   * Edges closer together than minLen form a burst (e.g. a 2.5x turn-off overshoot that rings back below
   * 30 % within a few ns).  A burst that ends in the new state is ONE transition, timed at its first edge;
   * a burst that returns to the old state is a glitch and is dropped.
   */
  function hysteresisEdges(x, loTh, hiTh, minLen, a = 0, b = x.length) {
    const raw = [];
    let prev = null;
    for (let i = a; i < b; i++) {
      const v = x[i];
      const s = v > hiTh ? true : v < loTh ? false : null;
      if (s === null) continue;
      if (prev !== null && s !== prev) raw.push([i - a, s ? 'rise' : 'fall']);
      prev = s;
    }
    const edges = [];
    let i = 0;
    while (i < raw.length) {
      let j = i + 1;
      while (j < raw.length && raw[j][0] - raw[j - 1][0] < minLen) j++;
      const first = raw[i], last = raw[j - 1];
      if (last[1] === first[1] && (!edges.length || edges[edges.length - 1][1] !== first[1])) edges.push(first);
      i = j;
    }
    return edges;
  }

  /** Lengths (in samples) of the runs where pred(x[i]) holds, for i in [a, b). */
  function runs(x, a, b, pred) {
    const out = [];
    let start = -1;
    b = Math.min(b, x.length);
    for (let i = a; i < b; i++) {
      if (pred(x[i])) { if (start < 0) start = i; } else if (start >= 0) { out.push([start - a, i - a]); start = -1; }
    }
    if (start >= 0) out.push([start - a, b - a]);
    return out;
  }

  // ================================================================ analysis of one capture

  class DoublePulse {
    constructor(sig, opts) {
      this.opt = { ...DEFAULT_SETTINGS, ...opts };
      this.t0 = sig.t0;
      this.step = sig.tstep;
      this.dt = (sig.t0 + sig.tstep) - sig.t0;   // numpy: t[1] - t[0]
      this.n = sig.n;
      this.raw = {};
      for (const r of ['vd', 'vg', 'is', 'ig', 'vgi']) this.raw[r] = sig.raw[r] || null;
      if (!this.raw.vd) fail('No Vd channel assigned');
      this._smoothed = new Map();
      this._levels = new Map();
      this._anchors = new Map();
      this.markers = {};   // group -> [{name, t, role}]
      this.windows = {};   // group -> [{name, ev, t0, t1, value, unit}] integration windows
      this.notes = [];     // [group, message] for values left empty although the group succeeded
      this._findEvents();
    }

    // ---------------------------------------------------------------- helpers
    t(i) { return this.t0 + this.step * i; }

    need(...roles) {
      const missing = roles.filter((r) => !this.raw[r]);
      if (missing.length) fail(`Missing channel(s): ${missing.map(roleName).join(', ')}`);
    }

    idx(t) { return Math.min(this.n - 1, Math.max(0, pyRound((t - this.t0) / this.dt))); }

    smooth(role, sigmaNs) {
      if (sigmaNs === undefined) sigmaNs = SMOOTH_NS[role] !== undefined ? SMOOTH_NS[role] : 0.3;
      const key = `${role}|${sigmaNs}`;
      if (!this._smoothed.has(key)) {
        this.need(role);
        const sigma = (sigmaNs * NS) / this.dt;
        this._smoothed.set(key, sigma >= 0.3 ? gaussian(this.raw[role], sigma) : this.raw[role]);
      }
      return this._smoothed.get(key);
    }

    _median(role, win) {
      const i0 = this.idx(win[0]), i1 = this.idx(win[1]);
      if (i1 - i0 < 5) fail(`Plateau too short to estimate ${roleName(role)} level`);
      return median(this.raw[role], i0, i1);
    }

    /**
     * Number of times Vd crosses its 50 % level (with +/-10 % hysteresis) within +/-span of the event.
     * A clean edge crosses once; more means the switching event oscillates or re-triggers.
     */
    _vdOscillation(ev, spanNs = 150) {
      const [lo, hi] = this.levels('vd', ev);
      const i = this.anchor('vd', ev);
      const w = trunc((spanNs * NS) / this.dt);
      // ringing dips back for a few ns only; the device turning back on keeps Vd in the old state for
      // tens of ns.  Count re-crossings only when the signal stays back for >= 10 ns.
      return hysteresisEdges(this.smooth('vd'), lo + 0.4 * (hi - lo), lo + 0.6 * (hi - lo), trunc((10 * NS) / this.dt),
        Math.max(0, i - w), Math.min(this.n, i + w)).length;
    }

    /** Note re-triggered edges; returns the set of events ('R1', 'F2') that re-triggered. */
    _checkEdges(group) {
      const bad = new Set();
      for (const [ev, name] of [['R1', 'turn-off'], ['F2', 'turn-on']]) {
        const k = this._vdOscillation(ev);
        if (k > 1) {
          bad.add(ev);
          this.notes.push([group, `Vd crosses 50 % ${k} times during ${name} (device switches back / re-triggers) - check the waveform`]);
        } else if (this._isRetrigger(ev)) {
          bad.add(ev);
          this.notes.push([group, `Is ${ev === 'R1' ? 'rises' : 'falls'} again for > 10 ns after the ${name} (device switches back / re-triggers) - check the waveform`]);
        }
      }
      return bad;
    }

    /** After the current edge, does Is go back past its 50 % level and stay there >= holdNs? */
    _isRetrigger(ev, spanNs = 150, holdNs = 10) {
      if (!this.raw.is) return false;
      let a, v50;
      try {
        a = this.anchor('is', ev);
        v50 = this.value('is', ev, 50);
      } catch (e) {
        if (e instanceof AnalysisError) return false;
        throw e;
      }
      const x = this.smooth('is');
      const back = ev === 'R1' ? (v) => v > v50 : (v) => v < v50;
      return runs(x, a + trunc((2 * NS) / this.dt), a + trunc((spanNs * NS) / this.dt), back)
        .some(([s, e]) => (e - s) * this.dt >= holdNs * NS);
    }

    /**
     * On-state level after the 2nd turn-on: the lowest sustained level (50 ns block medians) in pulse 2.
     * Normally Vd is flat there; if the device desaturates (Vd climbs while the current flows, e.g. over-current
     * limiting) a fixed window late in the pulse would put "0 %" far above the real on-state.
     */
    _on2Level(role) {
      const F2 = this.events.F2;
      const w2 = this.events.R2 !== null ? this.events.R2 - F2 : 1 * US;
      const a = this.idx(F2 + Math.min(20 * NS, 0.1 * w2)), b = this.idx(F2 + 0.75 * w2);
      if (b - a < 10) return this._median(role, this.win.on2);
      const blocks = this._blockMedians(this.raw[role].subarray(a, b));
      // the lowest plateau: blocks within 5 % of Vdc of the minimum (a short probe undershoot after
      // turn-on must not become the on-state level)
      const level = median(blocks.filter((v) => v <= minOf(blocks) + 0.05 * this.vbus));
      const late = maxOf(blocks.slice(blocks.length >> 1));
      if (role === 'vd' && late - level > 0.1 * this.vbus) {
        this.notes.push(['time', `device desaturates in pulse 2: Vd climbs from ${level.toFixed(0)} V to ${maxOf(blocks).toFixed(0)} V while on ` +
          '(over-current limiting?) - turn-on values may not be meaningful']);
      }
      return level;
    }

    /**
     * Median of the signal over the 100 ns before the 2nd turn-on's current starts to rise.  After turn-off 1
     * the bus voltage rings slowly (+/- ~10 V, several hundred ns period), so a level taken earlier in the gap
     * can sit on a peak or trough of that ringing.
     */
    _preTurnOnLevel(role) {
      const { R1, F2 } = this.events;
      let tRise = F2 - 50 * NS;
      if (this.raw.is) {
        const w = this.win;
        const lo = this._median('is', w.mid);
        const hi = this._lineAt('is', w.ramp2, F2);
        const x = this.smooth('is');
        try {
          [tRise] = this._cross(x, this.idx(F2), lo + 0.05 * (hi - lo), true, this.idx(R1 + 0.3 * (F2 - R1)), this.idx(F2) + 1);
        } catch (e) {
          if (!(e instanceof AnalysisError)) throw e;
        }
      }
      const a = Math.max(tRise - 100 * NS, R1 + 0.3 * (F2 - R1));
      return tRise - 5 * NS - a > 10 * NS ? this._median(role, [a, tRise - 5 * NS]) : this._median(role, this.win.mid_vd);
    }

    _blockMedians(x, blockNs = 50) {
      const blk = Math.max(1, trunc((blockNs * NS) / this.dt));
      const m = Math.floor(x.length / blk) * blk;
      if (!m) return [median(x)];
      const out = [];
      for (let i = 0; i < m; i += blk) out.push(median(x, i, i + blk));
      return out;
    }

    /**
     * Gate on-level: highest sustained level (50 ns block medians) during pulse 1.  A fixed window
     * can land on the turn-off of a slow gate (Rg of hundreds of ohms starts discharging microseconds early).
     */
    _gateOn(role) {
      const key = `on|${role}`;
      if (!this._levels.has(key)) {
        const a = this.idx(this.p1), b = this.idx(this.events.R1);
        if (b - a < 10) fail(`pulse 1 too short to find the ${roleName(role)} on-level`);
        const blocks = this._blockMedians(this.raw[role].subarray(a, b));
        const mid = 0.5 * (maxOf(blocks) + minOf(blocks));
        this._levels.set(key, percentile(blocks.filter((v) => v > mid), 75));   // the "on" part of pulse 1
      }
      return this._levels.get(key);
    }

    /**
     * Gate off-level: the driver's off rail, i.e. the level before pulse 1.  If pulse 1's start was not
     * captured: median of the samples between the pulses where the gate is really low (the gate can stay high
     * after Vd rises when the device is turned off by its own protection).
     */
    _gateOff(role) {
      const key = `off|${role}`;
      if (!this._levels.has(key) && this.win.pre) this._levels.set(key, this._median(role, this.win.pre));
      if (!this._levels.has(key)) {
        const x = this.raw[role];
        const thr = 0.5 * (percentile(x, 5) + this._gateOn(role));
        const low = [];
        for (let i = this.idx(this.events.R1); i < this.idx(this.events.F2); i++) if (x[i] < thr) low.push(x[i]);
        if (low.length * this.dt < 20 * NS) fail(`${roleName(role)} never turns off between the pulses`);
        this._levels.set(key, median(low));
      }
      return this._levels.get(key);
    }

    /** Least-squares straight line through the window, evaluated at tEval (for ramping currents). */
    _lineAt(role, win, tEval) {
      const i0 = this.idx(win[0]), i1 = this.idx(win[1]);
      if (i1 - i0 < 5) fail(`Plateau too short to estimate ${roleName(role)} level`);
      const step = Math.max(1, Math.floor((i1 - i0) / 20000));
      const y = this.raw[role];
      let n = 0, sx = 0, sy = 0;
      for (let i = i0; i < i1; i += step) { sx += this.t(i) - tEval; sy += y[i]; n++; }
      const mx = sx / n, my = sy / n;
      let sxx = 0, sxy = 0;
      for (let i = i0; i < i1; i += step) { const dx = this.t(i) - tEval - mx; sxx += dx * dx; sxy += dx * (y[i] - my); }
      return my - (sxy / sxx) * mx;
    }

    // ---------------------------------------------------------------- events
    _findEvents() {
      const vd = this.smooth('vd'), dt = this.dt;
      // bus voltage = the high Vd cluster.  (Not the median of the whole record: some captures start
      // inside pulse 1, so the device is on for most of the record.)
      // level reference: maximum of 50 ns block medians, so overshoot spikes and ringing do not count
      const vmax = maxOf(this._blockMedians(vd));
      let nHigh = 0;
      for (let i = 0; i < this.n; i++) if (vd[i] > 0.5 * vmax) nHigh++;
      if (vmax < 5.0 || nHigh * dt < 300 * NS) fail(`No bus voltage on Vd (max ${vmax.toFixed(1)} V) - capture without high voltage?`);
      const every = Math.max(1, Math.floor(nHigh / 200000)), high = [];
      for (let i = 0, k = 0; i < this.n; i++) if (vd[i] > 0.5 * vmax) { if (k % every === 0) high.push(vd[i]); k++; }
      const vbus = median(high);
      const edges = hysteresisEdges(vd, 0.3 * vbus, 0.7 * vbus, trunc((MIN_PULSE_NS * NS) / dt));
      if (!edges.length) fail('No Vd switching edges found');
      // record starts inside pulse 1: its turn-on was not captured
      const seq = edges[0][1] === 'rise' ? [null, ...edges.slice(0, 3)] : edges.slice(0, 4);
      const kinds = seq.map((e) => (e ? e[1] : 'fall'));
      if (kinds.slice(0, 3).join() !== 'fall,rise,fall') {
        if (kinds.slice(0, 2).join() === 'fall,rise') fail('No 2nd turn-on: Vd never falls in pulse 2 (device not switching / oscillating?)');
        fail(`Vd does not show a double-pulse pattern (found ${edges.slice(0, 4).map((e) => e[1]).join(', ')})`);
      }
      const F1 = seq[0] ? this.t(seq[0][0]) : null;
      const R1 = this.t(seq[1][0]), F2 = this.t(seq[2][0]);
      const R2 = seq.length > 3 && seq[3][1] === 'rise' ? this.t(seq[3][0]) : null;
      this.events = { F1, R1, F2, R2 };
      this.vbus = vbus;
      const p1 = F1 !== null ? F1 : this.t0;   // start of the captured part of pulse 1
      this.p1 = p1;

      const w1 = R1 - p1, gap = F2 - R1;
      const tend = this.t(this.n - 1);
      const w2 = R2 !== null ? R2 - F2 : Math.min(1 * US, tend - F2);
      const preLen = p1 - this.t0;
      this.win = {
        pre: F1 !== null ? [this.t0 + 0.1 * preLen, p1 - Math.min(1 * US, 0.2 * preLen)] : null,
        on1: [p1 + 0.35 * w1, p1 + 0.6 * w1],
        on1_end: [p1 + 0.6 * w1, R1 - Math.max(0.1 * w1, Math.min(0.3 * w1, 0.5 * US))],
        ramp1: [p1 + 0.4 * w1, p1 + 0.8 * w1],
        mid: [R1 + 0.4 * gap, F2 - 0.25 * gap],
        mid_vd: [R1 + 0.2 * gap, F2 - 0.25 * gap],   // long: the bus rings slowly after turn-off
        mid_g: [R1 + 0.3 * gap, F2 - 0.4 * gap],
        on2: [F2 + 0.4 * w2, F2 + 0.75 * w2],
        ramp2: [F2 + 0.3 * w2, F2 + 0.8 * w2],
        post: [Math.min(F2 + w2 + 0.3 * US, tend), Math.min(F2 + w2 + 2 * US, tend)],
      };
      // search limits for crossings belonging to each event
      this.bounds = {
        R1: [p1 + 0.05 * w1, F2 - 0.1 * gap],   // slow gates start turning off early in pulse 1
        F2: [R1 + 0.3 * gap, F2 + 0.9 * w2],
        R2: [F2 + 0.05 * w2, tend],             // slow gates start turning off early in pulse 2 too
      };
    }

    /** 0 % and 100 % reference levels for (role, event): returns [lo, hi, rising]. */
    levels(role, ev) {
      const key = `${role}|${ev}`;
      if (this._levels.has(key)) return this._levels.get(key);
      this.need(role);
      const w = this.win, e = this.events;
      if (ev === 'R2' && e.R2 === null) fail('2nd turn-off not captured');
      let a, b;
      if (role === 'vd' || role === 'vcl') {
        a = this._median(role, w[{ R1: 'on1_end', F2: 'mid_vd', R2: 'on2' }[ev]]);
        b = this._median(role, w[{ R1: 'mid_vd', F2: 'on2', R2: 'post' }[ev]]);
        if (ev === 'F2') {   // 100 % for turn-on = Vd just before the turn-on (bus ringing between pulses)
          a = this._preTurnOnLevel(role);
          b = this._on2Level(role);
        }
      } else if (role === 'is') {
        if (ev === 'R1') { a = this._lineAt(role, w.ramp1, e.R1); b = this._median(role, w.mid); }
        else if (ev === 'F2') { a = this._median(role, w.mid); b = this._lineAt(role, w.ramp2, e.F2); }
        else { a = this._lineAt(role, w.ramp2, e.R2); b = this._median(role, w.post); }
      } else {   // gate-like signals (vg, vgi)
        const on = this._gateOn(role);
        const off = ev === 'R1' || ev === 'F2' ? this._gateOff(role) : this._median(role, w.post);
        [a, b] = ev === 'R1' || ev === 'R2' ? [on, off] : [off, on];
      }
      // Vd rises at R1/R2; current and gate fall there.  Opposite at F2.
      const rising = b > a;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (!(hi - lo > 0)) fail(`${roleName(role)} shows no transition at ${ev}`);
      const out = [lo, hi, rising];
      this._levels.set(key, out);
      return out;
    }

    value(role, ev, pct) {
      const [lo, hi] = this.levels(role, ev);
      return lo + (pct / 100) * (hi - lo);
    }

    // ---------------------------------------------------------------- crossings
    /**
     * Crossing of level v nearest to index i0 for a transition in the given direction.
     * If x[i0] is already past v, walk backward to where it was last before v;
     * otherwise walk forward to where it first reaches v.  Returns [time, indexAfter].
     */
    _cross(x, i0, v, rising, iMin, iMax, forwardOnly = false) {
      const past = rising ? x[i0] >= v : x[i0] <= v;
      let j = -1;
      if (past && !forwardOnly) {
        for (let i = i0; i >= Math.max(0, iMin); i--) if (rising ? x[i] < v : x[i] > v) { j = i; break; }
        if (j < 0) fail('no crossing found before the edge');
      } else {
        const end = Math.min(iMax, x.length);
        for (let i = i0; i < end; i++) if (rising ? x[i] >= v : x[i] <= v) { j = i; break; }
        if (j < 0) fail('level not reached after the edge');
        j -= 1;
        if (j < i0) return [this.t(i0), i0];
      }
      if (j + 1 >= x.length) fail('crossing at the end of the record');
      const x0 = x[j], x1 = x[j + 1];
      const frac = x1 !== x0 ? (v - x0) / (x1 - x0) : 0;
      return [this.t(j) + frac * this.dt, j + 1];
    }

    /** Index of the signal's 50 % point for the event; gate signals use the Vd 50 % point. */
    anchor(role, ev) {
      const key = `${role}|${ev}`;
      if (this._anchors.has(key)) return this._anchors.get(key);
      const [b0, b1] = this.bounds[ev].map((b) => this.idx(b));
      const eIdx = this.idx(this.events[ev]);
      let a;
      if (role === 'vd' || role === 'vcl') {
        const x = this.smooth(role);
        const rising = this.levels(role, ev)[2];
        [, a] = this._cross(x, eIdx, this.value(role, ev, 50), rising, b0, b1);
      } else if (role === 'is') {
        const x = this.smooth('is');
        const rising = this.levels('is', ev)[2];
        // Start from Vd 10 %: at turn-on the device is fully on there, so walking back finds the
        // current rise that really led to conduction (not an aborted false start from gate bounce);
        // at turn-off the current has not yet fallen there, so walk forward to its fall.
        const start = this.idx(this.tcross('vd', ev, 10));
        const v50 = this.value('is', ev, 50);
        if (rising) {
          // the rise that led to conduction = the end of the last period Is was below 50 % for >= 10 ns
          // (ringing troughs after a capacitive / recovery spike last only a few ns)
          const long = runs(x, b0, start + 1, (v) => v < v50).filter(([s, e]) => (e - s) * this.dt >= 10 * NS);
          if (!long.length) fail('current never off before the 2nd turn-on');
          a = b0 + long[long.length - 1][1];
        } else {
          [, a] = this._cross(x, start, v50, rising, b0, b1, true);
        }
      } else {
        // gate-like: the signal's own 50 % crossing nearest the Vd edge (normally the gate edge just before it;
        // after a protection turn-off the gate only falls later - then that later fall)
        const x = this.smooth(role);
        const rising = this.levels(role, ev)[2];
        try {
          [, a] = this._cross(x, this.anchor('vd', ev), this.value(role, ev, 50), rising, b0, b1);
        } catch (e) {
          if (!(e instanceof AnalysisError)) throw e;
          a = this.anchor('vd', ev);
        }
      }
      this._anchors.set(key, a);
      return a;
    }

    /** Time (s) at which `role` crosses pct % of its lo->hi swing during event `ev`. */
    tcross(role, ev, pct) {
      const rising = this.levels(role, ev)[2];
      const [b0, b1] = this.bounds[ev].map((b) => this.idx(b));
      const v = this.value(role, ev, pct);
      const a = this.anchor(role, ev);
      const x = this.smooth(role);
      const past = rising ? x[a] >= v : x[a] <= v;
      if (!past && (role === 'vd' || role === 'is')) {
        // "first time the power signal reaches X %" is judged on the raw samples: light smoothing can lift
        // a dip that just touches the level (e.g. Is bouncing back after the fall).  Gate signals stay
        // smoothed - their slow asymptotes would let noise trigger early.
        return this._cross(this.raw[role], a, v, rising, b0, b1, true)[0];
      }
      const [t] = this._cross(x, a, v, rising, b0, b1);
      return this._refineOnRaw(role, t, v, rising);
    }

    /**
     * The smoothed signal locates the crossing robustly, but smoothing biases it on fast edges (the foot of
     * an edge is smeared, so a 10 % point appears early).  Take the exact time from the raw samples: the raw
     * crossing (same direction) nearest to the smoothed one, within +/-3 sigma of the smoothing.
     */
    _refineOnRaw(role, t, v, rising) {
      const x = this.raw[role];
      const sm = SMOOTH_NS[role] !== undefined ? SMOOTH_NS[role] : 0.3;
      const k = Math.max(2, trunc((3 * sm * NS) / this.dt));
      const i = this.idx(t);
      const a = Math.max(0, i - k), b = Math.min(x.length - 1, i + k + 1);
      let best = t, bd = Infinity;
      for (let c = a; c < b - 1; c++) {
        const up = rising ? x[c] < v && x[c + 1] >= v : x[c] > v && x[c + 1] <= v;
        if (!up) continue;
        const tc = this.t(c) + ((v - x[c]) / (x[c + 1] - x[c])) * this.dt;
        if (Math.abs(tc - t) < bd) { bd = Math.abs(tc - t); best = tc; }
      }
      return best;
    }

    // ---------------------------------------------------------------- integration
    /** Integral of y over [ta, tb] with exact (interpolated) end points; y(i) is the value at sample i. */
    integrate(y, ta, tb) {
      if (tb <= ta) fail('empty integration window');
      const ia = Math.max(this.idx(ta) - 1, 0), ib = Math.min(this.idx(tb) + 2, this.n);
      const at = (t) => {   // numpy.interp on the samples ia..ib-1
        const f = (t - this.t(ia)) / this.dt;
        if (f <= 0) return y(ia);
        if (f >= ib - 1 - ia) return y(ib - 1);
        const i = Math.floor(f), w = (t - this.t(ia + i)) / (this.t(ia + i + 1) - this.t(ia + i));
        return y(ia + i) + w * (y(ia + i + 1) - y(ia + i));
      };
      let sum = 0, pt = ta, py = at(ta);
      for (let i = ia; i < ib; i++) {
        const ti = this.t(i);
        if (ti <= ta || ti >= tb) continue;
        const yi = y(i);
        sum += 0.5 * (py + yi) * (ti - pt);
        pt = ti; py = yi;
      }
      return sum + 0.5 * (py + at(tb)) * (tb - pt);
    }

    /**
     * When the gate-current transient is over: last time the (1 ns smoothed) Ig is further from its steady
     * value than max(5 % of its largest excursion, 5 x noise).  The steady value and noise come from the last
     * 30 % of [tStart, tLimit].  Judged on the current, not the cumulative charge, so a small steady
     * supply / leakage current does not stretch the window.
     */
    _igSettleEnd(tStart, tLimit, frac = 0.05, tail = 0.3) {
      const x = this.smooth('ig');
      // stop 20 ns short of the limit: the limit is the start of the next gate edge, whose current
      // spike begins there and must not count as "still unsettled"
      const i0 = this.idx(tStart), i1 = this.idx(tLimit - 20 * NS);
      if (i1 - i0 < 50) fail('gate-charge window too short');
      const len = i1 - i0;
      const base = median(x, i0 + trunc((1 - tail) * len), i1);
      const absDev = [];
      for (let i = i0 + trunc((1 - tail) * len); i < i1; i++) absDev.push(Math.abs(x[i] - base));
      const noise = 1.4826 * median(absDev);
      const dev = new Float64Array(len);
      let dmax = -Infinity, kPeak = 0;
      for (let i = 0; i < len; i++) { dev[i] = Math.abs(x[i0 + i] - base); if (dev[i] > dmax) { dmax = dev[i]; kPeak = i; } }
      if (dmax < 10 * noise) fail('no gate-charge transient in Ig (gate-current probe not connected?)');
      // the transient is over at the FIRST time Ig stays within the band for 100 ns; later disturbances
      // (e.g. the device starting to desaturate near the end of the pulse) belong to other events
      const thr = Math.max(frac * dmax, 5 * noise);
      const hold = trunc((100 * NS) / this.dt);
      const out = [];
      for (let i = 0; i < len; i++) if (dev[i] > thr) out.push(i);
      let j = out[out.length - 1] + 1;
      for (let m = 0; m < out.length; m++) {
        const gap = (m + 1 < out.length ? out[m + 1] : len + hold) - out[m];
        if (gap > hold && out[m] >= kPeak) { j = out[m] + 1; break; }
      }
      return this.t(i0 + Math.min(j, len - 1));
    }

    /**
     * [iLow, i50]: from when the gate is really off after turn-off 1 to the FIRST 50 % point of the next rise.
     * If the gate bounces (false start), the crossing nearest the Vd edge is the restart; this finds the first.
     */
    _gateRiseWindow() {
      const x = this.smooth('vg');
      const v50 = this.value('vg', 'F2', 50);
      const i1 = this.idx(this.win.on2[0]);
      // look only after the turn-off ringing (30 % into the gap; at high current the gate can ring back above
      // 50 % right after turn-off), and only once the gate is really low
      const [, iLow] = this._cross(x, this.idx(this.win.mid_g[0]), v50, false, 0, i1, true);
      // ... and has stayed below 50 % for 20 ns (ringing right after the gate falls is not a new rise)
      const n = Math.max(2, trunc((20 * NS) / this.dt));
      const long = runs(x, iLow, i1, (v) => v < v50).filter(([s, e]) => e - s >= n);
      if (!long.length) fail('gate never stays off between the pulses');
      const i0 = iLow + long[0][0];
      const [, i50] = this._cross(x, i0, v50, true, i0, i1, true);
      return [i0, i50];
    }

    /**
     * Vg pct % point of the first gate rise of the 2nd turn-on.  0 % is the gate's resting level just before
     * it rises (an integrated driver can rest a few hundred mV above its pre-pulse level; a slow gate may still be
     * discharging).  If Vg never got that low, the edge starts where Vg turns upward (its minimum before the rise).
     */
    _firstGateRise(pct, group) {
      const x = this.smooth('vg');
      const [i0, i50] = this._gateRiseWindow();
      const [lo, hi] = this.levels('vg', 'F2');
      const rest = i50 > i0 ? median(x, i0, i50) : lo;
      const v = rest + (pct / 100) * (hi - rest);
      try {
        const [t] = this._cross(x, i50, v, true, i0, i50 + 1);
        return this._refineOnRaw('vg', t, v, true);
      } catch (e) {
        if (!(e instanceof AnalysisError)) throw e;
        if (i50 <= i0) fail('gate rise not found');
        const k = argExt(x, i0, i50, false);
        if (rest - lo > 0.1 * (hi - lo)) {   // only worth a note if the gate is really still charged
          this.notes.push([group, 'Vg had not discharged before pulse 2: turn-on edge taken from the Vg minimum before the rise']);
        }
        return this.t(k);
      }
    }

    /** Steepest slope of `role` between ta and tb: [slope per s, sample index]. */
    _peakSlope(role, ta, tb, sign) {
      const x = this.smooth(role, DERIV_SMOOTH_NS);
      let i0 = this.idx(ta), i1 = this.idx(tb);
      if (i1 < i0) [i0, i1] = [i1, i0];
      i1 = Math.max(i1, i0 + 2);
      const g = gradient(x, i0, i1, this.dt);
      const k = argExt(g, 0, g.length, sign > 0);
      return [g[k], i0 + k];
    }

    // ================================================================ parameters
    /** Test conditions: bus voltage and the load current at the hard edges (not a result group). */
    conditions() {
      const out = { 'Vdc (V)': this._median('vd', this.win.pre || this.win.mid) };
      if (this.raw.is) {
        out['Ioff (A)'] = this.levels('is', 'R1')[1];
        out['Ion (A)'] = this.levels('is', 'F2')[1];
      }
      return out;
    }

    timing() {
      this.need('vd', 'vg');
      const o = this.opt;
      let tgOn;
      try {
        tgOn = this.tcross('vg', 'F2', o.timeVgOn);
      } catch (e) {   // slow gate still discharging when pulse 2 starts
        if (!(e instanceof AnalysisError)) throw e;
        tgOn = this._firstGateRise(o.timeVgOn, 'time');
      }
      const tdHi = this.tcross('vd', 'F2', o.timeVdHi), tdLo = this.tcross('vd', 'F2', o.timeVdLo);
      const tgOff = this.tcross('vg', 'R1', o.timeVgOff);
      const trLo = this.tcross('vd', 'R1', o.timeVdLo), trHi = this.tcross('vd', 'R1', o.timeVdHi);
      this._checkEdges('time');
      let tdoff = (trLo - tgOff) / NS;
      if (tgOff > trLo) {   // Vd was already rising while the gate was still fully on
        this.notes.push(['time', 'tdoff: Vd rose before the gate turned off (device turned off by protection?)']);
        tdoff = NaN;
      }
      this.markers.time = [
        { name: `Vg ${o.timeVgOn}% (on)`, t: tgOn, role: 'vg' }, { name: `Vd ${o.timeVdHi}% (on)`, t: tdHi, role: 'vd' },
        { name: `Vd ${o.timeVdLo}% (on)`, t: tdLo, role: 'vd' }, { name: `Vg ${o.timeVgOff}% (off)`, t: tgOff, role: 'vg' },
        { name: `Vd ${o.timeVdLo}% (off)`, t: trLo, role: 'vd' }, { name: `Vd ${o.timeVdHi}% (off)`, t: trHi, role: 'vd' },
      ];
      return { 'tdon (ns)': (tdHi - tgOn) / NS, 'tf (ns)': (tdLo - tdHi) / NS, 'tdoff (ns)': tdoff, 'tr (ns)': (trHi - trLo) / NS };
    }

    energy() {
      this.need('vd', 'is');
      const o = this.opt, vd = this.raw.vd, is = this.raw.is;
      const p = (i) => vd[i] * is[i];
      // Eon starts at the earlier of Vd 99 % and Is 10 %: with a small loop inductance Vd hardly dips while the
      // current rises, so "Vd 99 %" alone comes after most of the current rise and misses its energy
      const on1 = Math.min(this.tcross('vd', 'F2', o.eonVd), this.tcross('is', 'F2', o.eonIs));
      const on2 = this.tcross('vd', 'F2', o.eonEndVd);
      const off1 = this.tcross('vd', 'R1', o.eoffVd);
      // end of turn-off: by default Is first falls to its off-state level (0 %) after its own 50 % point;
      // optionally when Vd has risen to a level (e.g. 99 %)
      let off2;
      if (o.eoffEnd === 'vd') off2 = this.tcross('vd', 'R1', o.eoffEndVd);
      else {
        const b1 = this.idx(this.bounds.R1[1]), a = this.anchor('is', 'R1');
        [off2] = this._cross(this.smooth('is'), a, this.value('is', 'R1', o.eoffEndIs), false, a, b1, true);
      }
      const bad = this._checkEdges('energy');
      const vd50 = this.tcross('vd', 'R1', 50);
      const eoffOk = off2 > vd50 && !bad.has('R1');
      const eonOk = !bad.has('F2');
      if (bad.has('R1')) this.notes.push(['energy', 'Eoff: turn-off happens more than once - one window cannot hold its energy']);
      if (bad.has('F2')) this.notes.push(['energy', 'Eon: turn-on happens more than once - one window cannot hold its energy']);
      else if (off2 <= vd50) {
        this.notes.push(['energy', o.eoffEnd === 'vd'
          ? 'Eoff: window ends before Vd is halfway up - raise the Vd level of the Eoff end'
          : 'Eoff: window does not contain the Vd rise (Is reached 0 before Vd was halfway up) - turn-off too distorted to integrate']);
      }
      const eon = eonOk ? this.integrate(p, on1, on2) / 1e-6 : NaN;
      const eoff = eoffOk ? this.integrate(p, off1, off2) / 1e-6 : NaN;
      this.markers.energy = [
        { name: `Eon start (Vd ${o.eonVd}% / Is ${o.eonIs}%)`, t: on1, role: 'vd' }, { name: `Eon end (Vd ${o.eonEndVd}%)`, t: on2, role: 'vd' },
        { name: `Eoff start (Vd ${o.eoffVd}%)`, t: off1, role: 'vd' }, o.eoffEnd === 'vd' ? { name: `Eoff end (Vd ${o.eoffEndVd}%)`, t: off2, role: 'vd' }
          : { name: o.eoffEndIs ? `Eoff end (Is ${o.eoffEndIs}%)` : 'Eoff end (Is=0)', t: off2, role: 'is' },
      ];
      this.windows.energy = [
        { name: 'Eon', ev: 'F2', t0: on1, t1: on2, value: eon, unit: 'µJ' },
        { name: 'Eoff', ev: 'R1', t0: off1, t1: off2, value: eoff, unit: 'µJ' },
      ];
      return { 'Eon (uJ)': eon, 'Eoff (uJ)': eoff };
    }

    /**
     * Gate charge = integral of the measured Ig over each gate transition.
     *
     * Window (default thresholds): from the start of the gate edge (Vg 99 % at turn-off; Vg 1 % of the FIRST gate
     * rise at turn-on) until the latest of
     *   - the gate edge being complete on Vg (1 % / 99 %) and, if present, on Vgi
     *     (if Vgi never gets there within the pulse, the window runs to the end of that pulse), and
     *   - the gate-current transient being over (Ig back within 5 % of its peak excursion of its steady value).
     */
    gateCharge() {
      this.need('vg', 'ig');
      const o = this.opt;
      const offStart = this.tcross('vg', 'R1', o.qgOffVg);
      const onStart = this._firstGateRise(o.qgOnVg, 'Qg');
      let onLimit = this.bounds.F2[1];
      if (this.events.R2 !== null) {
        try {   // the turn-on window ends at the latest where the gate's next turn-off window would start
          onLimit = this.tcross('vg', 'R2', o.qgOffVg);
        } catch (e) {   // gate never got back to that level in pulse 2: limit at its 50 % fall
          if (!(e instanceof AnalysisError)) throw e;
          onLimit = this.t(this.anchor('vg', 'R2'));
        }
      }
      // end of the gate-current transient
      const band = o.qgIgBand / 100;
      let offEnd = this._igSettleEnd(offStart, onStart, band), onEnd = this._igSettleEnd(onStart, onLimit, band);
      let offWhy = 'Ig settled', onWhy = 'Ig settled';
      // the window must cover the whole gate edge on Vg and Vgi
      for (const role of ['vg', 'vgi']) {
        if (!this.raw[role]) continue;
        const name = roleName(role);
        for (const [ev, pct, limit] of [['R1', o.qgOffEnd, onStart], ['F2', o.qgOnEnd, onLimit]]) {
          let tEdge, why;
          try {
            tEdge = Math.min(this.tcross(role, ev, pct), limit);
            why = `${name} ${pct}%`;
          } catch (e) {   // e.g. Vgi still rising when pulse 2 ends: take all of it
            if (!(e instanceof AnalysisError)) throw e;
            tEdge = limit;
            why = `${name} never reached ${pct}%: end of pulse`;
          }
          if (ev === 'R1' && tEdge > offEnd) { offEnd = tEdge; offWhy = why; }
          else if (ev === 'F2' && tEdge > onEnd) { onEnd = tEdge; onWhy = why; }
        }
      }
      const ig = this.raw.ig;
      const qoff = this.integrate((i) => ig[i], offStart, offEnd) / NS;
      const qon = this.integrate((i) => ig[i], onStart, onEnd) / NS;
      this.markers.Qg = [
        { name: `Qgoff start (Vg ${o.qgOffVg}%)`, t: offStart, role: 'vg' }, { name: `Qgoff end (${offWhy})`, t: offEnd, role: 'ig' },
        { name: `Qgon start (Vg ${o.qgOnVg}%)`, t: onStart, role: 'vg' }, { name: `Qgon end (${onWhy})`, t: onEnd, role: 'ig' },
      ];
      this.windows.Qg = [
        { name: 'Qgoff', ev: 'R1', t0: offStart, t1: offEnd, value: qoff, unit: 'nC' },
        { name: 'Qgon', ev: 'F2', t0: onStart, t1: onEnd, value: qon, unit: 'nC' },
      ];
      return { 'Qgoff (nC)': qoff, 'Qgon (nC)': qon };
    }

    dvdt() {
      this.need('vd');
      const { dvdtHi: hi, dvdtLo: lo } = this.opt;
      const onHi = this.tcross('vd', 'F2', hi), onLo = this.tcross('vd', 'F2', lo);
      const offLo = this.tcross('vd', 'R1', lo), offHi = this.tcross('vd', 'R1', hi);
      const [lOn, hOn] = this.levels('vd', 'F2'), [lOff, hOff] = this.levels('vd', 'R1');
      const k = (hi - lo) / 100, swOn = k * (hOn - lOn), swOff = k * (hOff - lOff);
      const [gOn, kOn] = this._peakSlope('vd', onHi, onLo, -1);
      const [gOff, kOff] = this._peakSlope('vd', offLo, offHi, +1);
      this.markers.dvdt = [
        { name: `Vd ${hi}% (on)`, t: onHi, role: 'vd' }, { name: `Vd ${lo}% (on)`, t: onLo, role: 'vd' }, { name: 'max dV/dt (on)', t: this.t(kOn), role: 'vd' },
        { name: `Vd ${lo}% (off)`, t: offLo, role: 'vd' }, { name: `Vd ${hi}% (off)`, t: offHi, role: 'vd' }, { name: 'max dV/dt (off)', t: this.t(kOff), role: 'vd' },
      ];
      return {
        'dV/dt_on_90_10 (V/ns)': (-swOn / (onLo - onHi)) * NS,
        'dV/dt_on_MAX (V/ns)': gOn * NS,
        'dV/dt_off_10_90 (V/ns)': (swOff / (offHi - offLo)) * NS,
        'dV/dt_off_MAX (V/ns)': gOff * NS,
      };
    }

    didt() {
      this.need('is');
      const { didtHi: hi, didtLo: lo } = this.opt;
      const onLo = this.tcross('is', 'F2', lo), onHi = this.tcross('is', 'F2', hi);
      const offHi = this.tcross('is', 'R1', hi), offLo = this.tcross('is', 'R1', lo);
      const [lOn, hOn] = this.levels('is', 'F2'), [lOff, hOff] = this.levels('is', 'R1');
      const k = (hi - lo) / 100, swOn = k * (hOn - lOn), swOff = k * (hOff - lOff);
      this._checkEdges('didt');
      const [gOn, kOn] = this._peakSlope('is', onLo, onHi, +1);
      const [gOff, kOff] = this._peakSlope('is', offHi, offLo, -1);
      this.markers.didt = [
        { name: `Is ${lo}% (on)`, t: onLo, role: 'is' }, { name: `Is ${hi}% (on)`, t: onHi, role: 'is' }, { name: 'max dIs/dt (on)', t: this.t(kOn), role: 'is' },
        { name: `Is ${hi}% (off)`, t: offHi, role: 'is' }, { name: `Is ${lo}% (off)`, t: offLo, role: 'is' }, { name: 'max dIs/dt (off)', t: this.t(kOff), role: 'is' },
      ];
      return {
        'dIs/dt_on_90_10 (A/ns)': (swOn / (onHi - onLo)) * NS,
        'dIs/dt_on_MAX (A/ns)': gOn * NS,
        'dIs/dt_off_10_90 (A/ns)': (-swOff / (offLo - offHi)) * NS,
        'dIs/dt_off_MAX (A/ns)': gOff * NS,
      };
    }

    overshoot() {
      this.need('vd');
      const t0 = this.tcross('vd', 'R1', this.opt.ovStart);
      const tEnd = Math.min(t0 + (this.opt.ovWindow / 1000) * US, this.win.mid[1]);
      const i0 = this.idx(t0), i1 = this.idx(tEnd);
      if (i1 <= i0) fail('no samples after the turn-off to find the overshoot in');
      const k = argExt(this.raw.vd, i0, i1, true);
      this.markers.Vd_overshoot = [{ name: 'Vd peak', t: this.t(k), role: 'vd' }];
      return { 'Vd_overshoot (V)': this.raw.vd[k] };
    }
  }

  const roleName = (key) => (ROLES.find((r) => r.key === key) || { name: key }).name;

  /** Role key -> channel label, guessed from the scope labels (case-insensitive). */
  function guessRoles(labels) {
    const out = {};
    for (const r of ROLES) {
      const al = r.aliases.map((a) => a.toLowerCase());
      const hit = labels.find((l) => al.includes(l.trim().toLowerCase()));
      if (hit) out[r.key] = hit;
    }
    return out;
  }

  /**
   * Run the selected parameter groups on one frame.
   * Returns {values, errors, conditions, dp}: values maps column -> number (NaN when a group failed),
   * errors maps group -> message, dp is the DoublePulse (events, markers, windows; null when the capture has no
   * usable Vd switching events).
   */
  function analyze(sig, groups = DEFAULT_PARAMETERS, opts = {}) {
    const values = {}, errors = {};
    let dp = null, dpError = null;
    try {
      dp = new DoublePulse(sig, opts);
    } catch (e) {   // no usable events: every group fails
      dpError = e.message || String(e);
      if (!(e instanceof AnalysisError)) console.error(e);
    }
    for (const g of groups) {
      const spec = PARAMETERS[g];
      if (!dp) {
        for (const c of spec.columns) values[c] = NaN;
        errors[g] = dpError;
        continue;
      }
      try {
        Object.assign(values, dp[spec.method]());
      } catch (e) {
        for (const c of spec.columns) if (!(c in values)) values[c] = NaN;
        errors[g] = e.message || String(e);
        if (!(e instanceof AnalysisError)) console.error(e);
      }
    }
    let conditions = {};
    if (dp) {
      try { conditions = dp.conditions(); } catch (_) { /* reported by the groups */ }
      for (const [g, msg] of dp.notes) errors[g] = g in errors ? `${errors[g]}; ${msg}` : msg;
    }
    return { values, errors, conditions, dp };
  }

  return { VERSION, ROLES, PARAMETERS, DEFAULT_PARAMETERS, CONDITIONS, SETTINGS, DEFAULT_SETTINGS, checkSettings, settingActive, AnalysisError, DoublePulse, analyze, guessRoles, roleName };
})();

if (typeof module !== 'undefined') module.exports = Dpa;
