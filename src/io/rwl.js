'use strict';
// Tucson / RWL decadal-format reader & writer -- a JS port of dplR's
// read.rwl/read.tucson and write.rwl/write.tucson (Tucson format only), plus
// ringdater's readRWL wrapper (readRWL_functions.R: readRWL/readWOheader/locateID)
// which adds a header-inference fallback for malformed files.
//
// Data-shape contract: the shared Frame { names:string[], cols:(number|null)[][] }
// (see src/analysis/comb.js). dplR::read.rwl returns a data.frame whose ROWNAMES
// are the years and whose columns are the series; here that becomes a Frame whose
// FIRST column is the years (name "year") and whose remaining columns are the
// named series, NA (null) padded to a common rectangular span.
//
// Scope: the fixed-width Tucson decadal format (the ".rwl" / ".crn"-style layout
// with a per-series stop marker). Precision is mm/100 (0.01mm, prec.rproc=100) or
// mm/1000 (0.001mm, prec.rproc=1000). Other formats (compact/.rwm, TRiDaS/.xml,
// Heidelberg/.fh, csv) are OUT OF SCOPE.

// ---------------------------------------------------------------------------
// small numeric / formatting helpers
// ---------------------------------------------------------------------------

// R as.numeric(): trims surrounding blanks, rejects internal blanks / alpha.
const NUMRE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
function asNumeric(str) {
  if (str == null) return NaN;
  const t = String(str).trim();
  if (t === '') return NaN;
  return NUMRE.test(t) ? Number(t) : NaN;
}
function isInt(x) { return Number.isFinite(x) && Math.round(x) === x; }

// round half to even, like R's round() / C printf %.0f
function rint(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return (f % 2 === 0) ? f : f + 1;
}

// sprintf("%<width>.0f", x): x already (near) integer, right justified, space pad.
function fmtF0(x, width) {
  let s = String(Math.round(x));
  if (s === '-0') s = '0';
  while (s.length < width) s = ' ' + s;
  return s;
}
function padRight(s, width) {
  s = String(s);
  while (s.length < width) s += ' ';
  return s;
}

// ---------------------------------------------------------------------------
// line splitting shared by reader & wrapper
// ---------------------------------------------------------------------------

