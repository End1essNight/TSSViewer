/*
 * Tektronix WFM (version 3, little-endian) reader, ported from DynamicAnalytic/dpa/tekwfm.py.
 * Reference: Tektronix "Performance Oscilloscope Reference Waveform File Format" 077-0220-10.
 *
 * Samples are kept in their raw integer form (Int16Array etc.) together with vscale/voffset;
 * volts = raw * vscale + voffset. This halves memory compared with storing floats.
 */
'use strict';

const Wfm = (() => {
  const HEADER = 838;
  const FF_REC = 24;   // packed fast-frame update spec: i4 n, f8 tstep_offset, f8 frac_sec, i4 gmt_sec

  function ascii(u8, off, n) {
    let s = '';
    for (let i = off; i < off + n && u8[i] !== 0; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  function parse(buffer) {
    if (buffer.byteLength < HEADER) throw new Error('WFM file shorter than its 838-byte header');
    const dv = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const LE = true;

    if (dv.getUint16(0, LE) !== 0x0f0f) throw new Error('Big-endian WFM files are not supported');
    const version = ascii(u8, 2, 8);
    if (version !== ':WFM#003') throw new Error(`Only WFM version 3 is supported (got "${version}")`);
    if (dv.getUint32(114, LE) !== 1) throw new Error('WFM implicit dimension count is not 1');
    if (dv.getUint32(118, LE) !== 1) throw new Error('WFM explicit dimension count is not 1');
    if (dv.getUint32(122, LE) !== 2) throw new Error('WFM record is not WFMDATA_VECTOR');
    if (dv.getUint32(244, LE) !== 0) throw new Error('WFM explicit dimension is not EXPLICIT_SAMPLE');
    if (dv.getUint32(768, LE) !== 0) throw new Error('WFM time base is not BASE_TIME');

    const bps = dv.getInt8(15);
    const curveOffset = dv.getInt32(16, LE);
    const label = ascii(u8, 40, 32);
    const summaryFrame = dv.getInt16(154, LE);
    const nRaw = dv.getUint32(72, LE) + 1;
    const frameCount = summaryFrame === 1 ? nRaw - 1 : nRaw;
    const vscale = dv.getFloat64(168, LE);
    const voffset = dv.getFloat64(176, LE);
    const units = ascii(u8, 276, 20);
    const tstep = dv.getFloat64(488, LE);
    const tstart = dv.getFloat64(496, LE);
    const gmtFrac0 = dv.getFloat64(796, LE);
    const gmtSec0 = dv.getUint32(804, LE);
    const dpre = dv.getUint32(822, LE);
    const dpost = dv.getUint32(826, LE);
    const allbytes = dv.getUint32(830, LE);
    const code = dv.getInt32(240, LE);

    let Ctor;
    if (code === 7 && bps === 1) Ctor = Int8Array;
    else if (code === 0 && bps === 2) Ctor = Int16Array;
    else if (code === 4 && bps === 4) Ctor = Float32Array;
    else throw new Error(`WFM data type code ${code} with ${bps} bytes/sample not understood`);

    const samples = (dpost - dpre) / bps;
    const curveBytes = frameCount * allbytes;
    if (curveOffset + curveBytes > buffer.byteLength) throw new Error('WFM file is truncated');

    // Typed arrays need aligned offsets; copy the curve block once if it is not aligned.
    let base = buffer, baseOff = curveOffset;
    if (curveOffset % bps !== 0) { base = buffer.slice(curveOffset, curveOffset + curveBytes); baseOff = 0; }
    const frames = [];
    for (let f = 0; f < frameCount; f++) {
      frames.push(new Ctor(base, baseOff + f * allbytes + dpre, samples));
    }

    // Trigger time of every frame relative to the first (FastFrame).
    const frameTimes = new Float64Array(frameCount);
    for (let k = 1; k < frameCount; k++) {
      const o = HEADER + (k - 1) * FF_REC;
      if (o + FF_REC > buffer.byteLength) break;
      const frac = dv.getFloat64(o + 12, LE);
      const sec = dv.getInt32(o + 20, LE);
      frameTimes[k] = (sec - gmtSec0) + (frac - gmtFrac0);
    }

    return {
      label, units, tstart, tstep, samples, frameCount, vscale, voffset, frames, frameTimes,
      triggerTime: gmtSec0 + gmtFrac0,
    };
  }

  return { parse };
})();
