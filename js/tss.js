/*
 * Reader for Tektronix .tss captures: a zip of chN.wfm channel files, a (doubly zipped) .set
 * setup file holding the channel labels, a screenshot .png and a manifest.json.
 * Ported from DynamicAnalytic/dpa/tss.py. Channels are decoded lazily, on first use.
 */
'use strict';

const Tss = (() => {
  const LABEL_RE = /:(CH\d+):LABEL:NAME\s+"([^"]*)"/gi;

  const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

  /** Scope labels can carry URL-encoded control characters, e.g. "BLK%0A". */
  function cleanLabel(s) {
    try { s = decodeURIComponent(s); } catch (_) { /* keep as is */ }
    return s.replace(/[\r\n\t]+/g, ' ').trim();
  }

  /** Parse a tss_corrections.txt: lines like "channel:BadName,NewName". */
  function parseCorrections(text) {
    const fixes = {};
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('channel') || !line.includes(',')) continue;
      const [oldName, newName] = line.slice(line.indexOf(':') + 1).split(',', 2).map((x) => x.trim());
      if (oldName) fixes[oldName] = newName;
    }
    return fixes;
  }

  async function readLabels(zip) {
    const setName = zip.names.find((n) => n.toLowerCase().endsWith('.set'));
    if (!setName) return {};
    const outer = await zip.read(setName);
    let text = '';
    try {
      const inner = Zip.open(outer);
      for (const n of inner.names) {
        if (n.toLowerCase().endsWith('.set')) text += new TextDecoder().decode(await inner.read(n));
      }
    } catch (_) {
      text = new TextDecoder().decode(outer);   // plain-text setup file
    }
    const labels = {};
    for (const m of text.matchAll(LABEL_RE)) labels[m[1].toLowerCase()] = cleanLabel(m[2]);
    return labels;
  }

  /**
   * Open a .tss File/Blob. `corrections` is an optional {oldLabel: newLabel} map.
   * Returns a capture object; call loadChannel(ch) to decode a channel's waveform.
   */
  async function open(file, corrections = {}) {
    const zip = Zip.open(await file.arrayBuffer());
    const wfmNames = zip.names.filter((n) => n.toLowerCase().endsWith('.wfm')).sort(natural);
    if (!wfmNames.length) throw new Error('No .wfm channel files inside this .tss');
    const labels = await readLabels(zip);

    const used = new Set();
    const channels = wfmNames.map((entry) => {
      const key = entry.replace(/^.*\//, '').replace(/\.wfm$/i, '').toLowerCase();
      let label = labels[key] || key.toUpperCase();
      label = corrections[label] || label;
      if (used.has(label)) label = `${label} (${key.toUpperCase()})`;
      used.add(label);
      return { key, label, entry, wfm: null, loading: null, error: null };
    });

    const capture = {
      name: file.name,
      channels,
      png: zip.names.find((n) => n.toLowerCase().endsWith('.png')) || null,
      info: null,   // timing summary, filled from the first decoded channel
      async loadChannel(ch) {
        if (ch.wfm) return ch.wfm;
        if (!ch.loading) {
          ch.loading = zip.read(ch.entry).then((buf) => {
            ch.wfm = Wfm.parse(buf);
            if (!capture.info) {
              const w = ch.wfm;
              capture.info = { samples: w.samples, tstep: w.tstep, tstart: w.tstart, frameCount: w.frameCount, frameTimes: w.frameTimes };
            }
            return ch.wfm;
          }).catch((err) => { ch.error = err.message; ch.loading = null; throw err; });
        }
        return ch.loading;
      },
      async screenshot() {
        return capture.png ? new Blob([await zip.read(capture.png)], { type: 'image/png' }) : null;
      },
    };
    // Decode the first channel now so the frame count and timing are known up front.
    await capture.loadChannel(channels[0]);
    return capture;
  }

  return { open, parseCorrections, natural };
})();