// Split on any line terminator; mirror readLines() (no trailing empty element).
function splitLines(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// read.tucson header detection (is.head)  -- decides skip.lines (0 or 3)
// ---------------------------------------------------------------------------

function detectHeader(hdr1) {
  if (hdr1.length < 12) {
    const e = new Error('first line in rwl file ends before col 12');
    e.rwlError = true;
    throw e;
  }
  let isHead = false;
  const yrcheck = asNumeric(hdr1.substring(8, 12)); // cols 9-12
  if (Number.isNaN(yrcheck) || yrcheck < -10000 || yrcheck > 10000 || !isInt(yrcheck)) {
    isHead = true;
  }
  if (!isHead) {
    const fields = [];
    for (let k = 0; k < 10; k++) {
      fields.push(hdr1.substring(12 + 6 * k, 18 + 6 * k).replace(/^[ \t]+/, ''));
    }
    let lastGood = -1;
    for (let k = 0; k < 10; k++) if (fields[k].length) lastGood = k;
    if (lastGood < 0) {
      isHead = true;
    } else {
      const dc = fields.slice(0, lastGood + 1);
      if (dc.some(f => /[A-Za-z]/.test(f))) {
        isHead = true;
      } else {
        for (const f of dc) {
          if (f.length) { const n = asNumeric(f); if (!Number.isNaN(n) && !isInt(n)) { isHead = true; break; } }
        }
      }
    }
  }
  // second-chance: a "1 2 3"-style numeric header line is really data
  if (isHead) {
    const parts = hdr1.trim().split(/\s+/);
    if (parts.length >= 3 && parts.length <= 13) {
      const rest = parts.slice(1);
      if (!rest.some(p => /[A-Za-z]/.test(p))) {
        const nums = rest.map(asNumeric);
        if (!nums.some(n => !Number.isNaN(n) && !isInt(n))) isHead = false;
      }
    }
  }
  return isHead;
}

// ---------------------------------------------------------------------------
// readRwl(text, opts) -> Frame  (port of dplR::read.rwl / read.tucson, Tucson)
// ---------------------------------------------------------------------------
//
// opts: { header: boolean|null (force header on/off; default null=auto),
//         edgeZeros: boolean (default true) }
function readRwl(text, opts) {
  opts = opts || {};
  const edgeZeros = opts.edgeZeros !== false;

  // drop empty lines, then comment lines (first '#' within cols 1..78)
  let lines = splitLines(text).filter(l => l.length > 0);
  lines = lines.filter(l => { const p = l.indexOf('#'); return !(p >= 0 && p <= 77); });
  if (lines.length === 0) { const e = new Error('file is empty'); e.rwlError = true; throw e; }

  let isHead;
  if (opts.header == null) isHead = detectHeader(lines[0]);
  else isHead = !!opts.header;
  const skip = isHead ? 3 : 0;
  const dataLines = lines.slice(skip);
  if (dataLines.length === 0) { const e = new Error('file has no data'); e.rwlError = true; throw e; }

  // fixed-width parse: id cols1-8, year cols9-12, then up to 11 value fields (6 wide)
  const rows = [];
  for (const ln of dataLines) {
    const year = asNumeric(ln.substring(8, 12));
    if (Number.isNaN(year)) continue;            // dplR drops rows with NA year
    if (!isInt(year)) { const e = new Error('non-integral numbers found'); e.rwlError = true; throw e; }
    const id = ln.substring(0, 8).trim();
    const vals = [];
    for (let k = 0; k < 11; k++) {
      const f = ln.substring(12 + 6 * k, 18 + 6 * k).trim();
      if (f === '') { vals.push(null); continue; }
      const v = asNumeric(f);
      if (Number.isNaN(v)) { const e = new Error('failed to read rwl file'); e.rwlError = true; throw e; }
      if (!isInt(v)) { const e = new Error('non-integral numbers found'); e.rwlError = true; throw e; }
      vals.push(v);
    }
    rows.push({ id, year: Math.round(year), vals });
  }
  if (rows.length === 0) { const e = new Error('file has no data'); e.rwlError = true; throw e; }

  // prescale (edge.zeros): negatives except -9999 -> NA
  for (const r of rows) {
    for (let k = 0; k < r.vals.length; k++) {
      const v = r.vals[k];
      if (v == null) continue;
      if (edgeZeros) { if (v < 0 && v !== -9999) r.vals[k] = null; }
      else { if (v <= 0 && v !== -9999) r.vals[k] = null; }
    }
  }

  // group by series id (first-appearance order)
  const ids = [];
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) { byId.set(r.id, []); ids.push(r.id); }
    byId.get(r.id).push(r);
  }

  const series = [];   // { id, map:Map<year,value>, min, max }
  for (const id of ids) {
    const srows = byId.get(id);
    // precision: -9999 present anywhere -> 0.001 (prec.rproc 1000), else 0.01 (100)
    let prec = 100;
    for (const r of srows) for (const v of r.vals) if (v === -9999) { prec = 1000; break; }
    const map = new Map();
    for (const r of srows) {
      for (let k = 0; k < r.vals.length; k++) {
        let v = r.vals[k];
        if (v == null) continue;
        if (prec === 100 && v === 999) continue;    // stop marker / no-data
        if (prec === 1000 && v === -9999) continue; // stop marker
        map.set(r.year + k, v / prec);
      }
    }
    let min = Infinity, max = -Infinity;
    for (const y of map.keys()) { if (y < min) min = y; if (y > max) max = y; }
    series.push({ id, map, min: map.size ? min : null, max: map.size ? max : null });
  }

  // overall span from series that have data
  let omin = Infinity, omax = -Infinity;
  for (const s of series) if (s.min != null) { if (s.min < omin) omin = s.min; if (s.max > omax) omax = s.max; }

  const names = ['year'];
  const cols = [];
  if (!Number.isFinite(omin)) {                    // no good data anywhere
    cols.push([]);
    for (const s of series) { names.push(s.id); cols.push([]); }
    return { names, cols };
  }
  const years = [];
  for (let y = omin; y <= omax; y++) years.push(y);
  cols.push(years);
  for (const s of series) {
    names.push(s.id);
    const col = new Array(years.length);
    for (let i = 0; i < years.length; i++) {
      const y = years[i];
      if (s.min == null || y < s.min || y > s.max) col[i] = null;      // outside span
      else col[i] = s.map.has(y) ? s.map.get(y) : 0;                   // internal gap -> 0
    }
    cols.push(col);
  }
  return { names, cols };
}

