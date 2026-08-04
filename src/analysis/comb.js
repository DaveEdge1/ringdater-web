'use strict';
// ============================================================================
// SHARED DATA-SHAPE CONTRACT for the ringdater analysis layer (Phase 1).
// Every analysis/detrend function reads and writes this shape. Do NOT invent
// another table representation in a sibling module — extend this one.
//
// A `Frame` mirrors an R data.frame as ringdater uses it: an ORDERED list of
// named columns. ringdater indexes columns both by position (df[,a]) and by
// name (df[[id]]), and its "first column is years/increment number", so the
// contract preserves order, allows duplicate names, and supports positional
// access. Frames are rectangular: every column is the same length, short
// columns bottom-padded with `null` (R's NA). Missing value === null (NaN also
// tolerated on input, normalised to null).
//
//   Frame = { names: string[], cols: (number|null)[][] }   // cols[c] has length nrow
//
// Helpers below are the ONLY sanctioned way to build/join/slice frames.
// ============================================================================

const NA = null;
function isNA(v) { return v == null || (typeof v === 'number' && Number.isNaN(v)); }
function norm(v) { return isNA(v) ? NA : +v; }

// ---- construction -----------------------------------------------------------

// Build a Frame from an array of {name, values} or from parallel arrays.
function frame(columns) {
  const names = [], cols = [];
  for (const c of columns) { names.push(c.name != null ? String(c.name) : ''); cols.push(c.values.map(norm)); }
  return rectangular({ names, cols });
}

// Coerce a bare input into a Frame: a numeric vector -> 1 column; a Frame stays;
// {name,values} -> 1 named column; an array of {name,values} -> multi-column.
function asFrame(x, defaultName = '') {
  if (x && Array.isArray(x.names) && Array.isArray(x.cols)) return x;                 // already a Frame
  if (Array.isArray(x)) {
    if (x.length && x[0] && typeof x[0] === 'object' && 'values' in x[0]) return frame(x); // [{name,values}]
    return frame([{ name: defaultName, values: x }]);                                 // bare vector
  }
  if (x && 'values' in x) return frame([{ name: x.name != null ? x.name : defaultName, values: x.values }]);
  throw new Error('asFrame: unsupported input');
}

// Pad all columns to the max length with NA so the frame is rectangular.
function rectangular(f) {
  const nrow = f.cols.reduce((m, c) => Math.max(m, c.length), 0);
  const cols = f.cols.map(c => c.length < nrow ? c.concat(Array(nrow - c.length).fill(NA)) : c);
  return { names: f.names.slice(), cols };
}

// ---- introspection ----------------------------------------------------------

function ncol(f) { return f.cols.length; }
function nrow(f) { return f.cols.length ? f.cols[0].length : 0; }
function names(f) { return f.names.slice(); }
function col(f, i) { return f.cols[i]; }                 // by position (0-based)
function colByName(f, name) { const i = f.names.indexOf(name); return i < 0 ? undefined : f.cols[i]; }
function setNames(f, newNames) { return { names: newNames.slice(), cols: f.cols }; }

// vertLen: length (nrow) of a vector or frame — port of ringdater::vertLen.
function vertLen(x) {
  if (Array.isArray(x) && (!x.length || typeof x[0] !== 'object')) return x.length;
  return nrow(asFrame(x));
}

// ---- comb.NA ----------------------------------------------------------------
// Port of ringdater::comb.NA: pad every part (bottom) to the max row count with
// NA, then column-bind in order. Bare vectors become single columns; an empty
// frame becomes a single NA column (matching R's data.frame(rep(NA,1))). The R
// implementation always pads with NA regardless of `fill`, so we do too.
function combNA(...parts) {
  const frames = parts.map((p, i) => {
    let f = asFrame(p, '');
    if (ncol(f) === 0 || nrow(f) === 0) f = frame([{ name: '', values: [NA] }]); // empty -> 1 NA col
    return f;
  });
  const maxLen = frames.reduce((m, f) => Math.max(m, nrow(f)), 0);
  const outNames = [], outCols = [];
  for (const f of frames) {
    for (let c = 0; c < ncol(f); c++) {
      const v = f.cols[c];
      outCols.push(v.length < maxLen ? v.concat(Array(maxLen - v.length).fill(NA)) : v.slice());
      outNames.push(f.names[c]);
    }
  }
  return { names: outNames, cols: outCols };
}

// ---- row operations (used across the analysis layer) ------------------------

// Keep only rows for which `pred(rowValues, rowIndex)` is true.
function subsetRows(f, pred) {
  const keep = [];
  for (let r = 0; r < nrow(f); r++) {
    const row = f.cols.map(c => c[r]);
    if (pred(row, r)) keep.push(r);
  }
  return { names: f.names.slice(), cols: f.cols.map(c => keep.map(r => c[r])) };
}

// R's complete.cases: drop any row containing an NA in any column.
function completeCases(f) { return subsetRows(f, row => row.every(v => !isNA(v))); }

// Row means across selected columns (default: all). naRm drops NA before mean;
// a row that is all-NA yields NA (matches rowMeans(..., na.rm=TRUE) -> NaN handled as NA).
function rowMeans(f, { cols: which, naRm = true } = {}) {
  const idx = which || f.cols.map((_, i) => i);
  const out = [];
  for (let r = 0; r < nrow(f); r++) {
    let s = 0, n = 0;
    for (const i of idx) { const v = f.cols[i][r]; if (!isNA(v)) { s += v; n++; } else if (!naRm) { n = -1; break; } }
    out.push(n > 0 ? s / n : NA);
  }
  return out;
}

module.exports = {
  NA, isNA, frame, asFrame, rectangular,
  ncol, nrow, names, col, colByName, setNames, vertLen,
  combNA, subsetRows, completeCases, rowMeans,
};
