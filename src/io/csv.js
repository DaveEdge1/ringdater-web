'use strict';
// ============================================================================
// T2.1a  Delimited text reader  (port of base R read.csv / read.table)
// ----------------------------------------------------------------------------
// ringdater's csv/txt loaders all funnel through read.csv (sep=",") or
// read.csv(sep="\t"). This module reproduces the parts of read.table that those
// loaders rely on, and returns the shared `Frame` shape from ../analysis/comb.js
// (ordered named columns; missing === null).
//
// Faithful to base R (R >= 4.0, the oracle) for these behaviours:
//   * quote handling: fields may be quoted with '"'; a doubled quote ("") inside
//     a quoted field is a literal quote; commas/tabs inside quotes are literal.
//   * blank.lines.skip = TRUE: wholly empty lines are dropped.
//   * header = TRUE: first record supplies the column names; header = FALSE gives
//     V1, V2, ... .  If the header has exactly one fewer field than the body,
//     R promotes the first body column to row.names -- reproduced here (it does
//     not fire on any ringdater fixture, but kept for fidelity).
//   * per-column type.convert: a column is numeric iff every non-NA cell parses
//     as a number (incl. scientific notation, Inf/NaN); otherwise it stays a
//     character column.  na.strings = "NA" by default; empty cells read as NA.
//   * stringsAsFactors = FALSE (R 4.x default) -- character columns stay strings,
//     never factors.  (This is why load_undated's "reload if col1 is a factor"
//     branch is dead code under R 4.x.)
//   * check.names: when TRUE, header names are passed through make.names(unique).
//
// NOTE ON CELL TYPES: although the analysis-layer contract is (number|null),
// real ringdater loaders (e.g. load_chron on chron_comp_1.csv) return character
// columns, so cells here are (number|string|null).  Downstream numeric code only
// ever touches the numeric columns, so this is a superset, not a violation.
// ============================================================================

const { makeNames } = require('../analysis/checks');

// ---- field tokeniser (quote-aware) -----------------------------------------
function splitFields(line, sep, quote) {
  const out = [];
  let cur = '', inQ = false, i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (inQ) {
      if (c === quote) {
        if (line[i + 1] === quote) { cur += quote; i += 2; continue; } // "" -> literal "
        inQ = false; i += 1; continue;
      }
      cur += c; i += 1; continue;
    }
    if (c === quote) { inQ = true; i += 1; continue; }
    if (c === sep) { out.push(cur); cur = ''; i += 1; continue; }
    cur += c; i += 1;
  }
  out.push(cur);
  return out;
}

// ---- numeric detection / parsing (base R type.convert / as.numeric) ---------
const NUM_RE = /^[+-]?((\d+\.?\d*)|(\.\d+))([eE][+-]?\d+)?$/;
function isNumericToken(s) {
  const t = s.trim();
  if (t === '') return false;
  if (/^[+-]?Inf$/.test(t)) return true;
  if (t === 'NaN') return true;
  return NUM_RE.test(t);
}
function parseNumericToken(s) {
  const t = s.trim();
  if (/^[+-]?Inf$/.test(t)) return t[0] === '-' ? -Infinity : Infinity;
  if (t === 'NaN') return NaN;
  return parseFloat(t);
}

// ---- main -------------------------------------------------------------------
// parseDelimited(text, { sep, header, quote, checkNames, naStrings }) -> Frame
function parseDelimited(text, opts = {}) {
  const sep = opts.sep != null ? opts.sep : ',';
  if (String(sep).length !== 1) {
    // base R: read.table stops with "invalid 'sep' value: must be one byte".
    // (load_chron's txt branch passes sep="/t", a genuine upstream bug.)
    throw new Error("invalid 'sep' value: must be one byte");
  }
  const header = opts.header !== undefined ? opts.header : true;
  const quote = opts.quote != null ? opts.quote : '"';
  const checkNames = opts.checkNames !== undefined ? opts.checkNames : true;
  const naStrings = opts.naStrings || ['NA'];
  const naSet = new Set(naStrings);

  // strip a leading UTF-8 BOM, split on any line ending, drop blank lines.
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const rawLines = src.split(/\r\n|\r|\n/).filter(l => l.length > 0);
  if (rawLines.length === 0) return { names: [], cols: [] };

  const records = rawLines.map(l => splitFields(l, sep, quote));

  let rawNames, body;
  if (header) { rawNames = records[0]; body = records.slice(1); }
  else { rawNames = null; body = records; }

  const bodyWidth = body.reduce((m, r) => Math.max(m, r.length), 0);

  // row.names promotion: header one field short of the body.
  let rownameShift = false;
  if (header && rawNames.length === bodyWidth - 1) rownameShift = true;
  const dataStart = rownameShift ? 1 : 0;
  const ncol = bodyWidth - dataStart;

  // column names
  let names;
  if (header) {
    // read.table trims leading/trailing whitespace from header names (internal
    // whitespace is preserved), independent of check.names.
    names = rawNames.map(s => s.replace(/^\s+|\s+$/g, ''));
    // if body is wider than header (and not the rowname case) R invents names;
    // pad defensively so lengths line up.
    while (names.length < ncol) names.push('V' + (names.length + 1));
    if (names.length > ncol) names = names.slice(0, ncol);
    if (checkNames) names = makeNames(names);
  } else {
    names = [];
    for (let c = 0; c < ncol; c++) names.push('V' + (c + 1));
  }

  // gather raw string cells per column (fill short rows with '' == NA)
  const rawCols = [];
  for (let c = 0; c < ncol; c++) {
    const src2 = c + dataStart;
    const colCells = new Array(body.length);
    for (let r = 0; r < body.length; r++) {
      const row = body[r];
      colCells[r] = src2 < row.length ? row[src2] : '';
    }
    rawCols.push(colCells);
  }

  // type.convert each column
  const cols = rawCols.map(cells => {
    let numeric = true;
    for (const v of cells) {
      if (v === '' || naSet.has(v)) continue; // NA -> doesn't block numeric
      if (!isNumericToken(v)) { numeric = false; break; }
    }
    if (numeric) {
      return cells.map(v => (v === '' || naSet.has(v)) ? null : parseNumericToken(v));
    }
    // character column: na.strings -> null; empty string stays "".
    return cells.map(v => (naSet.has(v) ? null : v));
  });

  return { names, cols };
}

module.exports = { parseDelimited, splitFields, isNumericToken, parseNumericToken };
