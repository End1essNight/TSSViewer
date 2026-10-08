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
    files: [],              // file records, see addEntries()
    nextId: 1,
    corrections: new Map(), // folder path -> {oldLabel: newLabel}
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

  /** items: [{file: File, path: 'folder/sub/name.tss'}] */
  async function addEntries(items) {
    const tss = [], txt = [];
    for (const it of items) {
      const n = it.file.name.toLowerCase();
      if (n.endsWith('.tss')) tss.push(it);
      else if (n === 'tss_corrections.txt') txt.push(it);
    }
    for (const it of txt) S.corrections.set(dirOf(it.path), Tss.parseCorrections(await it.file.text()));
    if (!tss.length) { if (!txt.length) status('No .tss files found in the selection'); else status('Channel corrections loaded'); return; }

    tss.sort((a, b) => Tss.natural(a.path, b.path));
    const added = [];
    for (const it of tss) {
      const dup = S.files.some((f) => f.path === it.path && f.blob.size === it.file.size && f.blob.lastModified === it.file.lastModified);
      if (dup) continue;
      const rec = {
        id: S.nextId++, name: it.file.name, alias: stem(it.file.name), path: it.path, dir: dirOf(it.path),
        blob: it.file, cap: null, status: 'idle', error: null,
        offset: 0, selCh: new Set(), selFrames: new Set([0]), open: false,
      };
      S.files.push(rec);
      added.push(rec);
    }
    if (added.length > AUTO_LOAD_MAX) status(`${added.length} files listed. Click a file to load it.`, 8000);
    renderFiles();
    rebuild();
    if (added.length <= AUTO_LOAD_MAX) for (const rec of added) await loadFile(rec);
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

  function removeFile(rec) {
    S.files = S.files.filter((f) => f !== rec);
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
    let h = `<div class="section-h"><span>Files (${S.files.length})</span>${S.files.length ? '<button class="btn small" data-act="clear">Close all</button>' : ''}</div>`;
    if (!S.files.length) {
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
    if (S.files.length > 6) h += '<input type="text" class="filter" placeholder="Filter files…" spellcheck="false">';
    for (const rec of S.files) h += fileCard(rec);
    host.innerHTML = h;
    applyFilter();
  }

  function fileCard(rec) {
    let h = `<div class="file${rec.status === 'ready' ? '' : ' unloaded'}" data-id="${rec.id}" data-path="${esc(rec.path.toLowerCase())}">
      <div class="fhead" data-act="toggle">
        <span class="caret">${rec.open ? '▼' : '▶'}</span>
        <span class="fname" title="${esc(rec.path)}">${esc(rec.alias)}${rec.dir ? `<span class="fdir">${esc(rec.dir)}</span>` : ''}</span>
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
      h += '</div>';
    }
    return h + '</div>';
  }

  function applyFilter() {
    const box = $('#files .filter');
    const q = (box ? box.value : '').trim().toLowerCase();
    document.querySelectorAll('#files .file').forEach((el) => { el.hidden = q !== '' && !el.dataset.path.includes(q); });
  }

  const recById = (id) => S.files.find((f) => f.id === +id);

  $('#files').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const card = el.closest('.file');
    const rec = card && recById(card.dataset.id);
    const act = el.dataset.act;
    if (act === 'clear') {
      S.files = []; S.ts.clear(); S.selected = null;
      renderFiles(); rebuild(); return;
    }
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
    rebuild();
  });
  $('#btnHelp').addEventListener('click', () => $('#help').showModal());

  try {
    const th = localStorage.getItem('tssviewer.theme');
    if (th) { document.documentElement.dataset.theme = th; plot.refreshTheme(); }
  } catch (_) { /* ignore */ }

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || $('#help').open || mdlg.open) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const t = S.selected && S.byId.get(S.selected);
      if (!t) return;
      e.preventDefault();
      let step = t.series.tstep * (e.shiftKey ? 10 : 1);
      if (e.altKey) step = (plot.x1 - plot.x0) / plot._plotRect().w;
      shiftTrace(t, e.key === 'ArrowLeft' ? -step : step);
    } else if (e.key === 'f' || e.key === 'F') plot.fitAll();
    else if (e.key === 'c' || e.key === 'C') plot.setCursors(!plot.cursors);
    else if (e.key === 'z' || e.key === 'Z') setMode(plot.mode === 'zoom' ? 'pan' : 'zoom');
    else if (e.key === 'Escape') onSelect(null);
  });

  // ================================================================ opening files

  const fromInput = (input) => [...input.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
  $('#pickFiles').addEventListener('change', (e) => { addEntries(fromInput(e.target)); e.target.value = ''; });
  $('#pickFolder').addEventListener('change', (e) => { addEntries(fromInput(e.target)); e.target.value = ''; });

  if (typeof DecompressionStream === 'undefined') {
    status('This browser lacks DecompressionStream; please use a current Chrome, Edge, Firefox or Safari.', 600000);
  }

  loadMaths();
  renderFiles();
  renderTraces();

  // Exposed for debugging from the console.
  window.TSSViewer = { state: S, plot, addEntries };
})();
