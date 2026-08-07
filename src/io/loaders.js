'use strict';
// ============================================================================
// T2.1c  Data loaders  (ports of the ringdater load_* functions)
// ----------------------------------------------------------------------------
//   loadUndated    <- load_undated       (load_undated_function.R)
//   loadChron      <- load_chron         (load_chron_function.R)
//   loadDataTabs   <- load_data_tabs     (load_data_tabs_function.R)
//   ldUndatedChron <- ld_undated_chron   (ld_undated_chron_function.R)
//
// Each returns the shared `Frame` (../analysis/comb.js): ordered named columns,
// first column = year/increment, remaining columns = named series, missing=null.
//
// FILE INPUTS. R's loaders take file *paths*; to stay dependency-free and
// browser-friendly these take file *descriptors*:
//     { name: 'x.csv', text?: string, buffer?: Buffer }
// The extension is sniffed from the last 3 characters of `name` (as in R's
// substr(x, nchar-2, nchar)). csv/txt read `text`; xlsx reads `buffer`.
//
// PLUGGABLE READERS. The pos / lps / rwl branches are owned by another agent;
// pass them in as `opts.readers = { pos, lps, rwl }` (each a function of the
// file descriptor returning a Frame). If absent, those branches throw a clear
// "not implemented" error. The csv/txt/xlsx branches are fully implemented.
//
// R-4 NOTE. Under R >= 4.0, read.csv defaults stringsAsFactors = FALSE, so
// load_undated's "reload the txt if column 1 is a factor" branch can never fire.
// It is intentionally omitted here (documented dead code), matching the oracle.
// ============================================================================

const C = require('../analysis/comb');
const { nameCheckUnique, makeUnique } = require('../analysis/checks');
const { parseDelimited } = require('./csv');
const { readXlsx } = require('./xlsx');
const { normalise } = require('../detrend/normalise');

// ---- small helpers ----------------------------------------------------------
const EMPTY = { names: [], cols: [] };
function ext3(name) { return String(name).slice(-3); }
function basename(name) { return String(name).replace(/\\/g, '/').split('/').pop(); }
function dropCol0(f) { return { names: f.names.slice(1), cols: f.cols.slice(1) }; }
function seqFrom(start, n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = start + i; return a; }
function seq1(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = i + 1; return a; }
function lowerSpace(names) { return names.map(s => String(s).replace(/\s/g, '_').toLowerCase()); }
function needReader(readers, kind) {
  const fn = readers && readers[kind];
  if (typeof fn !== 'function') {
    throw new Error('loaders: ' + kind + ' reader not provided (inject opts.readers.' + kind + ')');
  }
  return fn;
}

// Series names must always be unique; when a loader had to invent a name to
// break a collision, tell the user which. The messages ride on the returned
// frame as a NON-ENUMERABLE `warnings` array so the Frame data contract
// ({names, cols}) and its serialisations are untouched.
function attachRenameWarnings(frame, renames) {
  if (!renames || !renames.length) return frame;
  const msgs = renames.map(r =>
    'Series name "' + r.from + '" was not unique; renamed to "' + r.to + '".');
  Object.defineProperty(frame, 'warnings', {
    value: msgs, enumerable: false, writable: true, configurable: true,
  });
  return frame;
}
// nameCheckUnique + warnings in one step (the common loader epilogue).
function checkNamesWarn(frame) {
  const res = nameCheckUnique(frame);
  return attachRenameWarnings(res.frame, res.renames);
}