// ---------------------------------------------------------------------------
// writeRwl(frame, opts) -> string  (port of dplR::write.rwl / write.tucson)
// ---------------------------------------------------------------------------
//
// opts: { precision: 0.01 | 0.001 (default 0.01) }
// Frame: first column = years, remaining columns = named series.
// Emits the standard Tucson layout (long.names=FALSE): 6-char id, 1 space,
// 5-char year, then six-wide values; CRLF line terminator, per-series stop marker.
function writeRwl(frame, opts) {
  opts = opts || {};
  const prec = opts.precision != null ? opts.precision : 0.01;
  if (!(prec === 0.01 || prec === 0.001)) {
    throw new Error("'precision' must equal 0.01 or 0.001");
  }
  const lineTerm = '\r\n';

  // year column + series columns
  const yearsRaw = frame.cols[0].map(v => Math.round(Number(v)));
  const seriesNames = frame.names.slice(1);
  const seriesCols = frame.cols.slice(1);
  const nrow = yearsRaw.length;

  // sort rows by year ascending (stable)
  const order = yearsRaw.map((_, i) => i).sort((a, b) => yearsRaw[a] - yearsRaw[b] || a - b);
  const years = order.map(i => yearsRaw[i]);

  // precision-dependent markers (matches write.tucson)
  let naStr, missingStr, procR;
  if (prec === 0.01) { naStr = 9.99; missingStr = -9.99; procR = 100; }
  else { naStr = -9.999; missingStr = 0; procR = 1000; }

  const nameWidth = 6, optSpace = ' ', yearWidth = 5;
  const colNames = fixNames(seriesNames, nameWidth);

  let out = '';
  for (let l = 0; l < seriesCols.length; l++) {
    const raw = order.map(i => seriesCols[l][i]);
    // keep present values with their years
    let yrs = [], ser = [];
    for (let i = 0; i < nrow; i++) {
      if (raw[i] != null && !(typeof raw[i] === 'number' && Number.isNaN(raw[i]))) {
        yrs.push(years[i]); ser.push(Number(raw[i]));
      }
    }
    if (ser.length === 0) continue;                // all-NA column: nothing written
    // append the stop marker one year past the last
    const lastYr = yrs[yrs.length - 1];
    ser.push(naStr);
    yrs.push(lastYr + 1);

    const decVec = yrs.map(y => Math.floor(y / 10) * 10);
    const decMin = Math.min(...decVec), decMax = Math.max(...decVec);
    const decades = [];
    for (let d = decMin; d <= decMax; d += 10) decades.push(d);
    const nDec = decades.length;
    const name6 = padRight(colNames[l], nameWidth);

    for (let i = 0; i < nDec; i++) {
      const dec = decades[i];
      let decYrs = [], decRwl = [];
      for (let j = 0; j < yrs.length; j++) if (decVec[j] === dec) { decYrs.push(yrs[j]); decRwl.push(ser[j]); }

      // negatives -> missing marker (never the 0.001 terminator on the last decade)
      for (let j = 0; j < decRwl.length; j++) {
        let neg = decRwl[j] < 0;
        if (prec === 0.001 && i === nDec - 1 && j === decRwl.length - 1) neg = false;
        if (neg) decRwl[j] = missingStr;
      }

      // fill in the missing years of the decade with the missing marker
      let allYears;
      if (nDec === 1) allYears = range(decYrs[0], decYrs[decYrs.length - 1]);
      else if (i === 0) allYears = range(decYrs[0], dec + 9);
      else if (i === nDec - 1) allYears = range(dec, decYrs[decYrs.length - 1]);
      else allYears = range(dec, dec + 9);
      if (allYears.length > decYrs.length) {
        const have = new Set(decYrs);
        for (const y of allYears) if (!have.has(y)) { decYrs.push(y); decRwl.push(missingStr); }
        const ord = decYrs.map((_, j) => j).sort((a, b) => decYrs[a] - decYrs[b]);
        decYrs = ord.map(j => decYrs[j]);
        decRwl = ord.map(j => decRwl[j]);
      }

      const decYear1 = fmtF0(decYrs[0], yearWidth);
      let ints = decRwl.map(v => rint(v * procR));
      if (prec === 0.01) {                          // avoid the 999 stop-marker value mid-series
        for (let j = 0; j < ints.length; j++) {
          const isLast = i === nDec - 1 && j === ints.length - 1;
          if (ints[j] === 999 && !isLast) ints[j] = 998; // R samples {998,1000}; deterministic 998
        }
      }
      const body = ints.map(v => fmtF0(v, 6)).join('');
      out += name6 + optSpace + decYear1 + body + lineTerm;
    }
  }
  return out;
}

