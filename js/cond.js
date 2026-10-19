/*
 * Test conditions: a JSON file saved next to a capture, e.g. Cfg20261007T114340.json for
 * Tek20261007T114340.tss. A JSON file belongs to a capture in the same folder when the names
 * match exactly, or when they match after dropping a leading alphabetic prefix ("Tek", "Cfg").
 */
'use strict';

const Cond = (() => {
  const stemOf = (name) => name.replace(/^.*\//, '').replace(/\.[^.]*$/, '').toLowerCase();
  /** "tek20261007t114340" -> "20261007t114340"; null when there is no prefix or too little is left. */
  const coreOf = (stem) => { const c = stem.replace(/^[a-z]+[_-]?/, ''); return c !== stem && c.length >= 4 ? c : null; };

  /** Nested objects become dotted keys; arrays are kept as JSON text. */
  function flatten(obj, prefix = '', out = {}) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
      else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
    }
    return out;
  }

  /** Parse JSON text into a flat {key: value} map; throws with a readable message. */
  function parse(text) {
    const obj = JSON.parse(text.replace(/^﻿/, ''));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not a JSON object');
    return flatten(obj);
  }

  /** Lookup keys for a JSON file: exact stem, plus the stem without its prefix. */
  function keysFor(dir, name) {
    const s = stemOf(name), c = coreOf(s);
    return { exact: `${dir}|${s}`, core: c ? `${dir}|~${c}` : null };
  }

  /** Index entries ({dir, name, ...}) so match() can find the one paired with a capture. */
  class Index {
    constructor() { this.map = new Map(); }
    add(entry) {
      const k = keysFor(entry.dir, entry.name);
      this.map.set(k.exact, entry);
      if (k.core) {
        // Two JSON files with the same core name are ambiguous: keep neither for core matching.
        const prev = this.map.get(k.core);
        this.map.set(k.core, prev && prev.name !== entry.name ? 'ambiguous' : entry);
      }
    }
    match(dir, name) {
      const k = keysFor(dir, name);
      const hit = this.map.get(k.exact) || (k.core && this.map.get(k.core));
      return hit && hit !== 'ambiguous' ? hit : null;
    }
    clear() { this.map.clear(); }
  }

  const text = (v) => (v === null || v === undefined ? '' : String(v));
  const sameValue = (a, b) => text(a).trim() === text(b).trim();

  /** Keys whose value is not the same in every condition map (missing counts as different). */
  function varying(maps) {
    const keys = [];
    for (const m of maps) for (const k of Object.keys(m)) if (!keys.includes(k)) keys.push(k);
    if (maps.length < 2) return [];
    return keys.filter((k) => maps.some((m) => !(k in m) || !sameValue(m[k], maps[0][k])));
  }

  /** Natural compare for condition values: numbers numerically, text naturally, blanks last. */
  function compare(a, b) {
    const sa = text(a).trim(), sb = text(b).trim();
    if (!sa || !sb) return sa ? -1 : sb ? 1 : 0;
    const na = Number(sa), nb = Number(sb);
    if (isFinite(na) && isFinite(nb)) return na - nb;
    return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
  }

  return { parse, Index, varying, compare, text };
})();
