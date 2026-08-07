'use strict';
// ============================================================================
// Tucson / ITRDB chronology reader (.crn) — "standardized site growth indices".
// A JS port of the parse shape of dplR::read.crn.
//
// This is NOT the .rwl decadal layout: a chronology line packs a 3-character
// SAMPLE-DEPTH count after each index value. Per decade line:
//   cols 1-6   site ID
//   cols 7-10  decade year (year of the first of the ten blocks)
//   cols 11-80 ten 7-char blocks of  (4-char index)(3-char sample depth)
// The index is the chronology value x 1000 (so 1000 -> 1.000). The value 9990
// is the ITRDB end/missing marker (padding for the final decade) -> NA.
//
// Output: the shared Frame contract {names:['year', <id>...], cols:[...]}, with
// index values divided back to their fractional form (dimensionless RWI).
// ============================================================================

const NUMRE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
function asNumeric(str) {
  if (str == null) return NaN;
  const t = String(str).trim();
  if (t === '') return NaN;
  return NUMRE.test(t) ? Number(t) : NaN;
}
function isInt(x) { return Number.isFinite(x) && Math.round(x) === x; }
function splitLines(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
function baseNameNoExt(fileName) {
  const b = String(fileName).replace(/\\/g, '/').split('/').pop();
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.substring(0, dot) : b;
}

// A data line has a valid integer year in cols 7-10; anything else (the 3 ITRDB
// header lines, blank/comment lines) is skipped.
function looksLikeDataLine(ln) {
  if (ln.length < 10) return false;
  const y = asNumeric(ln.substring(6, 10));
  return !Number.isNaN(y) && isInt(y) && y >= -12000 && y <= 12000;
}

// readCrn(text, opts) -> Frame  (opts.stopMarker default 9990;
// opts.fileName names a blank-ID series after the file)
function readCrn(text, opts) {
  opts = opts || {};
  const stop = opts.stopMarker != null ? opts.stopMarker : 9990;
  const noIdName = opts.fileName != null ? baseNameNoExt(opts.fileName) : '';

  let lines = splitLines(text).filter(l => l.length > 0);
  lines = lines.filter(l => { const p = l.indexOf('#'); return !(p >= 0 && p <= 77); }); // strip comments
  if (!lines.length) { const e = new Error('crn file is empty'); e.crnError = true; throw e; }

  const dataLines = lines.filter(looksLikeDataLine);
  if (!dataLines.length) { const e = new Error('crn file has no chronology data'); e.crnError = true; throw e; }

  const ids = [];
  const byId = new Map();                 // id -> Map<year, index>
  for (const ln of dataLines) {
    const id = ln.substring(0, 6).trim();
    const year = Math.round(asNumeric(ln.substring(6, 10)));
    if (!byId.has(id)) { byId.set(id, new Map()); ids.push(id); }
    const map = byId.get(id);
    for (let i = 0; i < 10; i++) {
      const base = 10 + i * 7;
      const vStr = ln.substring(base, base + 4);      // 4-char index
      if (vStr.trim() === '') continue;
      const v = asNumeric(vStr);
      if (Number.isNaN(v) || v === stop) continue;    // blank / end marker -> NA
      map.set(year + i, v / 1000);
    }
  }

  // overall span across all series that carry data
  let omin = Infinity, omax = -Infinity;
  for (const id of ids) for (const y of byId.get(id).keys()) { if (y < omin) omin = y; if (y > omax) omax = y; }

  const names = ['year'];
  const cols = [];
  if (!Number.isFinite(omin)) {                       // no usable data
    cols.push([]);
    for (const id of ids) { names.push(id || noIdName); cols.push([]); }
    return { names, cols };
  }
  const years = [];
  for (let y = omin; y <= omax; y++) years.push(y);
  cols.push(years);
  for (const id of ids) {
    const map = byId.get(id);
    names.push(id || noIdName);
    const col = new Array(years.length);
    for (let i = 0; i < years.length; i++) { const y = years[i]; col[i] = map.has(y) ? map.get(y) : null; }
    cols.push(col);
  }
  return { names, cols };
}

module.exports = { readCrn };
