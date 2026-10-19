/* TSS Viewer application: file handling, channel/frame selection, trace list and time shifts. */
'use strict';

(() => {
  const PALETTE = {
    dark: ['#f2c14e', '#4cc9f0', '#f15bb5', '#57cc99', '#b388ff', '#ff8c42', '#80ed99', '#ef476f', '#a0c4ff', '#e9ff70'],
    light: ['#c48a00', '#0a84c6', '#c2185b', '#2e9d63', '#7048e8', '#e8590c', '#0b7285', '#d6336c', '#495057', '#5c940d'],
  };
  const MAX_FRAME_BUTTONS = 500;
  const AUTO_LOAD_MAX = 6;

  const $ = (s, root = document) => root.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stem = (name) => name.replace(/\.tss$/i, '');
  const dirOf = (path) => { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); };

  const S = {
    files: [],              // file records in the file list, see addEntries()
    pool: [],               // captures found by Open folder but not picked yet (see the file picker)
    nextId: 1,
    corrections: new Map(), // folder path -> {oldLabel: newLabel}
    conds: new Cond.Index(), // test-condition JSON files, matched to captures by folder and name
    condVary: [],           // condition keys whose values differ between the listed files
    ts: new Map(),          // trace id -> {offset, visible, color}  (survives rebuilds)
    traces: [],
    byId: new Map(),
    selected: null,
    move: 'trace',
    groupBy: 'label',
    hoverT: null,
    fitted: false,
    maths: [],              // math channel definitions {id, name, expr, unit}, applied to every file
    nextMathId: 1,
  };

  const plot = new Plot($('#plot'), {
    onShiftDrag, onShiftEnd, onSelect,
    onHover: (t) => { S.hoverT = t; scheduleReadouts(); },
    onCursors: () => { renderCursorBox(); scheduleReadouts(); },
  });

  // ================================================================ helpers

  function isDark() {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }

  let statusTimer = 0;
  const DEFAULT_STATUS = $('#status').textContent;
  function status(msg, ms = 5000) {
    $('#status').textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { $('#status').textContent = DEFAULT_STATUS; }, ms);
  }

  const fmtShift = (v) => (v === 0 ? '0' : Units.fmt(v, 's', 7));

  /** "1-3, 7, 10-" -> Set of 0-based frame indices (null if unparsable). */
  function parseFrames(str, n) {
    const set = new Set();
    const parts = str.toLowerCase().replace(/\s*(-|:|\.\.)\s*/g, '-').split(/[\s,;]+/).filter(Boolean);
    for (const p of parts) {
      let m;
      if (p === 'all') for (let i = 0; i < n; i++) set.add(i);
      else if (/^\d+$/.test(p)) set.add(+p - 1);
      else if ((m = p.match(/^(\d*)-(\d*)$/))) {
        const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : n;
        for (let i = a; i <= b && i <= n; i++) set.add(i - 1);
      } else return null;
    }
    return new Set([...set].filter((i) => i >= 0 && i < n));
  }

  function fmtFrames(set) {
    const v = [...set].sort((a, b) => a - b).map((i) => i + 1);
    const out = [];
    for (let i = 0; i < v.length; i++) {
      let j = i;
      while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
      out.push(j > i ? `${v[i]}-${v[j]}` : `${v[i]}`);
      i = j;
    }
    return out.join(', ');
  }

  // ================================================================ files

  /**
   * items: [{file: File, path: 'folder/sub/name.tss'}]. With `pick` (Open folder) several captures
   * are not loaded straight away: they open in the file picker to be chosen by test conditions.
   */
  async function addEntries(items, pick = false) {
    const tss = [], txt = [], json = [];
    for (const it of items) {
      const n = it.file.name.toLowerCase();
      if (n.endsWith('.tss')) tss.push(it);
      else if (n === 'tss_corrections.txt') txt.push(it);
      else if (n.endsWith('.json')) json.push(it);
    }
    for (const it of txt) S.corrections.set(dirOf(it.path), Tss.parseCorrections(await it.file.text()));
    await Promise.all(json.map(readCond));
    if (!tss.length) {
      const n = attachConds();
      renderFiles();
      if (txt.length) status('Channel corrections loaded');
      else if (json.length) status(`Read ${json.length} JSON file${json.length > 1 ? 's' : ''}; ${n} listed capture${n === 1 ? ' has' : 's have'} test conditions`);
      else status('No .tss files found in the selection');
      return;
    }

    tss.sort((a, b) => Tss.natural(a.path, b.path));
    const added = [], known = allRecs();
    for (const it of tss) {
      const dup = known.some((f) => f.path === it.path && f.blob.size === it.file.size && f.blob.lastModified === it.file.lastModified);
      if (dup) continue;
      const rec = {
        id: S.nextId++, name: it.file.name, alias: stem(it.file.name), path: it.path, dir: dirOf(it.path),
        blob: it.file, cap: null, status: 'idle', error: null,
        offset: 0, selCh: new Set(), selFrames: new Set([0]), open: false, cond: null, condOpen: true,
      };
      added.push(rec);
    }
    if (pick && added.length > 1) {
      S.pool.push(...added);
      attachConds();
      const n = added.filter((r) => r.cond).length;
      status(`${added.length} captures found${n ? `, ${n} with test conditions` : ''}. Tick the ones to load.`, 8000);
      renderFiles();
      openPicker();
      return;
    }
    S.files.push(...added);
    attachConds();
    if (added.length > AUTO_LOAD_MAX) {
      const n = added.filter((r) => r.cond).length;
      status(`${added.length} files listed${n ? ` (${n} with test conditions)` : ''}. Click a file to load it.`, 8000);
    }
    renderFiles();
    rebuild();
    if (added.length <= AUTO_LOAD_MAX) for (const rec of added) await loadFile(rec);
  }

  /** Read one test-condition JSON file into the index; a bad file is kept with its error. */
  async function readCond(it) {
    const e = { name: it.file.name, path: it.path, dir: dirOf(it.path), values: null, error: null };
    try {
      if (it.file.size > 1e6) throw new Error('file is too large for a test-condition file');
      e.values = Cond.parse(await it.file.text());
    } catch (err) {
      e.error = err.message || String(err);
    }
    S.conds.add(e);
  }

  /** Pair every capture with its test-condition JSON. Returns how many listed files have one. */
  function attachConds() {
    for (const rec of allRecs()) rec.cond = S.conds.match(rec.dir, rec.name);
    S.condVary = Cond.varying(S.files.filter((f) => f.cond && f.cond.values).map((f) => f.cond.values));
    if (cdlg.open) renderCondTable();
    return S.files.filter((f) => f.cond).length;
  }

  async function loadFile(rec) {
    if (rec.status === 'loading' || rec.status === 'ready') return;
    rec.status = 'loading'; rec.open = true; rec.error = null;
    renderFiles();
    try {
      rec.cap = await Tss.open(rec.blob, S.corrections.get(rec.dir) || {});
      rec.status = 'ready';
      syncMath(rec);
      // Select the channels already being viewed in other files, so comparing is one click away.
      const labels = rec.cap.channels.map((c) => c.label);
      const wanted = new Set(S.files.filter((f) => f !== rec && f.status === 'ready').flatMap((f) => [...f.selCh]));
      const common = labels.filter((l) => wanted.has(l));
      rec.selCh = new Set(common.length ? common : labels);
    } catch (err) {
      rec.status = 'error';
      rec.error = err.message || String(err);
      console.error(err);
    }
    renderFiles();
    if (cdlg.open) renderCondTable();
    if (rec.status === 'ready') await ensureChannels(rec);
  }

  /** Decode every selected channel that has not been decoded yet, then redraw. */
  async function ensureChannels(rec) {
    const pending = rec.cap.channels.filter((c) => rec.selCh.has(c.label) && (!c.wfm || c.stale) && !(c.math && c.error));
    rebuild();
    if (!pending.length) return;
    // Real channels first (math channels may need them), then math channels.
    const load = (list) => Promise.all(list.map((ch) => loadCh(rec, ch).catch((e) => status(`${rec.alias} ${ch.label}: ${e.message}`, 8000))));
    await load(pending.filter((c) => !c.math));
    await load(pending.filter((c) => c.math));
    renderFiles();
    rebuild();
  }

  const loadCh = (rec, ch) => (ch.math ? computeMath(rec, ch) : rec.cap.loadChannel(ch));

  /** Close a file: it goes back to the picker's candidates, unloaded, so it can be picked again. */
  function removeFile(rec) {
    S.files = S.files.filter((f) => f !== rec);
    Object.assign(rec, { cap: null, status: 'idle', error: null, offset: 0, selCh: new Set(), selFrames: new Set([0]), open: false });
    S.pool.push(rec);
    S.pool.sort((a, b) => Tss.natural(a.path, b.path));
    attachConds();
    for (const id of [...S.ts.keys()]) if (id.startsWith(`${rec.id}|`)) S.ts.delete(id);
    if (S.selected && S.selected.startsWith(`${rec.id}|`)) S.selected = null;
    renderFiles();
    rebuild();
  }

  function seriesFor(ch, f) {
    ch.series = ch.series || [];
    const w = ch.wfm;
    return ch.series[f] || (ch.series[f] = new Series(w.frames[f], w.vscale, w.voffset, w.tstart, w.tstep));
  }

  // ================================================================ math channels
  //
  // Each definition in S.maths becomes a virtual channel {key: 'math-<id>', math: def} in every file
  // that has the channels it references, so it behaves like a real channel everywhere else.
  // Inputs are sampled on the file's time grid *including their own Δt shifts*, so deskewing Vd
  // against Is by dragging also deskews Vd*Is.

  const mathKey = (def) => `math-${def.id}`;

  /** Channel named in an expression: exact label, then case-insensitive label, then CHn. */
  function resolveIn(chans, name) {
    const lo = name.toLowerCase();
    return chans.find((c) => c.label === name) || chans.find((c) => c.label.toLowerCase() === lo) ||
      chans.find((c) => !c.math && c.key === lo) || null;
  }

  function tryParse(expr) { try { return MathExpr.parse(expr); } catch (_) { return null; } }

  /** Rebuild the virtual math channels of a file from S.maths. */
  function syncMath(rec) {
    if (rec.status !== 'ready') return;
    const real = rec.cap.channels.filter((c) => !c.math);
    const old = new Map(rec.cap.channels.filter((c) => c.math).map((c) => [c.key, c]));
    const names = new Set(S.maths.map((d) => d.name));
    const chans = [];
    for (const def of S.maths) {
      const ast = tryParse(def.expr);
      if (!ast) continue;
      const usable = [...MathExpr.refs(ast)].every((n) => resolveIn(real, n) || names.has(n));
      if (!usable) continue;
      let ch = old.get(mathKey(def));
      if (ch && ch.label !== def.name && rec.selCh.delete(ch.label)) rec.selCh.add(def.name);
      if (!ch || ch.math.expr !== def.expr || ch.math.unit !== def.unit) {
        ch = { key: mathKey(def), label: def.name, math: null, wfm: null, series: null, error: null, sig: null, loading: null, stale: false };
      }
      ch.label = def.name;
      ch.math = { ...def };
      chans.push(ch);
    }
    rec.cap.channels = real.concat(chans);
    for (const l of [...rec.selCh]) if (!rec.cap.channels.some((c) => c.label === l)) rec.selCh.delete(l);
  }

  function computeMath(rec, ch, stack = []) {
    if (stack.includes(ch.key)) return Promise.reject(new Error('circular reference between math channels'));
    if (ch.wfm && !ch.stale) return Promise.resolve(ch.wfm);
    if (!ch.loading) {
      ch.loading = doComputeMath(rec, ch, stack.concat(ch.key)).then(
        (w) => { ch.loading = null; return w; },
        (e) => { ch.loading = null; ch.error = e.message; ch.wfm = null; throw e; });
    }
    return ch.loading;
  }

  async function doComputeMath(rec, ch, stack) {
    ch.error = null;
    const ast = MathExpr.parse(ch.math.expr);
    const deps = new Map();
    for (const name of MathExpr.refs(ast)) {
      const d = resolveIn(rec.cap.channels, name);
      if (!d) throw new Error(`no channel "${name}" in this file`);
      if (d.math) await computeMath(rec, d, stack); else await rec.cap.loadChannel(d);
      deps.set(name, d);
    }
    const sig = mathSig(rec, ch);
    const info = rec.cap.info, n = info.samples, dt = info.tstep, t0 = info.tstart;
    let nF = info.frameCount;
    for (const d of deps.values()) nF = Math.min(nF, d.wfm.frameCount);
    const frames = [];
    let unit = '';
    for (let f = 0; f < nF; f++) {
      const cache = new Map();
      const get = (name) => {
        if (!cache.has(name)) {
          if (name === 't') {
            const v = new Float32Array(n);
            for (let i = 0; i < n; i++) v[i] = t0 + i * dt;
            cache.set(name, { v, u: 's' });
          } else {
            const d = deps.get(name);
            cache.set(name, { v: sampleOnGrid(rec, d, f, t0, dt, n), u: d.wfm.units });
          }
        }
        return cache.get(name);
      };
      const r = MathExpr.evaluate(ast, n, dt, get);
      frames.push(r.v);
      unit = r.u;
    }
    ch.wfm = { frames, vscale: 1, voffset: 0, tstart: t0, tstep: dt, samples: n, frameCount: nF, units: ch.math.unit || unit, frameTimes: info.frameTimes };
    ch.series = null;
    ch.sig = sig;
    ch.stale = false;
    return ch.wfm;
  }

  /** Values of channel d, frame f, on the grid t0 + i*dt, honouring the channel's own Δt shift. */
  function sampleOnGrid(rec, d, f, t0, dt, n) {
    const w = d.wfm, raw = w.frames[f];
    const st = S.ts.get(`${rec.id}|${d.key}|${f}`);
    const off = st ? st.offset : 0;
    if (off === 0 && raw.length === n && Math.abs(w.tstart - t0) < dt * 1e-6 && Math.abs(w.tstep - dt) < dt * 1e-9) {
      if (raw instanceof Float32Array && w.vscale === 1 && w.voffset === 0) return raw;
      const out = new Float32Array(n), s = w.vscale, o = w.voffset;
      for (let i = 0; i < n; i++) out[i] = raw[i] * s + o;
      return out;
    }
    const ser = seriesFor(d, f), out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = ser.valueAt(t0 + i * dt - off);
    return out;
  }

  /** Fingerprint of everything a math result depends on (expression and input shifts). */
  function mathSig(rec, ch, depth = 0) {
    const ast = tryParse(ch.math.expr);
    if (!ast || depth > 8) return '';
    const parts = [ch.math.expr];
    const nF = rec.cap.info.frameCount;
    for (const name of MathExpr.refs(ast)) {
      const d = resolveIn(rec.cap.channels, name);
      if (!d) continue;
      const offs = [];
      for (let f = 0; f < nF; f++) { const st = S.ts.get(`${rec.id}|${d.key}|${f}`); offs.push(st ? st.offset : 0); }
      parts.push(`${d.key}:${offs.join(',')}`);
      if (d.math) parts.push(`(${mathSig(rec, d, depth + 1)})`);
    }
    return parts.join('|');
  }

  /** After shifts change, recompute math results whose inputs moved (debounced). */
  let mathTimer = 0;
  function scheduleMathRefresh() {
    clearTimeout(mathTimer);
    mathTimer = setTimeout(async () => {
      if (plot.drag) { scheduleMathRefresh(); return; }   // wait until the drag is released
      for (const rec of S.files) {
        if (rec.status !== 'ready') continue;
        let changed = false;
        for (const ch of rec.cap.channels) {
          if (ch.math && ch.wfm && mathSig(rec, ch) !== ch.sig) { ch.stale = true; changed = true; }
        }
        if (changed) await ensureChannels(rec);
      }
    }, 250);
  }

  function saveMaths() {
    try { localStorage.setItem('tssviewer.math', JSON.stringify(S.maths.map(({ name, expr, unit }) => ({ name, expr, unit })))); } catch (_) { /* ignore */ }
  }

  function loadMaths() {
    try {
      const list = JSON.parse(localStorage.getItem('tssviewer.math') || '[]');
      S.maths = list.filter((d) => d && d.name && d.expr).map((d) => ({ id: S.nextMathId++, name: d.name, expr: d.expr, unit: d.unit || '' }));
    } catch (_) { /* ignore */ }
  }

  /** Re-apply S.maths to every file; `select` names a math channel to switch on everywhere. */
  function applyMaths(select) {
    const keys = new Set(S.maths.map(mathKey));
    for (const id of [...S.ts.keys()]) {
      const k = id.split('|')[1];
      if (k.startsWith('math-') && !keys.has(k)) S.ts.delete(id);
    }
    for (const rec of S.files) {
      if (rec.status !== 'ready') continue;
      syncMath(rec);
      if (select && rec.cap.channels.some((c) => c.label === select)) rec.selCh.add(select);
    }
    saveMaths();
    renderFiles();
    rebuild();
    for (const rec of S.files) if (rec.status === 'ready') ensureChannels(rec);
  }

  // ================================================================ traces

  function rebuild() {
    const traces = [];
    for (const rec of S.files) {
      if (rec.status !== 'ready') continue;
      const nF = rec.cap.info.frameCount;
      const frames = [...rec.selFrames].filter((f) => f < nF).sort((a, b) => a - b);
      for (const ch of rec.cap.channels) {
        if (!rec.selCh.has(ch.label) || !ch.wfm) continue;
        for (const f of frames) {
          if (f >= ch.wfm.frameCount) continue;
          const id = `${rec.id}|${ch.key}|${f}`;
          let st = S.ts.get(id);
          if (!st) S.ts.set(id, (st = { offset: 0, visible: true, color: null }));
          traces.push({
            id, rec, ch, frame: f, nFrames: nF, st, series: seriesFor(ch, f), unit: ch.wfm.units,
            visible: st.visible, shift: rec.offset + st.offset, selected: id === S.selected, color: '', name: '',
          });
        }
      }
    }

    const panes = new Map();
    for (const t of traces) {
      let key, title;
      switch (S.groupBy) {
        case 'file': key = `f${t.rec.id}`; title = t.rec.alias; break;
        case 'frame': key = `fr${t.frame}`; title = `Frame ${t.frame + 1}`; break;
        case 'single': key = 'all'; title = 'All waveforms'; break;
        default: key = `l${t.ch.label.toLowerCase()}`; title = t.ch.label;
      }
      if (!panes.has(key)) panes.set(key, { key, title, unit: t.unit, traces: [] });
      const p = panes.get(key);
      if (p.unit !== t.unit) p.unit = '';
      p.traces.push(t);
    }

    const pal = PALETTE[isDark() ? 'dark' : 'light'];
    for (const p of panes.values()) {
      p.traces.forEach((t, i) => { t.color = t.st.color || pal[i % pal.length]; t.name = traceName(t); });
    }

    S.traces = traces;
    S.byId = new Map(traces.map((t) => [t.id, t]));
    if (S.selected && !S.byId.has(S.selected)) S.selected = null;
    plot.setPanes([...panes.values()]);
    if (!traces.length) S.fitted = false;
    else if (!S.fitted) { S.fitted = true; plot.fitAll(); }
    $('#empty').hidden = S.files.length > 0;
    renderTraces();
    if (traces.length > 300) status(`${traces.length} waveforms selected; drawing may be slow. Select fewer frames or channels.`, 8000);
    scheduleTrends();
  }

  function traceName(t) {
    const fr = t.nFrames > 1 ? `F${t.frame + 1}` : '';
    const parts = {
      label: [t.rec.alias, fr],
      file: [t.ch.label, fr],
      frame: [t.rec.alias, t.ch.label],
      single: [t.rec.alias, t.ch.label, fr],
    }[S.groupBy];
    return parts.filter(Boolean).join(' · ');
  }

  const fullName = (t) => `${t.rec.path} · ${t.ch.label} (${t.ch.math ? `= ${t.ch.math.expr}` : t.ch.key.toUpperCase()})${t.nFrames > 1 ? ` · frame ${t.frame + 1}` : ''}`;

  /** Recompute every trace's total shift after an offset changed. */
  function applyShifts() {
    for (const t of S.traces) t.shift = t.rec.offset + t.st.offset;
    plot.redraw();
    updateShiftInputs();
    scheduleReadouts();
    if (S.maths.length) scheduleMathRefresh();
    scheduleTrends();
  }

  function shiftTrace(t, dt) {
    if (S.move === 'file') t.rec.offset += dt; else t.st.offset += dt;
    applyShifts();
  }

  function onShiftDrag(t, dt) { shiftTrace(t, dt); }

  function onShiftEnd(t, total) {
    const r = (v) => Math.round(v * 1e12) / 1e12;   // keep shifts readable: whole picoseconds
    if (S.move === 'file') t.rec.offset = r(t.rec.offset); else t.st.offset = r(t.st.offset);
    applyShifts();
    if (total !== 0) {
      status(`${S.move === 'file' ? t.rec.alias : t.name} shifted by ${Units.fmt(total, 's', 5)}`);
      renderTraces();
      if (S.move === 'file') renderFiles();
    }
  }

  function onSelect(t) {
    S.selected = t ? t.id : null;
    for (const x of S.traces) x.selected = x.id === S.selected;
    document.querySelectorAll('#traces .trace').forEach((el) => el.classList.toggle('sel', el.dataset.id === S.selected));
    const row = S.selected && document.querySelector(`#traces .trace[data-id="${CSS.escape(S.selected)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
    plot.redraw();
  }

  // ================================================================ rendering: files

  function renderFiles() {
    const host = $('#files');
    const ready = S.files.filter((f) => f.status === 'ready');
    let h = `<div class="section-h"><span>Files (${S.files.length})</span>${S.files.length || S.pool.length ? '<button class="btn small" data-act="clear">Close all</button>' : ''}</div>`;
    if (S.pool.length) {
      h += `<div class="pool"><span>${S.pool.length} more capture${S.pool.length > 1 ? 's' : ''} in the opened folder</span>
        <button class="btn small primary" data-act="pick" title="Choose captures to load by their test conditions">Choose…</button></div>`;
    }
    if (!S.files.length && !S.pool.length) {
      h += '<div class="hint">Open .tss files to begin. A <code>tss_corrections.txt</code> selected with them renames channels.</div>';
    }
    if (ready.length > 1) {
      const order = [], count = new Map(), sel = new Map();
      for (const f of ready) {
        for (const c of f.cap.channels) {
          if (!count.has(c.label)) { order.push(c.label); count.set(c.label, 0); sel.set(c.label, 0); }
          count.set(c.label, count.get(c.label) + 1);
          if (f.selCh.has(c.label)) sel.set(c.label, sel.get(c.label) + 1);
        }
      }
      h += '<div class="section-h"><span>Channels in all files</span></div><div class="allch chips">';
      for (const l of order) {
        const cls = sel.get(l) === count.get(l) ? 'on' : sel.get(l) ? 'part' : '';
        h += `<span class="chip ${cls}" data-act="allch" data-ch="${esc(l)}" title="Toggle ${esc(l)} in every loaded file">${esc(l)}</span>`;
      }
      h += '</div>';
    }
    const prevFilter = $('#files .filter');
    if (S.files.length > 6) h += `<input type="text" class="filter" placeholder="Filter files or conditions…" spellcheck="false" title="Words to find in the file path or test conditions, e.g. 600 Np3000" value="${esc(prevFilter ? prevFilter.value : '')}">`;
    for (const rec of S.files) h += fileCard(rec);
    const refocus = prevFilter && prevFilter === document.activeElement;
    host.innerHTML = h;
    if (refocus) $('#files .filter').focus();
    applyFilter();
  }

  function fileCard(rec) {
    const cv = rec.cond && rec.cond.values;
    const summary = cv ? S.condVary.filter((k) => k in cv && Cond.text(cv[k]).trim()).map((k) => `${k} ${Cond.text(cv[k]).trim()}`).join(' · ') : '';
    let h = `<div class="file${rec.status === 'ready' ? '' : ' unloaded'}" data-id="${rec.id}" data-search="${esc(searchText(rec))}">
      <div class="fhead" data-act="toggle">
        <span class="caret">${rec.open ? '▼' : '▶'}</span>
        <span class="fname" title="${esc(rec.path)}">${esc(rec.alias)}${rec.dir ? `<span class="fdir">${esc(rec.dir)}</span>` : ''}${summary ? `<span class="fcond" title="${esc(summary)}">${esc(summary)}</span>` : ''}</span>
        ${rec.status === 'loading' ? '<span class="lbl">loading…</span>' : ''}
        ${rec.status === 'idle' ? '<button class="btn small" data-act="load">Load</button>' : ''}
        <button class="xbtn" data-act="remove" title="Close this file">×</button>
      </div>`;
    if (rec.open) {
      h += '<div class="fbody">';
      if (rec.status === 'error') h += `<div class="ferr">Could not read file: ${esc(rec.error)}</div>`;
      if (rec.status === 'ready') {
        const info = rec.cap.info, nF = info.frameCount;
        h += `<div class="fmeta">${rec.cap.channels.filter((c) => !c.math).length} ch · ${Units.fmt(info.samples, '', 4)} pts · ${Units.fmt(info.tstep, 's', 3)}/pt · ${Units.fmt(info.samples * info.tstep, 's', 3)}${nF > 1 ? ` · ${nF} frames` : ''}</div>`;
        h += '<div class="chips">';
        for (const c of rec.cap.channels) {
          const on = rec.selCh.has(c.label);
          const busy = on && !c.wfm && !c.error;
          const tip = `${c.math ? `Math: ${c.math.expr}` : c.key.toUpperCase()}${c.wfm ? ` · ${c.wfm.units}` : ''}${c.error ? ` · error: ${c.error}` : ''}`;
          const cls = `${on ? ' on' : ''}${busy ? ' busy' : ''}${c.math ? ' math' : ''}${c.error ? ' err' : ''}`;
          h += `<span class="chip${cls}" data-act="ch" data-ch="${esc(c.label)}" title="${esc(tip)}">${c.math ? 'ƒ ' : ''}${esc(c.label)}${c.wfm ? ` <small>${esc(c.wfm.units)}</small>` : ''}</span>`;
        }
        h += '</div>';
        if (nF > 1) {
          h += `<div class="row"><span class="lbl">Frames</span><input type="text" class="frspec" value="${esc(fmtFrames(rec.selFrames))}" title="Frame numbers, e.g. 1-5, 8" spellcheck="false">
                <button class="btn small" data-act="frall">All</button><button class="btn small" data-act="frnone">None</button></div>`;
          h += '<div class="frames">';
          const ft = info.frameTimes;
          for (let i = 0; i < Math.min(nF, MAX_FRAME_BUTTONS); i++) {
            h += `<span class="fr${rec.selFrames.has(i) ? ' on' : ''}" data-act="fr" data-f="${i}" title="Frame ${i + 1}, trigger +${esc(Units.fmt(ft[i], 's', 6))}">${i + 1}</span>`;
          }
          if (nF > MAX_FRAME_BUTTONS) h += `<span class="lbl">… use the box above for frames > ${MAX_FRAME_BUTTONS}</span>`;
          h += '</div>';
        }
        h += `<div class="row"><span class="lbl">Name</span><input type="text" class="alias" value="${esc(rec.alias)}" spellcheck="false" title="Display name used in the legend"></div>`;
        h += `<div class="row"><span class="lbl">Shift</span><input type="text" class="fshift" value="${esc(fmtShift(rec.offset))}" spellcheck="false" title="Time shift applied to every waveform of this file, e.g. 12.5n, -3us, 40 samples">
              <button class="btn small" data-act="fzero" title="Zero the file shift">0</button></div>`;
        if (rec.cap.png) h += '<div class="row"><button class="btn small" data-act="png">Scope screenshot</button></div>';
      }
      if (rec.status === 'idle') h += '<div class="hint" style="padding:0">Not loaded yet. Click <b>Load</b>.</div>';
      h += condBlock(rec);
      h += '</div>';
    }
    return h + '</div>';
  }

  /** Lower-case text the filters search: path, display name and every test condition. */
  function searchText(rec) {
    const cv = rec.cond && rec.cond.values;
    return [rec.path, rec.alias, cv ? Object.entries(cv).map(([k, v]) => `${k} ${Cond.text(v)}`).join(' ') : ''].join(' ').toLowerCase();
  }

  /** The file's test conditions as a key/value table; keys whose value differs between files are marked. */
  function condBlock(rec) {
    const c = rec.cond;
    if (!c) return '';
    if (c.error) return `<div class="ferr" title="${esc(c.path)}">Test conditions (${esc(c.name)}): ${esc(c.error)}</div>`;
    const vary = new Set(S.condVary);
    const rows = Object.entries(c.values).map(([k, v]) => {
      const t = Cond.text(v).trim();
      return `<tr${vary.has(k) ? ' class="vary" title="Differs between files"' : ''}><th>${esc(k)}</th><td>${t ? esc(t) : '<span class="lbl">—</span>'}</td></tr>`;
    }).join('');
    return `<details class="conds"${rec.condOpen ? ' open' : ''}><summary>Test conditions <span class="lbl" title="${esc(c.path)}">${esc(c.name)}</span></summary>
      <table>${rows}</table></details>`;
  }

  /** Every word typed in the filter must appear in the file's path, name or test conditions. */
  function applyFilter() {
    const box = $('#files .filter');
    const words = (box ? box.value : '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    document.querySelectorAll('#files .file').forEach((el) => { el.hidden = !words.every((w) => el.dataset.search.includes(w)); });
  }

  const recById = (id) => S.files.find((f) => f.id === +id);

  $('#files').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const card = el.closest('.file');
    const rec = card && recById(card.dataset.id);
    const act = el.dataset.act;
    if (act === 'clear') {
      S.files = []; S.pool = []; S.ts.clear(); S.selected = null; S.conds.clear(); S.condVary = [];
      CD.ticked.clear(); CD.filters.clear();
      if (TR.run) TR.run.stop = true;
      TR.batch.clear(); scheduleTrends();
      renderFiles(); rebuild(); return;
    }
    if (act === 'pick') { openPicker(); return; }
    if (act === 'allch') {
      const label = el.dataset.ch;
      const ready = S.files.filter((f) => f.status === 'ready' && f.cap.channels.some((c) => c.label === label));
      const allOn = ready.every((f) => f.selCh.has(label));
      for (const f of ready) { if (allOn) f.selCh.delete(label); else f.selCh.add(label); }
      renderFiles();
      for (const f of ready) ensureChannels(f);
      return;
    }
    if (!rec) return;
    switch (act) {
      case 'toggle':
        if (rec.status === 'idle') { loadFile(rec); return; }
        rec.open = !rec.open; renderFiles(); break;
      case 'load': loadFile(rec); break;
      case 'remove': removeFile(rec); break;
      case 'ch': {
        const l = el.dataset.ch;
        if (rec.selCh.has(l)) rec.selCh.delete(l); else rec.selCh.add(l);
        const c = rec.cap.channels.find((x) => x.label === l);
        if (c && c.math) c.error = null;   // allow a retry
        renderFiles(); ensureChannels(rec); break;
      }
      case 'fr': {
        const f = +el.dataset.f;
        if (e.altKey) rec.selFrames = new Set([f]);   // Alt+click: only this frame
        else if (rec.selFrames.has(f)) rec.selFrames.delete(f);
        else rec.selFrames.add(f);
        renderFiles(); rebuild(); break;
      }
      case 'frall': rec.selFrames = new Set(Array.from({ length: rec.cap.info.frameCount }, (_, i) => i)); renderFiles(); rebuild(); break;
      case 'frnone': rec.selFrames = new Set(); renderFiles(); rebuild(); break;
      case 'fzero': rec.offset = 0; applyShifts(); renderFiles(); renderTraces(); break;
      case 'png': {
        const blob = await rec.cap.screenshot();
        if (blob) window.open(URL.createObjectURL(blob), '_blank');
        break;
      }
    }
  });

  $('#files').addEventListener('change', (e) => {
    const card = e.target.closest('.file');
    const rec = card && recById(card.dataset.id);
    if (!rec) return;
    if (e.target.classList.contains('alias')) {
      rec.alias = e.target.value.trim() || stem(rec.name);
      renderFiles(); rebuild();
    } else if (e.target.classList.contains('fshift')) {
      const v = Units.parseTime(e.target.value, rec.cap && rec.cap.info.tstep);
      e.target.classList.toggle('bad', !isFinite(v));
      if (isFinite(v)) { rec.offset = v; applyShifts(); renderTraces(); e.target.value = fmtShift(v); }
    } else if (e.target.classList.contains('frspec')) {
      const set = parseFrames(e.target.value, rec.cap.info.frameCount);
      e.target.classList.toggle('bad', !set);
      if (set) { rec.selFrames = set; renderFiles(); rebuild(); }
    }
  });

  $('#files').addEventListener('input', (e) => { if (e.target.classList.contains('filter')) applyFilter(); });
  // 'toggle' does not bubble: listen in the capture phase to remember whether each conditions table is open.
  $('#files').addEventListener('toggle', (e) => {
    if (!e.target.classList.contains('conds')) return;
    const rec = recById(e.target.closest('.file').dataset.id);
    if (rec) rec.condOpen = e.target.open;
  }, true);
  $('#files').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input[type=text]')) e.target.blur(); });

  // ================================================================ rendering: traces

  function renderTraces() {
    const host = $('#traces');
    if (!S.traces.length) {
      host.innerHTML = '<div class="section-h"><span>Waveforms</span></div><div class="hint">Select channels in a file to show waveforms here.</div>';
      return;
    }
    let h = '<div class="section-h"><span>Waveforms</span><span class="lbl" style="text-transform:none;letter-spacing:0;font-weight:400">value at mouse</span></div>';
    for (const p of plot.panes) {
      h += `<div class="pane-h">${esc(p.title)}${p.unit ? ` [${esc(p.unit)}]` : ''}</div>`;
      for (const t of p.traces) {
        h += `<div class="trace${t.selected ? ' sel' : ''}${t.visible ? '' : ' hidden-tr'}" data-id="${esc(t.id)}" title="${esc(fullName(t))}">
          <div class="tline">
            <input type="checkbox" class="eye" ${t.visible ? 'checked' : ''} title="Show / hide">
            <input type="color" class="swatch" value="${t.color}" title="Colour">
            <span class="tname">${esc(t.name)}</span>
            <span class="tval"></span>
          </div>
          <div class="tshift">Δt <input type="text" class="shift" value="${esc(fmtShift(t.st.offset))}" spellcheck="false" title="Time shift of this waveform, e.g. 12.5n, -3us, 40 samples">
            <button class="btn small reset" title="Zero this shift">0</button>
            <span class="fnote">${t.rec.offset ? `+ file ${esc(Units.fmt(t.rec.offset, 's', 6))}` : ''}</span></div>
          <div class="tcur"${plot.cursors ? '' : ' hidden'}></div>
        </div>`;
      }
    }
    host.innerHTML = h;
    updateReadouts();
  }

  function updateShiftInputs() {
    document.querySelectorAll('#traces .trace').forEach((el) => {
      const t = S.byId.get(el.dataset.id);
      if (!t) return;
      const inp = $('.shift', el);
      if (inp !== document.activeElement) inp.value = fmtShift(t.st.offset);
      $('.fnote', el).textContent = t.rec.offset ? `+ file ${Units.fmt(t.rec.offset, 's', 6)}` : '';
    });
    document.querySelectorAll('#files .file').forEach((el) => {
      const rec = recById(el.dataset.id);
      const inp = $('.fshift', el);
      if (rec && inp && inp !== document.activeElement) inp.value = fmtShift(rec.offset);
    });
  }

  let readoutRaf = 0;
  function scheduleReadouts() {
    if (!readoutRaf) readoutRaf = requestAnimationFrame(() => { readoutRaf = 0; updateReadouts(); });
  }

  const valueAt = (t, time) => t.series.valueAt(time - t.shift);

  function updateReadouts() {
    const c = plot.cursors;
    if (c) renderCursorValues();
    document.querySelectorAll('#traces .trace').forEach((el) => {
      const t = S.byId.get(el.dataset.id);
      if (!t) return;
      $('.tval', el).textContent = S.hoverT == null ? '' : Units.fmt(valueAt(t, S.hoverT), t.unit, 4);
      const cur = $('.tcur', el);
      cur.hidden = !c;
      if (c) {
        const a = valueAt(t, c.a), b = valueAt(t, c.b);
        cur.textContent = `A ${Units.fmt(a, t.unit, 4)} · B ${Units.fmt(b, t.unit, 4)} · Δ ${Units.fmt(b - a, t.unit, 4)}`;
      }
    });
  }

  function renderCursorBox() {
    const box = $('#cursorBox');
    const c = plot.cursors;
    box.hidden = !c;
    $('#btnCursors').classList.toggle('on', !!c);
    if (!c) { box.innerHTML = ''; return; }
    if (!box.firstChild) {
      box.innerHTML = `<div class="row"><span class="ca">A</span><input type="text" class="curA" spellcheck="false"></div>
        <div class="row"><span class="cb">B</span><input type="text" class="curB" spellcheck="false"></div>
        <div class="row cdelta"></div>`;
    }
    renderCursorValues();
  }

  function renderCursorValues() {
    const c = plot.cursors, box = $('#cursorBox');
    if (!c || !box.firstChild) return;
    const a = $('.curA', box), b = $('.curB', box);
    if (a !== document.activeElement) a.value = Units.fmt(c.a, 's', 7);
    if (b !== document.activeElement) b.value = Units.fmt(c.b, 's', 7);
    const dt = c.b - c.a;
    $('.cdelta', box).textContent = `Δt ${Units.fmt(dt, 's', 5)}   1/Δt ${Units.fmt(1 / Math.abs(dt), 'Hz', 4)}`;
  }

  $('#cursorBox').addEventListener('change', (e) => {
    const k = e.target.classList.contains('curA') ? 'a' : e.target.classList.contains('curB') ? 'b' : null;
    if (!k || !plot.cursors) return;
    const v = Units.parseTime(e.target.value);
    e.target.classList.toggle('bad', !isFinite(v));
    if (isFinite(v)) { plot.cursors[k] = v; plot.redraw(); renderCursorValues(); scheduleReadouts(); }
  });

  $('#traces').addEventListener('click', (e) => {
    const row = e.target.closest('.trace');
    if (!row) return;
    const t = S.byId.get(row.dataset.id);
    if (!t) return;
    if (e.target.classList.contains('reset')) { t.st.offset = 0; applyShifts(); return; }
    if (e.target.matches('input')) return;
    onSelect(S.selected === t.id ? null : t);
  });

  $('#traces').addEventListener('change', (e) => {
    const row = e.target.closest('.trace');
    const t = row && S.byId.get(row.dataset.id);
    if (!t) return;
    if (e.target.classList.contains('eye')) {
      t.st.visible = t.visible = e.target.checked;
      row.classList.toggle('hidden-tr', !t.visible);
      plot.redraw();
    } else if (e.target.classList.contains('shift')) {
      const v = Units.parseTime(e.target.value, t.series.tstep);
      e.target.classList.toggle('bad', !isFinite(v));
      if (isFinite(v)) { t.st.offset = v; applyShifts(); }
    }
  });

  $('#traces').addEventListener('input', (e) => {
    if (!e.target.classList.contains('swatch')) return;
    const t = S.byId.get(e.target.closest('.trace').dataset.id);
    t.st.color = t.color = e.target.value;
    plot.redraw();
  });

  $('#traces').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input[type=text]')) e.target.blur(); });
  $('#cursorBox').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input[type=text]')) e.target.blur(); });

  // ================================================================ file picker by test conditions
  //
  // One row per capture (listed files and the candidates found by Open folder), one column per
  // condition key. Filter the rows by condition values, tick the captures to load, then Load.
  // Marked ("name") columns can also be turned into the files' display names.

  const cdlg = $('#condDlg');
  const CD = { sort: null, dir: 1, nameKeys: new Set(), filters: new Map(), ticked: new Set() };

  try { CD.nameKeys = new Set(JSON.parse(localStorage.getItem('tssviewer.condName') || '[]')); } catch (_) { /* ignore */ }
  const saveNameKeys = () => { try { localStorage.setItem('tssviewer.condName', JSON.stringify([...CD.nameKeys])); } catch (_) { /* ignore */ } };

  const allRecs = () => [...S.files, ...S.pool];
  const condVal = (f, k) => Cond.text(f.cond && f.cond.values ? f.cond.values[k] : undefined).trim();
  const tickable = (f) => f.status !== 'ready' && f.status !== 'loading';

  function condKeys(recs = allRecs()) {
    const keys = [];
    for (const f of recs) if (f.cond && f.cond.values) for (const k of Object.keys(f.cond.values)) if (!keys.includes(k)) keys.push(k);
    return keys;
  }

  /** Rows passing the text box and every condition filter except `skip`. */
  function filteredRecs(skip) {
    const words = $('#cdText').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return allRecs().filter((f) => {
      for (const [k, v] of CD.filters) if (k !== skip && condVal(f, k) !== v) return false;
      const s = searchText(f);
      return words.every((w) => s.includes(w));
    });
  }

  function openPicker() {
    renderCondTable();
    if (!cdlg.open) cdlg.showModal();
  }

  function renderCondTable() {
    const recs = allRecs();
    const all = condKeys(recs);
    const vary = new Set(Cond.varying(recs.filter((f) => f.cond && f.cond.values).map((f) => f.cond.values)));
    for (const k of [...CD.filters.keys()]) if (!all.includes(k)) CD.filters.delete(k);
    for (const id of [...CD.ticked]) { const f = recById(id) || S.pool.find((p) => p.id === id); if (!f || !tickable(f)) CD.ticked.delete(id); }
    const keys = $('#cdVary').checked ? all.filter((k) => vary.has(k) || CD.filters.has(k)) : all;

    const rows = filteredRecs();
    if (CD.sort === '') rows.sort((a, b) => CD.dir * Tss.natural(a.path, b.path));
    else if (CD.sort) rows.sort((a, b) => CD.dir * Cond.compare(condVal(a, CD.sort), condVal(b, CD.sort)));
    const arrow = (k) => (CD.sort === k ? (CD.dir > 0 ? ' ▲' : ' ▼') : '');

    const shownTickable = rows.filter(tickable);
    const allOn = shownTickable.length > 0 && shownTickable.every((f) => CD.ticked.has(f.id));
    let h = `<table><thead><tr><th class="cdfile"><label class="cdall" title="Tick or untick every file shown"><input type="checkbox" data-tickall${allOn ? ' checked' : ''}${shownTickable.length ? '' : ' disabled'}></label>
      <span data-sort="" title="Sort by file path">File${arrow('')}</span></th>`;
    for (const k of keys) {
      // Value choices come from the rows that pass the other filters, with how many files have each.
      const counts = new Map();
      for (const f of filteredRecs(k)) { const v = condVal(f, k); counts.set(v, (counts.get(v) || 0) + 1); }
      const values = [...counts.keys()].sort(Cond.compare);
      const cur = CD.filters.has(k) ? CD.filters.get(k) : null;
      if (cur !== null && !counts.has(cur)) values.push(cur);
      const opts = values.map((v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${v ? esc(v) : '(blank)'} (${counts.get(v) || 0})</option>`).join('');
      h += `<th class="${vary.has(k) ? 'vary' : ''}${cur !== null ? ' filt' : ''}"><span data-sort="${esc(k)}" title="Sort by ${esc(k)}">${esc(k)}${arrow(k)}</span>
        <select data-filt="${esc(k)}" title="Show only files with this ${esc(k)}"><option value="*">all</option>${opts}</select>
        <label class="cdname" title="Use this condition in file names"><input type="checkbox" data-name="${esc(k)}"${CD.nameKeys.has(k) ? ' checked' : ''}>name</label></th>`;
    }
    h += '</tr></thead><tbody>';
    for (const f of rows) {
      const state = f.status === 'ready' ? '<span class="cdok" title="Loaded">●</span>'
        : f.status === 'loading' ? '<span class="lbl">loading…</span>'
        : `<input type="checkbox" data-tick${CD.ticked.has(f.id) ? ' checked' : ''}>${f.status === 'error' ? ` <span class="ferr" title="${esc(f.error)}">error</span>` : ''}`;
      const measured = TR.batch.has(f.id) && !TR.batch.get(f.id).error ? ' <span class="cdtag" title="Measured for Frame trends without loading">measured</span>' : '';
      h += `<tr data-id="${f.id}" class="${tickable(f) ? 'tk' : 'loaded'}${CD.ticked.has(f.id) ? ' on' : ''}" title="${esc(f.path)}${f.cond ? `\n${esc(f.cond.path)}` : '\n(no test-condition JSON found)'}">
        <td class="cdfile">${state} <span class="cdalias">${esc(f.alias)}</span>${measured}<span class="fdir">${esc(f.dir)}</span></td>`;
      for (const k of keys) h += `<td>${f.cond && f.cond.error ? '' : esc(condVal(f, k))}</td>`;
      h += '</tr>';
    }
    if (!rows.length) h += `<tr><td class="cdfile lbl" colspan="${keys.length + 1}">${recs.length ? 'No file matches the filters.' : 'No files. Use Open folder to find captures.'}</td></tr>`;
    $('#cdTable').innerHTML = h + '</tbody></table>';

    const loaded = recs.filter((f) => f.status === 'ready').length;
    $('#cdInfo').textContent = !recs.length ? '' : `${rows.length} of ${recs.length} files shown · ${loaded} loaded · ${CD.ticked.size} ticked`;
    $('#cdLoad').textContent = CD.ticked.size ? `Load ${CD.ticked.size} ticked file${CD.ticked.size > 1 ? 's' : ''}` : 'Load ticked files';
    $('#cdLoad').disabled = !CD.ticked.size;
    $('#cdMeasure').textContent = CD.ticked.size ? `Measure ${CD.ticked.size} ticked` : 'Measure ticked';
    $('#cdMeasure').disabled = !CD.ticked.size;
    $('#cdClear').disabled = !CD.filters.size && !$('#cdText').value;
  }

  /** Move the ticked candidates into the file list and load every ticked file. */
  async function loadTicked() {
    const recs = allRecs().filter((f) => CD.ticked.has(f.id) && tickable(f));
    CD.ticked.clear();
    if (!recs.length) return;
    S.pool = S.pool.filter((f) => !recs.includes(f));
    for (const f of recs) if (!S.files.includes(f)) S.files.push(f);
    cdlg.close();
    attachConds();
    renderFiles(); rebuild();
    for (const [i, f] of recs.entries()) {
      status(`Loading ${i + 1} of ${recs.length}: ${f.alias}`, 60000);
      await loadFile(f);
    }
    status(`Loaded ${recs.length} file${recs.length > 1 ? 's' : ''}`);
  }

  /** Display names from the marked condition columns, e.g. "high_voltage=600 · test_current=10". */
  function nameFromConds() {
    const recs = allRecs();
    const keys = condKeys(recs).filter((k) => CD.nameKeys.has(k));
    if (!keys.length) { status('Tick "name" under the conditions to use in file names'); return; }
    const seen = new Map();
    for (const f of recs) {
      const v = f.cond && f.cond.values;
      const parts = v ? keys.filter((k) => condVal(f, k)).map((k) => `${k}=${condVal(f, k)}`) : [];
      let name = parts.length ? parts.join(' · ') : stem(f.name);
      const n = (seen.get(name) || 0) + 1;
      seen.set(name, n);
      if (n > 1) name += ` #${n}`;
      f.alias = name;
    }
    renderFiles(); rebuild(); renderCondTable();
    if (!tpanel.hidden) computeTrends();
  }

  function resetNames() {
    for (const f of allRecs()) f.alias = stem(f.name);
    renderFiles(); rebuild(); renderCondTable();
    if (!tpanel.hidden) computeTrends();
  }

  $('#btnCond').addEventListener('click', openPicker);
  $('#cdClose').addEventListener('click', () => cdlg.close());
  $('#cdVary').addEventListener('change', renderCondTable);
  $('#cdText').addEventListener('input', renderCondTable);
  $('#cdText').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  $('#cdClear').addEventListener('click', () => { CD.filters.clear(); $('#cdText').value = ''; renderCondTable(); });
  $('#cdLoad').addEventListener('click', loadTicked);
  $('#cdMeasure').addEventListener('click', () => {
    const recs = allRecs().filter((f) => CD.ticked.has(f.id) && tickable(f));
    if (!TR.list.length) { cdlg.close(); measureFiles([]); return; }   // explains that a measurement is needed first
    CD.ticked.clear();
    cdlg.close();
    measureFiles(recs);
  });
  $('#cdName').addEventListener('click', nameFromConds);
  $('#cdReset').addEventListener('click', resetNames);

  $('#cdTable').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.name !== undefined) {
      if (t.checked) CD.nameKeys.add(t.dataset.name); else CD.nameKeys.delete(t.dataset.name);
      saveNameKeys();
    } else if (t.dataset.filt !== undefined) {
      if (t.value === '*') CD.filters.delete(t.dataset.filt); else CD.filters.set(t.dataset.filt, t.value);
      renderCondTable();
    } else if (t.dataset.tickall !== undefined) {
      for (const f of filteredRecs().filter(tickable)) { if (t.checked) CD.ticked.add(f.id); else CD.ticked.delete(f.id); }
      renderCondTable();
    }
  });

  $('#cdTable').addEventListener('click', (e) => {
    if (e.target.closest('.cdname, select, .cdall')) return;
    const s = e.target.closest('[data-sort]');
    if (s) {
      const k = s.dataset.sort;
      if (CD.sort === k) CD.dir = -CD.dir; else { CD.sort = k; CD.dir = 1; }
      renderCondTable();
      return;
    }
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    const id = +row.dataset.id;
    const rec = allRecs().find((f) => f.id === id);
    if (!rec) return;
    if (tickable(rec)) {
      // Click anywhere on the row (or its checkbox) to tick or untick it.
      const on = e.target.matches('[data-tick]') ? e.target.checked : !CD.ticked.has(id);
      if (on) CD.ticked.add(id); else CD.ticked.delete(id);
      renderCondTable();
      return;
    }
    // A loaded file: show it in the file list.
    cdlg.close();
    rec.open = true;
    renderFiles();
    const card = document.querySelector(`#files .file[data-id="${rec.id}"]`);
    if (card) { card.hidden = false; card.scrollIntoView({ block: 'nearest' }); }
  });

  // ================================================================ math dialog

  const mdlg = $('#mathDlg');
  const M = { editing: null, autoName: true };

  /** Real channel labels across all loaded files, in first-seen order. */
  function knownLabels() {
    const out = [];
    for (const f of S.files) {
      if (f.status !== 'ready') continue;
      for (const c of f.cap.channels) if (!c.math && !out.includes(c.label)) out.push(c.label);
    }
    return out;
  }

  const QUICK = {
    add: (a, b) => [`${MathExpr.ref(a)} + ${MathExpr.ref(b)}`, `${a}+${b}`],
    sub: (a, b) => [`${MathExpr.ref(a)} - ${MathExpr.ref(b)}`, `${a}−${b}`],
    mul: (a, b) => [`${MathExpr.ref(a)} * ${MathExpr.ref(b)}`, `${a}×${b}`],
    div: (a, b) => [`${MathExpr.ref(a)} / ${MathExpr.ref(b)}`, `${a}/${b}`],
    integ: (a) => [`integ(${MathExpr.ref(a)})`, `∫${a}`],
    diff: (a) => [`diff(${MathExpr.ref(a)})`, `d${a}/dt`],
    abs: (a) => [`abs(${MathExpr.ref(a)})`, `|${a}|`],
  };

  function openMath() {
    renderMathList();
    fillOperands();
    resetMathForm();
    mdlg.showModal();
    $('#mExpr').focus();
  }

  function fillOperands() {
    const opts = [...knownLabels(), ...S.maths.map((d) => d.name)];
    for (const id of ['#mA', '#mB']) {
      const sel = $(id), prev = sel.value;
      sel.innerHTML = opts.map((o) => `<option>${esc(o)}</option>`).join('');
      if (opts.includes(prev)) sel.value = prev;
    }
    if (opts.length > 1 && $('#mA').value === $('#mB').value) $('#mB').selectedIndex = 1;
  }

  function renderMathList() {
    $('#mathList').innerHTML = S.maths.length
      ? S.maths.map((d) => `<div class="mitem" data-id="${d.id}">
          <span class="mdef"><b>${esc(d.name)}</b> = <code>${esc(d.expr)}</code>${d.unit ? ` <span class="lbl">[${esc(d.unit)}]</span>` : ''}</span>
          <button class="btn small" type="button" data-act="edit">Edit</button>
          <button class="btn small" type="button" data-act="del">Delete</button></div>`).join('')
      : '<div class="hint" style="padding:0 0 6px">No math channels yet.</div>';
  }

  function resetMathForm() {
    M.editing = null; M.autoName = true;
    $('#mName').value = ''; $('#mExpr').value = ''; $('#mUnit').value = '';
    $('#mSave').textContent = 'Add';
    validateMath();
  }

  /** Check the form; returns the definition to save, or null (message shown either way). */
  function validateMath() {
    const name = $('#mName').value.trim(), expr = $('#mExpr').value.trim(), unit = $('#mUnit').value.trim();
    const msg = $('#mMsg');
    const bad = (m) => { msg.className = 'mmsg bad'; msg.textContent = m; return null; };
    if (!expr) { msg.className = 'mmsg'; msg.textContent = 'Type an expression, or use the quick buttons.'; return null; }
    let ast;
    try { ast = MathExpr.parse(expr); } catch (err) { return bad(err.message); }
    if (!name) return bad('Give the channel a name.');
    if (name === 't') return bad('"t" is reserved for time.');
    const lo = name.toLowerCase();
    if (knownLabels().some((l) => l.toLowerCase() === lo)) return bad(`"${name}" is already a channel name.`);
    if (S.maths.some((d) => d.id !== M.editing && d.name.toLowerCase() === lo)) return bad(`A math channel named "${name}" already exists.`);
    const refs = [...MathExpr.refs(ast)];
    if (refs.some((r) => r.toLowerCase() === lo)) return bad('A math channel cannot use itself.');

    const mathNames = new Set(S.maths.filter((d) => d.id !== M.editing).map((d) => d.name));
    const ready = S.files.filter((f) => f.status === 'ready');
    const real = (f) => f.cap.channels.filter((c) => !c.math);
    const usable = ready.filter((f) => refs.every((r) => resolveIn(real(f), r) || mathNames.has(r)));
    const missing = refs.filter((r) => !mathNames.has(r) && !ready.some((f) => resolveIn(real(f), r)));
    msg.className = missing.length && ready.length ? 'mmsg warn' : 'mmsg ok';
    msg.textContent = missing.length && ready.length
      ? `Not found in any loaded file: ${missing.join(', ')}`
      : ready.length ? `OK · applies to ${usable.length} of ${ready.length} loaded file${ready.length > 1 ? 's' : ''}` : 'OK';
    return { name, expr, unit };
  }

  $('#btnMath').addEventListener('click', openMath);
  $('#mClose').addEventListener('click', () => mdlg.close());
  $('#mNew').addEventListener('click', resetMathForm);
  $('#mName').addEventListener('input', () => { M.autoName = $('#mName').value.trim() === ''; validateMath(); });
  $('#mExpr').addEventListener('input', validateMath);
  $('#mUnit').addEventListener('input', validateMath);

  $('#mathForm').addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]');
    if (!q) return;
    const [expr, name] = QUICK[q.dataset.q]($('#mA').value, $('#mB').value);
    if (!$('#mA').value) return;
    $('#mExpr').value = expr;
    if (M.autoName) $('#mName').value = name;
    validateMath();
  });

  $('#mathForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const def = validateMath();
    if (!def) return;
    if (M.editing) Object.assign(S.maths.find((d) => d.id === M.editing), def);
    else S.maths.push({ id: S.nextMathId++, ...def });
    applyMaths(def.name);
    status(`Math channel ${def.name} = ${def.expr}`);
    mdlg.close();
  });

  $('#mathList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = +b.closest('.mitem').dataset.id;
    const def = S.maths.find((d) => d.id === id);
    if (b.dataset.act === 'edit') {
      M.editing = id; M.autoName = false;
      $('#mName').value = def.name; $('#mExpr').value = def.expr; $('#mUnit').value = def.unit;
      $('#mSave').textContent = 'Update';
      validateMath();
    } else if (b.dataset.act === 'del') {
      S.maths = S.maths.filter((d) => d.id !== id);
      if (M.editing === id) resetMathForm();
      applyMaths();
      renderMathList();
      fillOperands();
    }
  });

  // ================================================================ frame trends
  //
  // A measurement reduces one channel over a time window to one number per frame (mean, integral,
  // min, …). Every frame of every loaded file that has the channel is measured, and the numbers are
  // plotted against the frame number or trigger time. The window is in displayed time, like the
  // cursors, so each waveform's Δt shift moves it relative to the window.

  const trend = new TrendChart($('#trendPlot'), { onHover: renderTrendTable, onPick: pickTrendPoint });
  // batch: rec id -> results of files measured without being loaded (see measureFiles()).
  const TR = { list: [], nextId: 1, sel: null, xMode: 'frame', data: [], gen: 0, batch: new Map(), run: null };
  const defKey = (d) => `${d.ch}|${d.stat}|${d.a}|${d.b}`;
  const tpanel = $('#trendPanel');

  const trendName = (d) => `${Trend.STATS[d.stat].label} ${d.ch}`;
  const trendWin = (d) => (d.stat === 'at' ? `@ ${Units.fmt(d.a, 's', 5)}` : `${Units.fmt(d.a, 's', 5)} … ${Units.fmt(d.b, 's', 5)}`);

  function saveTrends() {
    try {
      localStorage.setItem('tssviewer.trends', JSON.stringify({ xMode: TR.xMode, list: TR.list.map(({ ch, stat, a, b }) => ({ ch, stat, a, b })) }));
    } catch (_) { /* ignore */ }
  }

  function loadTrends() {
    try {
      const o = JSON.parse(localStorage.getItem('tssviewer.trends') || '{}');
      if (o.xMode === 'time') TR.xMode = 'time';
      TR.list = (o.list || []).filter((d) => d && d.ch && d.stat in Trend.STATS && isFinite(d.a) && isFinite(d.b))
        .map((d) => ({ id: TR.nextId++, ch: d.ch, stat: d.stat, a: d.a, b: d.b }));
    } catch (_) { /* ignore */ }
    $('#tX').value = TR.xMode;
    $('#tStat').innerHTML = Object.entries(Trend.STATS).map(([k, s]) => `<option value="${k}">${esc(s.label)}</option>`).join('');
    renderTrendList();
  }

  /** Channel choices: every channel label (math included) of the loaded and measured files. */
  function fillTrendChannels() {
    const opts = [];
    for (const f of S.files) {
      if (f.status !== 'ready') continue;
      for (const c of f.cap.channels) if (!opts.includes(c.label)) opts.push(c.label);
    }
    for (const b of TR.batch.values()) for (const l of b.labels) if (!opts.includes(l)) opts.push(l);
    const sel = $('#tCh'), html = opts.map((o) => `<option>${esc(o)}</option>`).join('');
    if (sel.innerHTML === html) return;   // keep an open dropdown undisturbed
    const prev = sel.value;
    sel.innerHTML = html;
    if (opts.includes(prev)) sel.value = prev;
  }

  let trendTimer = 0;
  function scheduleTrends() {
    if (tpanel.hidden) return;
    clearTimeout(trendTimer);
    trendTimer = setTimeout(() => { if (plot.drag) scheduleTrends(); else computeTrends(); }, 150);
  }

  async function computeTrends() {
    const gen = ++TR.gen;
    fillTrendChannels();
    const ready = S.files.filter((f) => f.status === 'ready');
    // Files measured without loading; once a file is loaded its live (shift-aware) values are used.
    const batch = [...TR.batch.values()].filter((b) => !b.error && b.rec.status !== 'ready');
    const pal = PALETTE[isDark() ? 'dark' : 'light'];
    const panes = [];
    for (const d of TR.list) {
      const pane = { def: d, title: `${trendName(d)}  ${trendWin(d)}`, unit: null, series: [] };
      const addSeries = (rec, k, ys, ft, u) => {
        const xs = new Float64Array(ys.length);
        for (let f = 0; f < ys.length; f++) xs[f] = TR.xMode === 'time' ? ft[f] : f + 1;
        pane.unit = pane.unit === null || pane.unit === u ? u : '';
        pane.series.push({ rec, name: rec.alias, color: pal[k % pal.length], xs, ys, ft });
      };
      for (const [k, rec] of ready.entries()) {
        const ch = rec.cap.channels.find((c) => c.label === d.ch);
        if (!ch) continue;
        try { await loadCh(rec, ch); } catch (_) { continue; }
        if (gen !== TR.gen) return;   // superseded by a newer request
        if (!ch.wfm) continue;
        const w = ch.wfm, nF = w.frameCount, ft = w.frameTimes || rec.cap.info.frameTimes;
        const ys = new Float64Array(nF);
        for (let f = 0; f < nF; f++) {
          const st = S.ts.get(`${rec.id}|${ch.key}|${f}`);
          const shift = rec.offset + (st ? st.offset : 0);
          ys[f] = Trend.measure(seriesFor(ch, f), d.a - shift, d.b - shift, d.stat);
        }
        addSeries(rec, k, ys, ft, Trend.STATS[d.stat].unit(w.units));
      }
      for (const [j, b] of batch.entries()) {
        const v = b.vals.get(defKey(d));
        if (v) addSeries(b.rec, ready.length + j, v.ys, b.ft, v.unit);
      }
      pane.unit = pane.unit || '';
      panes.push(pane);
    }
    TR.data = panes;
    renderBatchInfo();
    const empty = !ready.length && !batch.length
      ? 'Load .tss files, or tick files under Conditions and click Measure ticked, to measure them.'
      : 'Pick what to measure, a channel and a time window above, then Add.';
    trend.setData(panes, TR.xMode === 'time' ? 's' : '', empty);
    renderTrendTable(null);
  }

  /** Values table next to the chart: at the hovered frame, or averaged over all frames. */
  function renderTrendTable(x) {
    const host = $('#trendTable');
    const panes = TR.data.filter((p) => p.series.length);
    if (!panes.length) { host.innerHTML = '<div class="hint">Values per file appear here. Hover the chart to read one frame.</div>'; return; }
    const recs = [];
    for (const p of panes) for (const s of p.series) if (!recs.includes(s.rec)) recs.push(s.rec);
    const head = x == null ? 'Mean of frames' : TR.xMode === 'time' ? `t ${Units.fmt(x, 's', 4)}` : `Frame ${x}`;
    let h = `<table><tr><th>${esc(head)}</th>${panes.map((p) => `<th title="${esc(p.title)}">${esc(trendName(p.def))}</th>`).join('')}</tr>`;
    for (const rec of recs) {
      const color = panes.flatMap((p) => p.series).find((s) => s.rec === rec).color;
      h += `<tr><td title="${esc(rec.path)}"><span class="sw" style="background:${color}"></span>${esc(rec.alias)}</td>`;
      for (const p of panes) {
        const s = p.series.find((q) => q.rec === rec);
        let v = NaN, tip = '';
        if (s && x == null) {
          let sum = 0, n = 0;
          for (const y of s.ys) if (isFinite(y)) { sum += y; n++; }
          v = n ? sum / n : NaN;
          tip = `${n} frames`;
        } else if (s) {
          const i = Trend.nearest(s.xs, x);
          v = s.ys[i];
          tip = `frame ${i + 1}`;
        }
        h += `<td title="${esc(tip)}">${s ? esc(Units.fmt(v, p.unit, 4)) : ''}</td>`;
      }
      h += '</tr>';
    }
    host.innerHTML = h + '</table>';
  }

  /** Click on a point: show that frame of that file (Shift/Ctrl+click adds it to the selection). */
  async function pickTrendPoint(s, i, e) {
    const rec = s.rec;
    if (S.pool.includes(rec)) {
      // A file measured without loading: load it now, showing the clicked frame.
      S.pool = S.pool.filter((f) => f !== rec);
      S.files.push(rec);
      attachConds();
      rec.selFrames = new Set([i]);
      status(`Loading ${rec.alias} to show frame ${i + 1}…`);
      await loadFile(rec);
      return;
    }
    if (!S.files.includes(rec) || rec.status !== 'ready') return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) rec.selFrames.add(i); else rec.selFrames = new Set([i]);
    rec.open = true;
    renderFiles(); rebuild();
    status(`${rec.alias}: showing frame ${fmtFrames(rec.selFrames)}`);
  }

  function renderTrendList() {
    $('#trendList').innerHTML = TR.list.map((d) => `<span class="chip${d.id === TR.sel ? ' on' : ''}" data-id="${d.id}" title="Click to edit it and show its window on the plot">
      ${esc(trendName(d))} <span class="lbl">${esc(trendWin(d))}</span><button type="button" class="xbtn" data-act="del" title="Remove">×</button></span>`).join('');
    $('#tAdd').textContent = TR.sel ? 'Add new' : 'Add';
    $('#tUpd').hidden = !TR.sel;
    renderBatchInfo();
  }

  // ---------------------------------------------------------------- measuring files without loading
  //
  // The measurements in TR.list are applied to each file in turn: open it, measure every frame,
  // keep only the numbers and let the capture go, so a whole folder can be measured. These files
  // are not shown in the waveform plot, so no time shifts apply to them.

  async function measureFiles(recs) {
    toggleTrends(true);
    if (!TR.list.length) {
      status('First define a measurement here (what, channel, time window) and click Add; then measure the files.', 10000);
      return;
    }
    if (TR.run) { status('Already measuring files; wait or click Stop'); return; }
    recs = recs.filter((r) => r.status !== 'ready');   // loaded files are measured live anyway
    const run = TR.run = { stop: false, done: 0, total: recs.length };
    const defs = [...TR.list];
    renderBatchInfo();
    for (const rec of recs) {
      if (run.stop) break;
      const entry = { rec, vals: new Map(), labels: [], ft: [], error: null };
      try {
        // A stand-in record: same blob, own id (so no Δt shifts apply), dropped after measuring.
        const tmp = { id: `m${rec.id}`, status: 'ready', selCh: new Set(), offset: 0, cap: await Tss.open(rec.blob, S.corrections.get(rec.dir) || {}) };
        syncMath(tmp);
        entry.labels = tmp.cap.channels.map((c) => c.label);
        entry.ft = tmp.cap.info.frameTimes;
        for (const d of defs) {
          const ch = tmp.cap.channels.find((c) => c.label === d.ch);
          if (!ch) continue;
          await loadCh(tmp, ch);
          const w = ch.wfm, ys = new Float64Array(w.frameCount);
          for (let f = 0; f < w.frameCount; f++) ys[f] = Trend.measure(seriesFor(ch, f), d.a, d.b, d.stat);
          entry.vals.set(defKey(d), { ys, unit: Trend.STATS[d.stat].unit(w.units) });
        }
      } catch (err) {
        entry.error = err.message || String(err);
        console.error(err);
      }
      TR.batch.set(rec.id, entry);
      run.done++;
      renderBatchInfo();
      scheduleTrends();
      await new Promise((r) => setTimeout(r, 0));   // let the page repaint between files
    }
    TR.run = null;
    computeTrends();
    const failed = recs.filter((r) => TR.batch.get(r.id) && TR.batch.get(r.id).error).length;
    status(`${run.stop ? 'Stopped: ' : ''}measured ${run.done} of ${recs.length} file${recs.length > 1 ? 's' : ''}${failed ? `, ${failed} could not be read` : ''}`, 8000);
  }

  /** Status line for files measured without loading: progress, failures, out-of-date results. */
  function renderBatchInfo() {
    const el = $('#trendBatch'), run = TR.run, list = [...TR.batch.values()];
    if (run) {
      el.innerHTML = `<span>Measuring files: ${run.done} of ${run.total}…</span><button type="button" class="btn small" data-act="stop">Stop</button>`;
      return;
    }
    if (!list.length) { el.innerHTML = ''; return; }
    const errs = list.filter((b) => b.error);
    const stale = list.filter((b) => !b.error && TR.list.some((d) => !b.vals.has(defKey(d)) && b.labels.includes(d.ch))).length;
    el.innerHTML = `<span>${list.length} file${list.length > 1 ? 's' : ''} measured without loading</span>
      ${errs.length ? `<span class="ferr" title="${esc(errs.map((b) => `${b.rec.path}: ${b.error}`).join('\n'))}">${errs.length} could not be read</span>` : ''}
      ${stale ? `<span class="warn">${stale} lack the newest measurements</span>` : ''}
      <button type="button" class="btn small${stale ? ' primary' : ''}" data-act="redo" title="Measure these files again with the current measurements">Measure again</button>
      <button type="button" class="btn small" data-act="drop" title="Remove these files from the trends">Remove</button>`;
  }

  $('#trendBatch').addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (act === 'stop' && TR.run) TR.run.stop = true;
    else if (act === 'redo') { const recs = [...TR.batch.values()].map((b) => b.rec); TR.batch.clear(); measureFiles(recs); }
    else if (act === 'drop') { TR.batch.clear(); computeTrends(); }
  });

  /** Read the form; returns {ch, stat, a, b} or null (bad fields are outlined). */
  function readTrendForm() {
    const stat = $('#tStat').value, ch = $('#tCh').value, at = stat === 'at';
    const sa = $('#tA').value.trim(), sb = $('#tB').value.trim();
    const a = sa ? Units.parseTime(sa) : NaN, b = at ? a : sb ? Units.parseTime(sb) : NaN;
    $('#tA').classList.toggle('bad', !isFinite(a));
    $('#tB').classList.toggle('bad', !at && !isFinite(b));
    if (!ch || !isFinite(a) || !isFinite(b)) return null;
    return { ch, stat, a: Math.min(a, b), b: Math.max(a, b) };
  }

  function writeTrendForm(d) {
    $('#tStat').value = d.stat;
    if ([...$('#tCh').options].some((o) => o.value === d.ch)) $('#tCh').value = d.ch;
    $('#tA').value = Units.fmt(d.a, 's', 6);
    $('#tB').value = Units.fmt(d.b, 's', 6);
    syncTrendForm();
  }

  /** Show the form's window as a band on the waveform plot; hide "to" for single-time stats. */
  function syncTrendForm() {
    const at = $('#tStat').value === 'at';
    document.querySelectorAll('#trendForm .tB').forEach((el) => { el.hidden = at; });
    $('#tALbl').textContent = at ? 'at' : 'from';
    const sa = $('#tA').value.trim();
    const a = sa ? Units.parseTime(sa) : NaN, b = at ? a : Units.parseTime($('#tB').value);
    plot.band = !tpanel.hidden && isFinite(a) && isFinite(b) ? { a, b } : null;
    plot.redraw();
  }

  function setTrendWindowFromCursors() {
    if (!plot.cursors) plot.setCursors(true);
    const c = plot.cursors;
    $('#tA').value = Units.fmt(Math.min(c.a, c.b), 's', 6);
    $('#tB').value = Units.fmt(Math.max(c.a, c.b), 's', 6);
    syncTrendForm();
  }

  function toggleTrends(open = tpanel.hidden) {
    tpanel.hidden = !open;
    $('#btnTrend').classList.toggle('on', open);
    if (open) {
      fillTrendChannels();
      if (!$('#tA').value.trim() && S.traces.length) {
        const c = plot.cursors, w = plot.x1 - plot.x0;
        const a = c ? Math.min(c.a, c.b) : plot.x0 + w / 3, b = c ? Math.max(c.a, c.b) : plot.x0 + (2 * w) / 3;
        $('#tA').value = Units.fmt(a, 's', 4); $('#tB').value = Units.fmt(b, 's', 4);
      }
      computeTrends();
    }
    syncTrendForm();
  }

  const csvQ = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csvNum = (v) => (isFinite(v) ? String(v) : '');

  /**
   * Every measured file in one CSV, one row per file and frame: the file's folder and name, all its test conditions
   * (blank when it has no .json), frame, trigger time and one column per measurement.
   */
  function exportTrendCsv() {
    const panes = TR.data.filter((p) => p.series.length);
    if (!panes.length) { status('Nothing to export: add a measurement first'); return; }
    const recs = [];
    for (const p of panes) for (const s of p.series) if (!recs.includes(s.rec)) recs.push(s.rec);
    const keys = condKeys(recs);
    const cols = panes.map((p) => `${trendName(p.def)} ${trendWin(p.def)}${p.unit ? ` [${p.unit}]` : ''}`);
    const lines = [['file path', 'file name', ...keys, 'frame', 'trigger time [s]', ...cols].map(csvQ).join(',')];
    for (const rec of recs) {
      const ser = panes.map((p) => p.series.find((s) => s.rec === rec) || null);
      const ft = ser.find(Boolean).ft || [];
      const nF = Math.max(...ser.filter(Boolean).map((s) => s.ys.length));
      const head = [rec.dir, rec.name, ...keys.map((k) => condVal(rec, k))].map(csvQ).join(',');
      for (let f = 0; f < nF; f++) {
        lines.push(`${head},${f + 1},${csvNum(ft[f])},${ser.map((s) => (s && f < s.ys.length ? csvNum(s.ys[f]) : '')).join(',')}`);
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));   // BOM: Excel reads µ, Ω
    a.download = 'tss-trends.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status(`Saved tss-trends.csv: ${recs.length} file${recs.length > 1 ? 's' : ''}, ${lines.length - 1} rows`);
  }

  $('#btnTrend').addEventListener('click', () => toggleTrends());
  $('#tClose').addEventListener('click', () => toggleTrends(false));
  $('#tCur').addEventListener('click', setTrendWindowFromCursors);
  $('#tCsv').addEventListener('click', exportTrendCsv);
  $('#tMeasure').addEventListener('click', openPicker);
  $('#tX').addEventListener('change', (e) => { TR.xMode = e.target.value; saveTrends(); computeTrends(); });
  $('#trendForm').addEventListener('input', syncTrendForm);
  $('#trendForm').addEventListener('change', syncTrendForm);

  $('#trendForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = readTrendForm();
    if (!d) { status('Choose a channel and type a valid window, e.g. from 120n to 1.5u'); return; }
    TR.list.push({ id: TR.nextId++, ...d });
    TR.sel = null;
    renderTrendList(); saveTrends(); computeTrends();
  });

  $('#tUpd').addEventListener('click', () => {
    const d = readTrendForm();
    const def = TR.list.find((x) => x.id === TR.sel);
    if (!d || !def) return;
    Object.assign(def, d);
    renderTrendList(); saveTrends(); computeTrends();
  });

  $('#trendList').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const id = +chip.dataset.id;
    if (e.target.closest('[data-act=del]')) {
      TR.list = TR.list.filter((d) => d.id !== id);
      if (TR.sel === id) TR.sel = null;
      saveTrends(); computeTrends();
    } else {
      TR.sel = TR.sel === id ? null : id;
      if (TR.sel) writeTrendForm(TR.list.find((d) => d.id === id));
    }
    renderTrendList();
  });

  $('#trendSplit').addEventListener('pointerdown', (e) => {
    const sy = e.clientY, h0 = tpanel.getBoundingClientRect().height;
    const max = $('#plotWrap').getBoundingClientRect().height - 80;
    const move = (ev) => { tpanel.style.height = `${Math.max(160, Math.min(max, h0 - (ev.clientY - sy)))}px`; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  });

  // ================================================================ toolbar

  function seg(id, onPick) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      onPick(b.dataset.v);
    });
  }
  const setMode = (m) => {
    plot.mode = m;
    $('#modeSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === m));
  };
  seg('#modeSeg', setMode);
  seg('#moveSeg', (v) => { S.move = v; });
  $('#groupBy').addEventListener('change', (e) => { S.groupBy = e.target.value; rebuild(); });
  $('#btnCursors').addEventListener('click', () => plot.setCursors(!plot.cursors));
  $('#btnFit').addEventListener('click', () => plot.fitAll());
  $('#btnResetShifts').addEventListener('click', () => {
    for (const st of S.ts.values()) st.offset = 0;
    for (const f of S.files) f.offset = 0;
    applyShifts(); renderFiles(); renderTraces();
    status('All time shifts reset to zero');
  });
  $('#btnPng').addEventListener('click', () => {
    $('#plot').toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'tss-view.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
  });
  $('#btnTheme').addEventListener('click', () => {
    document.documentElement.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('tssviewer.theme', document.documentElement.dataset.theme); } catch (_) { /* ignore */ }
    plot.refreshTheme();
    trend.refreshTheme();
    rebuild();
  });
  $('#btnHelp').addEventListener('click', () => $('#help').showModal());

  try {
    const th = localStorage.getItem('tssviewer.theme');
    if (th) { document.documentElement.dataset.theme = th; plot.refreshTheme(); trend.refreshTheme(); }
  } catch (_) { /* ignore */ }

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || $('#help').open || mdlg.open || cdlg.open) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const t = S.selected && S.byId.get(S.selected);
      if (!t) return;
      e.preventDefault();
      let step = t.series.tstep * (e.shiftKey ? 10 : 1);
      if (e.altKey) step = (plot.x1 - plot.x0) / plot._plotRect().w;
      shiftTrace(t, e.key === 'ArrowLeft' ? -step : step);
    } else if (e.key === 'f' || e.key === 'F') plot.fitAll();
    else if (e.key === 'c' || e.key === 'C') plot.setCursors(!plot.cursors);
    else if (e.key === 't' || e.key === 'T') toggleTrends();
    else if (e.key === 'z' || e.key === 'Z') setMode(plot.mode === 'zoom' ? 'pan' : 'zoom');
    else if (e.key === 'Escape') onSelect(null);
  });

  // ================================================================ opening files

  const fromInput = (input) => [...input.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
  $('#pickFiles').addEventListener('change', (e) => { addEntries(fromInput(e.target)); e.target.value = ''; });
  $('#pickFolder').addEventListener('change', (e) => { addEntries(fromInput(e.target), true); e.target.value = ''; });

  if (typeof DecompressionStream === 'undefined') {
    status('This browser lacks DecompressionStream; please use a current Chrome, Edge, Firefox or Safari.', 600000);
  }

  loadMaths();
  loadTrends();
  renderFiles();
  renderTraces();

  // Exposed for debugging from the console.
  window.TSSViewer = { state: S, plot, addEntries };
})();