// ---- Tukey's biweight robust mean (dplR::tbrm, C = 9) & chron std -----------
// Faithful reproduction of dplR's compiled tbrm: median-centred, weighted by the
// biweight of deviations scaled by C*mad + 1e-6 (the +1e-6 keeps a zero-MAD /
// constant column finite and rejects outliers). Validated to ~1e-15 vs R.
function tbrm(values, Cc) {
  const x = values.filter(v => v != null && !Number.isNaN(v));
  const n = x.length;
  if (n === 0) return null;      // tbrm(numeric(0)) -> NaN -> NA
  if (n === 1) return x[0];
  const m = median(x);
  const dev = x.map(v => Math.abs(v - m));
  const s = median(dev);
  const cs = Cc * s + 1e-6;
  let num = 0, den = 0;
  for (const v of x) {
    const u = (v - m) / cs;
    if (Math.abs(u) < 1) { const w = (1 - u * u) * (1 - u * u); num += w * (v - m); den += w; }
  }
  return den === 0 ? m : m + num / den;
}
function median(a) {
  const s = a.slice().sort((p, q) => p - q);
  const n = s.length, h = n >> 1;
  return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
// dplR::chron(x, biweight = TRUE) "std" column: row-wise tbrm across series.
function chronStd(frame) {
  const nr = C.nrow(frame), nc = C.ncol(frame);
  const out = new Array(nr);
  for (let r = 0; r < nr; r++) {
    const row = [];
    for (let c = 0; c < nc; c++) row.push(frame.cols[c][r]);
    out[r] = tbrm(row, 9);
  }
  return out;
}

// ---- check_load_ringmeasurer_data ------------------------------------------
// Guard + transform for RingMeasurer CSVs. On the shipped fixtures the guard
// always returns the data unchanged (no key columns), which is all that is
// exercised/validated. The RM transform below is a faithful port but is
// UNVALIDATED (no RingMeasurer fixture is available).
function checkLoadRingmeasurer(frame, avgSeries) {
  const key = ['sample_ID', 'x1', 'y1', 'x2', 'y2', 'series'];
  if (!key.every(k => frame.names.indexOf(k) >= 0)) return frame; // not an RM file
  // --- RM transform (unvalidated) ---
  const byName = n => C.colByName(frame, n);
  const sampleID = byName('sample_ID').map(v => String(v).replace(/\s/g, '_').toLowerCase());
  const ID = sampleID[0];
  const seriesCol = byName('series');
  const label = byName('label_text') || [];
  const absDist = byName('abs_distance') || [];
  const pick = tag => {
    const idx = [];
    for (let r = 0; r < seriesCol.length; r++) if (seriesCol[r] === tag) idx.push(r);
    idx.sort((a, b) => (label[a] < label[b] ? -1 : label[a] > label[b] ? 1 : 0));
    return idx.map(r => absDist[r]);
  };
  const s1 = pick('series_1'), s2 = pick('series_2'), s3 = pick('series_3');
  const lens = [s1.length, s2.length, s3.length];
  const maxLen = Math.max(...lens);
  const year = seq1(maxLen);
  const seriesVals = [s1, s2, s3];
  let names = ['year', ID + '_series_1', ID + '_series_2', ID + '_series_3'];
  let cols = [year, pad(s1, maxLen), pad(s2, maxLen), pad(s3, maxLen)];
  const keep = [0]; for (let i = 0; i < 3; i++) if (lens[i] > 0) keep.push(i + 1);
  names = keep.map(i => names[i]); cols = keep.map(i => cols[i]);
  let out = { names, cols };
  if (avgSeries) {
    const means = C.rowMeans({ names: out.names.slice(1), cols: out.cols.slice(1) }, { naRm: true });
    out = { names: ['years', ID], cols: [seq1(means.length), means] };
  }
  return out;
}
function pad(a, n) { return a.length < n ? a.concat(Array(n - a.length).fill(null)) : a.slice(); }

// ============================================================================
// load_undated
// ============================================================================
function loadUndated(files, opts = {}) {
  const col1 = opts.col1 != null ? opts.col1 : 'ring';
  const avgSer = opts.avgSer !== undefined ? opts.avgSer : true;
  const readers = opts.readers || {};
  const applyYrs = opts.applyYrs || false;
  const list = Array.isArray(files) ? files : [files];
  const ACC = ['txt', 'pos', 'csv', 'lsx', 'rwl', 'lps'];

  let undated = null;
  for (let k = 0; k < list.length; k++) {
    const file = list[k];
    const ftype = ext3(file.name);
    if (ACC.indexOf(ftype) < 0) {
      throw new Error('Error in load_undated. File was unsupported file type.\nProblem file: ' + file.name);
    }
    let series = file.seriesName != null ? file.seriesName : basename(file.name);
    let loading;

    if (ftype === 'txt') {
      loading = parseDelimited(file.text, { sep: '\t', header: false });
      // (R-4: column 1 is never a factor, so no header-reload -- see file header)
      if (C.ncol(loading) === 2) {
        loading = C.completeCases(loading);
        series = series.replace(/.txt/g, '');            // R: gsub(".txt", "") ('.' = any char)
        loading = C.setNames(loading, [col1, series]);
      }
    } else if (ftype === 'csv') {
      const tmp = parseDelimited(file.text, { sep: ',', header: true, checkNames: false });
      loading = checkLoadRingmeasurer(tmp, avgSer);
    } else if (ftype === 'lsx') {
      loading = readXlsx(file.buffer, { na: 'NA' });
    } else if (ftype === 'pos') {
      loading = needReader(readers, 'pos')(file);
      series = series.replace(/.pos/g, '');
      loading = C.setNames(loading, [col1, series]);
    } else if (ftype === 'lps') {
      series = series.replace(/.lps/g, '');
      loading = needReader(readers, 'lps')({ series, file });
    } else if (ftype === 'rwl') {
      loading = needReader(readers, 'rwl')(file); // hook returns increment-col + series
    }

    if (undated === null || C.ncol(undated) < 2) {
      undated = dropCol0(C.combNA(EMPTY, loading));       // first file -> == loading
    } else {
      const oldNames = C.names(undated);
      const newNames = C.names(loading).slice(1);
      if (!applyYrs) {
        undated = C.combNA(undated, dropCol0(loading));
      } else {
        // year-aligned append; owned elsewhere (align_undated_load).
        undated = needReader(readers, 'alignUndatedLoad')(undated, loading);
      }
      undated = C.setNames(undated, oldNames.concat(newNames));
    }
    undated = C.setNames(undated, lowerSpace(C.names(undated)));
    undated.names[0] = col1;
  }

  // reset the increment column to a continuous run from its first value
  const nr = C.nrow(undated);
  undated = { names: undated.names.slice(), cols: undated.cols.slice() };
  undated.cols[0] = seqFrom(undated.cols[0][0], nr);
  return checkNamesWarn(undated);
}

// ============================================================================
// load_chron
// ============================================================================
function loadChron(file, opts = {}) {
  const readers = opts.readers || {};
  const ftype = ext3(file.name);
  const ACC = ['rwl', 'crn', 'csv', 'lsx', 'txt'];
  if (ACC.indexOf(ftype) < 0) {
    throw new Error('Error in load_chron: File type is not supported\nProblem file: ' + file.name);
  }
  let df;
  if (ftype === 'rwl') {
    df = needReader(readers, 'rwl')(file);
  } else if (ftype === 'crn') {
    df = needReader(readers, 'crn')(file);       // ITRDB/Tucson standardized chronology
  } else if (ftype === 'csv') {
    df = parseDelimited(file.text, { sep: ',', header: true, checkNames: true });
  } else if (ftype === 'lsx') {
    df = readXlsx(file.buffer, { na: 'NA' });
  } else if (ftype === 'txt') {
    // R passes sep = "/t" (a genuine upstream bug): read.table rejects a 2-byte
    // separator, so this branch errors in R too. Reproduced faithfully.
    df = parseDelimited(file.text, { sep: '/t', header: true, checkNames: true });
  }
  return checkNamesWarn(df);
}

// ============================================================================
// load_data_tabs  -- per-series summary table
// Returns a Frame whose first column is character (series names). Row order and
// the dropped first (year-vs-year) row match R's data.frame(...)[-1, ].
// ============================================================================
function loadDataTabs(frame) {
  if (!frame || !Array.isArray(frame.names) || !Array.isArray(frame.cols)) {
    throw new Error('Error in load_data_tabs: the_Data is not a valid data.frame');
  }
  const year = frame.cols[0];
  const nc = C.ncol(frame);
  const serName = [], early = [], late = [], length = [], mean = [], sdev = [];
  for (let i = 0; i < nc; i++) {
    const series = frame.cols[i];
    const yy = [], vv = [];
    for (let r = 0; r < series.length; r++) {
      if (!C.isNA(year[r]) && !C.isNA(series[r])) { yy.push(year[r]); vv.push(series[r]); }
    }
    serName.push(frame.names[i]);
    const mn = Math.min(...yy), mx = Math.max(...yy);
    early.push(mn); late.push(mx); length.push(mx - mn + 1);
    mean.push(vmean(vv)); sdev.push(vsd(vv));
  }
  // drop row 1 (the year column summarised against itself)
  const keep = (a) => a.slice(1);
  return {
    names: ['Series Name', 'First ring', 'Last ring', 'series length', 'Series mean', 'Series St. dev.'],
    cols: [keep(serName), keep(early), keep(late), keep(length), keep(mean), keep(sdev)],
  };
}
function vmean(a) { let s = 0; for (const v of a) s += v; return a.length ? s / a.length : null; }
function vsd(a) { // sample sd (n-1), matching stats::sd
  const n = a.length; if (n < 2) return null;
  const m = vmean(a); let s = 0; for (const v of a) s += (v - m) * (v - m);
  return Math.sqrt(s / (n - 1));
}

// ============================================================================
// ld_undated_chron  -- mean chronology per file (biweight), optional detrend
// ============================================================================
function ldUndatedChron(files, opts = {}) {
  const pairDetrend = opts.pairDetrend || false;
  const detrendingSelect = opts.detrendingSelect !== undefined ? opts.detrendingSelect : 3;
  const splineWindow = opts.splineWindow !== undefined ? opts.splineWindow : 21;
  const readers = opts.readers || {};
  const list = Array.isArray(files) ? files : [files];

  let undated = null;
  for (let k = 0; k < list.length; k++) {
    const file = list[k];
    const ftype = ext3(file.name);
    let series = file.seriesName != null ? file.seriesName : basename(file.name);
    let theData;
    if (ftype === 'rwl') {
      theData = needReader(readers, 'rwl')(file); series = series.replace(/.rwl/g, '');
    } else if (ftype === 'csv') {
      theData = parseDelimited(file.text, { sep: ',', header: true, checkNames: true });
      series = series.replace(/.csv/g, '');
    } else if (ftype === 'txt') {
      theData = parseDelimited(file.text, { sep: '\t', header: true, checkNames: true });
      series = series.replace(/.txt/g, '');
    } else if (ftype === 'lsx') {
      theData = readXlsx(file.buffer, { na: 'NA' }); series = series.replace(/.xlsx/g, '');
    } else {
      throw new Error('Error in ld_undated_chron: unsupported file type. Problem file: ' + file.name);
    }
    series = series.replace(/[-.]/g, '_');

    const detrendOpt = pairDetrend ? detrendingSelect : 1;
    const detrended = normalise(theData, { detrending_select: detrendOpt, splinewindow: splineWindow });
    const years = detrended.cols[0];
    const detData = dropCol0(detrended);

    let tmp;
    if (C.ncol(detData) > 1) {
      tmp = { names: ['years', 'std'], cols: [years.slice(), chronStd(detData)] };
    } else {
      const v = detData.cols[0];
      tmp = { names: ['x', 'y'], cols: [v.map((_, i) => i), v.slice()] }; // c(1:len - 1) = 0..len-1
    }

    if (undated === null || C.ncol(undated) < 2) {
      undated = dropCol0(C.combNA(EMPTY, tmp));
      undated = C.setNames(undated, ['ring', series]);
    } else {
      const oldNames = C.names(undated);
      undated = C.combNA(undated, tmp.cols[1]);
      undated = C.setNames(undated, oldNames.concat([series]));
    }
    undated.cols[0] = seq1(C.nrow(undated));
  }
  undated = { names: undated.names.slice(), cols: undated.cols.slice() };
  undated.cols[0] = seqFrom(undated.cols[0][0], C.nrow(undated));
  // per-file chronology names come from file names, which can repeat
  const uniq = makeUnique(undated.names, '_');
  const renames = [];
  for (let i = 0; i < uniq.length; i++) {
    if (uniq[i] !== undated.names[i]) renames.push({ index: i, from: undated.names[i], to: uniq[i] });
  }
  undated.names = uniq;
  return attachRenameWarnings(undated, renames);
}

module.exports = {
  loadUndated, loadChron, loadDataTabs, ldUndatedChron,
  tbrm, chronStd, checkLoadRingmeasurer,
};
