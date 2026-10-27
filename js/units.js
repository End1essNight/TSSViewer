/* SI-prefix formatting/parsing and axis tick helpers. */
'use strict';

const Units = (() => {
  const PREFIXES = [[1e-15, 'f'], [1e-12, 'p'], [1e-9, 'n'], [1e-6, 'µ'], [1e-3, 'm'], [1, ''], [1e3, 'k'], [1e6, 'M'], [1e9, 'G']];
  const FACTOR = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

  function prefixFor(a) {
    let p = PREFIXES[5];
    if (a === 0 || !isFinite(a)) return p;
    for (const q of PREFIXES) if (a >= q[0] * 0.99995) p = q;
    return p;
  }

  /** 12.3e-9, 's' -> "12.3 ns" */
  function fmt(v, unit = '', digits = 4) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    if (v === 0) return `0 ${unit}`.trim();
    const p = prefixFor(Math.abs(v));
    const x = v / p[0];
    digits = Math.max(digits, Math.floor(Math.log10(Math.abs(x))) + 1);   // never round away integer digits
    return `${+x.toPrecision(digits)} ${p[1]}${unit}`.trim();
  }

  /**
   * Parse a time such as "12.5n", "-3 us", "1e-9", "2ms", "40 samples".
   * Returns seconds, or NaN. Samples are converted with `tstep` when given.
   */
  function parseTime(str, tstep) {
    const s = String(str).trim().replace(/,/g, '.');
    if (s === '') return 0;
    const m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-zµμ]*)$/i);
    if (!m) return NaN;
    const num = parseFloat(m[1]);
    let suf = m[2];
    if (/^(sa|samp|samples?|pts?|points?)$/i.test(suf)) return tstep ? num * tstep : NaN;
    if (suf.length > 1 && /s$/i.test(suf)) suf = suf.slice(0, -1);          // "ns" -> "n"
    else if (suf.length === 1 && /s/i.test(suf)) suf = '';                  // "s"
    if (!(suf in FACTOR)) return NaN;
    return num * FACTOR[suf];
  }

  /** Parse a plain number with an optional SI prefix: "2", "-0.5", "1e-9", "10n", "2k". NaN if it is not one. */
  function parseNum(str) {
    const m = String(str).trim().replace(/,/g, '.').match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-zµμ]?)$/i);
    return m && m[2] in FACTOR ? parseFloat(m[1]) * FACTOR[m[2]] : NaN;
  }

  /** Round step for roughly `count` ticks across `range`. */
  function niceStep(range, count) {
    const raw = range / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const r = raw / mag;
    return (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * mag;
  }

  function ticks(lo, hi, count) {
    if (!(hi > lo)) return { step: 0, values: [] };
    const step = niceStep(hi - lo, count);
    const values = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
      values.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return { step, values };
  }

  /** Format tick labels so that adjacent ticks stay distinguishable. */
  function tickLabel(v, step, unit) {
    if (v === 0) return `0`;
    const digits = Math.min(10, Math.max(2, Math.ceil(Math.log10(Math.abs(v) / step) + 1e-9) + 1));
    return fmt(v, unit, digits);
  }

  return { fmt, parseTime, parseNum, ticks, tickLabel };
})();
