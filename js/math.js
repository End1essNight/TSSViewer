/*
 * Math-channel expressions, evaluated sample by sample over whole records.
 *
 *   Vd * Is            integ(Vd * Is)       diff(Is)            smooth(diff(Is), 2n)
 *   Vd / Is            [VGO_LS] - 2.5       abs(Ig) * 1k        t   (time in seconds)
 *
 * Channel names are bare identifiers, or [bracketed] / "quoted" when they contain other
 * characters. Numbers accept SI suffixes (2n, 10u, 1k). Operators: + - * / ^ ( ).
 */
'use strict';

const MathExpr = (() => {
  const SI = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9 };

  // ---------------------------------------------------------------- units

  const MUL = { 'V·A': 'W', 'A·V': 'W', 'W·s': 'J', 's·W': 'J', 'A·s': 'C', 's·A': 'C', 'V·s': 'Wb', 's·V': 'Wb' };
  const DIV = { 'V/A': 'Ω', 'W/A': 'V', 'W/V': 'A', 'J/s': 'W', 'C/s': 'A', 'V/Ω': 'A', 'Wb/s': 'V' };
  const wrap = (u) => (/[·/]/.test(u) ? `(${u})` : u);

  function umul(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.endsWith(`/${b}`)) return a.slice(0, -b.length - 1);   // (V/s)·s -> V
    const k = `${a}·${b}`;
    return MUL[k] || `${wrap(a)}·${wrap(b)}`;
  }

  function udiv(a, b) {
    if (!b) return a;
    if (a === b) return '';
    const k = `${a}/${b}`;
    return DIV[k] || `${a ? wrap(a) : '1'}/${wrap(b)}`;
  }

  // ---------------------------------------------------------------- parsing

  function tokenize(src) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      const rest = src.slice(i);
      let m;
      if ((m = rest.match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i))) {
        let v = parseFloat(m[0]);
        i += m[0].length;
        const s = src[i];
        if (s && s in SI && !/[A-Za-z0-9_]/.test(src[i + 1] || '')) { v *= SI[s]; i++; }
        toks.push({ t: 'num', v });
      } else if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/))) {
        toks.push({ t: 'id', v: m[0] });
        i += m[0].length;
      } else if (c === '[' || c === '"') {
        const close = c === '[' ? ']' : '"';
        const j = src.indexOf(close, i + 1);
        if (j < 0) throw new Error(`Missing ${close}`);
        toks.push({ t: 'name', v: src.slice(i + 1, j) });
        i = j + 1;
      } else if ('+-*/^(),×÷·−'.includes(c)) {
        toks.push({ t: 'op', v: { '×': '*', '·': '*', '÷': '/', '−': '-' }[c] || c });
        i++;
      } else {
        throw new Error(`Unexpected character "${c}"`);
      }
    }
    return toks;
  }

  function parse(src) {
    const toks = tokenize(String(src));
    if (!toks.length) throw new Error('Expression is empty');
    let p = 0;
    const peek = () => toks[p];
    const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
    const expect = (v) => { if (!isOp(v)) throw new Error(`Expected "${v}"`); p++; };

    function expr() {
      let a = term();
      while (isOp('+') || isOp('-')) { const op = toks[p++].v; a = { type: 'bin', op, a, b: term() }; }
      return a;
    }
    function term() {
      let a = unary();
      while (isOp('*') || isOp('/')) { const op = toks[p++].v; a = { type: 'bin', op, a, b: unary() }; }
      return a;
    }
    function unary() {
      if (isOp('-')) { p++; return { type: 'neg', a: unary() }; }
      if (isOp('+')) { p++; return unary(); }
      return power();
    }
    function power() {
      const a = primary();
      if (isOp('^')) { p++; return { type: 'bin', op: '^', a, b: unary() }; }
      return a;
    }
    function primary() {
      const tk = toks[p++];
      if (!tk) throw new Error('Unexpected end of expression');
      if (tk.t === 'num') return { type: 'num', v: tk.v };
      if (tk.t === 'name') return { type: 'var', name: tk.v };
      if (tk.t === 'id') {
        if (isOp('(')) {
          const fn = FUNCS[tk.v.toLowerCase()];
          if (!fn) throw new Error(`Unknown function "${tk.v}"`);
          p++;
          const args = [];
          if (!isOp(')')) { args.push(expr()); while (isOp(',')) { p++; args.push(expr()); } }
          expect(')');
          if (args.length < fn.min || args.length > fn.max) throw new Error(`${tk.v}() takes ${fn.min === fn.max ? fn.min : `${fn.min}-${fn.max}`} argument(s)`);
          return { type: 'call', fn: tk.v.toLowerCase(), args };
        }
        return { type: 'var', name: tk.v };
      }
      if (tk.t === 'op' && tk.v === '(') { const e = expr(); expect(')'); return e; }
      throw new Error(`Unexpected "${tk.v}"`);
    }

    const ast = expr();
    if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}"`);
    return ast;
  }

  /** Names of all channels referenced by an expression (excluding the time variable t). */
  function refs(ast, out = new Set()) {
    if (ast.type === 'var') { if (ast.name !== 't') out.add(ast.name); }
    else if (ast.type === 'bin') { refs(ast.a, out); refs(ast.b, out); }
    else if (ast.type === 'neg') refs(ast.a, out);
    else if (ast.type === 'call') ast.args.forEach((a) => refs(a, out));
    return out;
  }

  // ---------------------------------------------------------------- evaluation

  // A value is {v: number | Float32Array, u: unit string}.
  let N = 0, DT = 1;

  function lift1(x, f) {
    if (typeof x === 'number') return f(x);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = f(x[i]);
    return out;
  }

  function lift2(x, y, f) {
    const xs = typeof x === 'number', ys = typeof y === 'number';
    if (xs && ys) return f(x, y);
    const out = new Float32Array(N);
    if (xs) for (let i = 0; i < N; i++) out[i] = f(x, y[i]);
    else if (ys) for (let i = 0; i < N; i++) out[i] = f(x[i], y);
    else for (let i = 0; i < N; i++) out[i] = f(x[i], y[i]);
    return out;
  }

  const toArray = (x) => (typeof x === 'number' ? new Float32Array(N).fill(x) : x);

  const FUNCS = {
    integ: {
      min: 1, max: 1, help: 'cumulative integral over time from the start of the record (trapezoid)',
      f: ([x]) => {
        const a = toArray(x.v), out = new Float32Array(N);
        let acc = 0;
        for (let i = 1; i < N; i++) {
          const s = a[i - 1] + a[i];
          if (s === s) acc += s * 0.5 * DT;   // skip NaN (outside a shifted record)
          out[i] = acc;
        }
        return { v: out, u: umul(x.u, 's') };
      },
    },
    diff: {
      min: 1, max: 1, help: 'time derivative (central difference)',
      f: ([x]) => {
        if (typeof x.v === 'number') return { v: 0, u: udiv(x.u, 's') };
        const a = x.v, out = new Float32Array(N);
        if (N > 1) {
          out[0] = (a[1] - a[0]) / DT;
          out[N - 1] = (a[N - 1] - a[N - 2]) / DT;
          for (let i = 1; i < N - 1; i++) out[i] = (a[i + 1] - a[i - 1]) / (2 * DT);
        }
        return { v: out, u: udiv(x.u, 's') };
      },
    },
    smooth: {
      min: 2, max: 2, help: 'centred moving average; width in samples, or in seconds when < 1 (e.g. 2n)',
      f: ([x, w]) => {
        if (typeof x.v === 'number') return x;
        if (typeof w.v !== 'number') throw new Error('smooth(): the width must be a number');
        let k = w.v < 1 ? Math.round(w.v / DT) : Math.round(w.v);
        k = Math.max(1, k);
        const a = x.v, out = new Float32Array(N), h = Math.floor(k / 2);
        let sum = 0, cnt = 0;
        // running sum over [i-h, i+h]
        for (let j = 0; j <= Math.min(h, N - 1); j++) { if (a[j] === a[j]) { sum += a[j]; cnt++; } }
        for (let i = 0; i < N; i++) {
          out[i] = cnt ? sum / cnt : NaN;
          const add = i + h + 1, rem = i - h;
          if (add < N && a[add] === a[add]) { sum += a[add]; cnt++; }
          if (rem >= 0 && a[rem] === a[rem]) { sum -= a[rem]; cnt--; }
        }
        return { v: out, u: x.u };
      },
    },
    abs: { min: 1, max: 1, help: 'absolute value', f: ([x]) => ({ v: lift1(x.v, Math.abs), u: x.u }) },
    sqrt: { min: 1, max: 1, help: 'square root', f: ([x]) => ({ v: lift1(x.v, Math.sqrt), u: x.u ? `√${wrap(x.u)}` : '' }) },
    exp: { min: 1, max: 1, help: 'e^x', f: ([x]) => ({ v: lift1(x.v, Math.exp), u: '' }) },
    ln: { min: 1, max: 1, help: 'natural log', f: ([x]) => ({ v: lift1(x.v, Math.log), u: '' }) },
    log10: { min: 1, max: 1, help: 'base-10 log', f: ([x]) => ({ v: lift1(x.v, Math.log10), u: '' }) },
    min: { min: 2, max: 2, help: 'element-wise minimum', f: ([x, y]) => ({ v: lift2(x.v, y.v, Math.min), u: x.u || y.u }) },
    max: { min: 2, max: 2, help: 'element-wise maximum', f: ([x, y]) => ({ v: lift2(x.v, y.v, Math.max), u: x.u || y.u }) },
  };

  function ev(node, get) {
    switch (node.type) {
      case 'num': return { v: node.v, u: '' };
      case 'var': return get(node.name);
      case 'neg': { const x = ev(node.a, get); return { v: lift1(x.v, (a) => -a), u: x.u }; }
      case 'call': return FUNCS[node.fn].f(node.args.map((a) => ev(a, get)));
      case 'bin': {
        const x = ev(node.a, get), y = ev(node.b, get);
        switch (node.op) {
          case '+': return { v: lift2(x.v, y.v, (a, b) => a + b), u: x.u || y.u };
          case '-': return { v: lift2(x.v, y.v, (a, b) => a - b), u: x.u || y.u };
          case '*': return { v: lift2(x.v, y.v, (a, b) => a * b), u: umul(x.u, y.u) };
          case '/': return { v: lift2(x.v, y.v, (a, b) => a / b), u: udiv(x.u, y.u) };
          case '^': {
            const u = !x.u ? '' : typeof y.v === 'number' ? (y.v === 2 ? `${wrap(x.u)}²` : `${wrap(x.u)}^${y.v}`) : '';
            return { v: lift2(x.v, y.v, Math.pow), u };
          }
        }
      }
    }
    throw new Error('Bad expression');
  }

  /**
   * Evaluate over a record of n samples spaced dt apart.
   * get(name) returns {v: Float32Array(n), u: unit} for a channel (or 't').
   * Returns {v: Float32Array(n), u}.
   */
  function evaluate(ast, n, dt, get) {
    N = n; DT = dt;
    const r = ev(ast, get);
    return { v: toArray(r.v), u: r.u };
  }

  /** Expression-safe reference to a channel name. */
  const ref = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== 't' ? name : `[${name}]`);

  return { parse, refs, evaluate, ref, umul, FUNCS };
})();