function range(a, b) { const r = []; for (let y = a; y <= b; y++) r.push(y); return r; }

// dplR fix.names (basic path): strip chars outside [A-Za-z0-9], truncate to `limit`.
// Full duplicate-renaming / mapping-file logic is out of scope; unique clean names
// (the common case, and everything write.tucson round-trips) are handled exactly.
function fixNames(x, limit) {
  const cut = x.map(s => String(s).replace(/[^A-Za-z0-9]/g, ''));
  const trimmed = cut.map(s => (s.length > limit ? s.substring(0, limit) : s));
  return trimmed;
}

// ---------------------------------------------------------------------------
// ringdater wrapper: readRWL / readWOheader / locateID (readRWL_functions.R)
// ---------------------------------------------------------------------------

// getMode: most frequent value; on ties, the first to appear (mirrors R's
// unique(x)[findMode==max] taking the first).
function getMode(arr) {
  const seen = [];
  const count = new Map();
  for (const v of arr) { if (!count.has(v)) { seen.push(v); count.set(v, 0); } count.set(v, count.get(v) + 1); }
  let best = -1, bestVal = null;
  for (const v of seen) { const c = count.get(v); if (c > best) { best = c; bestVal = v; } }
  return bestVal;
}

// locateID: infer the first sample ID by statistical mode of first-word lengths
// and the shared site tag, then find that word in the file.
function locateID(text) {
  const lines = splitLines(text);
  const sampName = lines.map(l => l.toLowerCase().replace(/ .*/s, ''));
  const sampLen = sampName.map(s => s.length);
  const nameLen = getMode(sampLen);
  const nameTrunc = sampName.filter((_, i) => sampLen[i] === nameLen);

  const let1 = [];
  for (let i = 0; i < 6; i++) {
    const chars = nameTrunc.map(s => (i < s.length ? s[i] : ''));
    const m = getMode(chars);
    if (!(chars.filter(c => c === m).length === nameTrunc.length)) break; // not shared by all
    let1.push(m);
  }
  const siteID = let1.join('');

  for (const line of lines) {
    const words = line.toLowerCase().split(' ');
    for (const w of words) {
      if (w.length === nameLen && w.substring(0, let1.length) === siteID) return w;
    }
  }
  return undefined;
}

// readWOheader: strip header lines preceding the first sample ID, fix the leading
// junk on that first line, then re-read as Tucson.
function readWOheader(text, startPT, opts) {
  // read.table(sep="#"): comment.char '#' means col1 = text before first '#'
  let rows = splitLines(text).map(l => l.split('#')[0]).filter(l => l.length > 0);
  let found = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].toLowerCase().indexOf(startPT) >= 0) { found = i; break; }
  }
  rows = rows.slice(found);
  // strip everything before the sample ID on the first retained line
  const idx = rows[0].toLowerCase().indexOf(startPT);
  if (idx > 0) rows[0] = rows[0].substring(idx);
  return readRwl(rows.join('\n'), opts);
}

// extension -> dplR format (only 'tucson' is supported here)
const EXT_FMT = [
  ['.csv', 'csv'], ['.tuc', 'tucson'], ['.dec', 'tucson'], ['.crn', 'tucson'],
  ['.rwl', 'tucson'], ['.xml', 'tridas'], ['.fh', 'heidelberg'], ['.rwm', 'compact'],
];
function formatFromName(fileName) {
  const n = String(fileName).toLowerCase();
  for (const [ext, fmt] of EXT_FMT) if (n.indexOf(ext) >= 0) return fmt;
  return 'tucson';
}

// readRWL(text, opts) -> Frame : ringdater's robust loader. Tries the Tucson
// reader; on failure falls back to header inference (locateID + readWOheader).
// opts: { format (default derived from opts.fileName, else 'tucson'),
//         fileName, edgeZeros }
function readRWL(text, opts) {
  opts = opts || {};
  const format = opts.format || (opts.fileName ? formatFromName(opts.fileName) : 'tucson');
  const readOpts = { edgeZeros: opts.edgeZeros };
  try {
    return readRwl(text, readOpts);
  } catch (e) {
    if (format !== 'tucson') {
      throw new Error("Sorry, can't read this file. We recommend csv or tucson format.\n");
    }
    const startPT = locateID(text);
    return readWOheader(text, startPT, readOpts);
  }
}

module.exports = { readRwl, writeRwl, readRWL, locateID, readWOheader, fixNames };
