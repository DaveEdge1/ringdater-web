'use strict';
// ============================================================================
// Ring Measurer CSV loader + combiner. Faithful port of ringdater's
// check_load_ringmeasurer_data() (load_ring_measurer_fun.R) and
// combine_RM_files() (combine_RM_files_function.R).  R is the oracle.
//
// Output shape is the shared Frame contract (see src/analysis/comb.js):
//   Frame = { names: string[], cols: (number|null|string)[][] }
// The first column is the increment/ring number ("years"/"year"); missing = null.
// (Cells are numeric for Ring Measurer output; the non-RM passthrough may carry
//  strings, mirroring R returning the untouched data.frame.)
// ============================================================================

const KEY_COLS = ['sample_ID', 'x1', 'y1', 'x2', 'y2', 'series'];

// ---- CSV parsing ------------------------------------------------------------
// Minimal RFC-ish parser: comma-separated, optional double-quoted fields.
// Returns { header: string[], rows: string[][] } with raw (untyped) cells.
function parseCSV(text) {
  const rows = [];
  let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') { inQ = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); field = ''; row = [];
    } else field += c;
  }
  // flush trailing field/row unless the file ended on a bare newline
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // drop fully-empty trailing rows
  while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
  if (!rows.length) return { header: [], rows: [] };
  return { header: rows[0], rows: rows.slice(1) };
}

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
function isBlank(s) { return s == null || String(s).trim() === ''; }
function parseNum(s) { return isBlank(s) ? null : Number(s); }
// read.csv-style column typing: numeric iff every non-blank cell parses as number.
function columnIsNumeric(cells) {
  let seen = false;
  for (const c of cells) {
    if (isBlank(c)) continue;
    seen = true;
    if (!NUM_RE.test(String(c).trim())) return false;
  }
  return seen; // all-blank column -> treated as non-numeric (like logical NA), irrelevant here
}
function typedColumn(cells) {
  return columnIsNumeric(cells) ? cells.map(parseNum) : cells.map(c => (isBlank(c) ? null : String(c)));
}

// ---- check_load_ringmeasurer_data ------------------------------------------
// text -> reshaped Frame. If not a Ring Measurer file, returns the raw table as
// a Frame unchanged (mirrors R returning `the_data`).
function loadRingMeasurer(text, opts = {}) {
  const avgSeries = opts.avgSeries !== undefined ? opts.avgSeries : true;
  const { header, rows } = parseCSV(text);

  // Not a Ring Measurer file -> pass the (typed) table straight through.
  if (!KEY_COLS.every(k => header.includes(k))) {
    return { names: header.slice(), cols: header.map((_, j) => typedColumn(rows.map(r => r[j]))) };
  }

  const idx = name => header.indexOf(name);
  const cSample = idx('sample_ID'), cSeries = idx('series');
  const cLabel = idx('label_text'), cAbs = idx('abs_distance');

  // sample_ID: replace whitespace with "_" then lowercase; ID = first row's.
  const cleanID = s => String(s).replace(/\s/g, '_').toLowerCase();
  const ID = cleanID(rows.length ? rows[0][cSample] : '');

  // read.csv types the whole label_text column once (numeric vs character).
  const labelNumeric = columnIsNumeric(rows.map(r => r[cLabel]));
  const labelKey = raw => (labelNumeric ? Number(raw) : String(raw));

  // Split by series, order each by label_text (stable), collect abs_distance.
  const seriesAbs = [1, 2, 3].map(n => {
    const tag = 'series_' + n;
    const picked = [];
    for (let r = 0; r < rows.length; r++) if (rows[r][cSeries] === tag) picked.push(r);
    picked.sort((a, b) => {
      const ka = labelKey(rows[a][cLabel]), kb = labelKey(rows[b][cLabel]);
      if (labelNumeric) return ka - kb;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return picked.map(r => parseNum(rows[r][cAbs]));
  });

  const lens = seriesAbs.map(a => a.length);
  const maxLen = Math.max(...lens);
  const year = Array.from({ length: maxLen }, (_, i) => i + 1);

  // Build padded series columns (length maxLen, bottom-padded with null).
  const seriesCols = seriesAbs.map(a => a.concat(Array(maxLen - a.length).fill(null)));

  // Keep only series that have data (R: output[,c(1, which(lens>0)+1)]).
  const present = [0, 1, 2].filter(k => lens[k] > 0);

  if (!avgSeries) {
    const names = ['year', ...present.map(k => `${ID}_series_${k + 1}`)];
    const cols = [year, ...present.map(k => seriesCols[k])];
    return { names, cols };
  }

  // avg_series = TRUE: rowMeans(output[,-1], na.rm=TRUE).
  // R BUG parity: with a single present series, output[,-1] drops to a vector and
  // rowMeans() errors -- reproduce that error exactly.
  if (present.length < 2) {
    throw new Error("'x' must be an array of at least two dimensions");
  }
  const means = [];
  for (let r = 0; r < maxLen; r++) {
    let s = 0, n = 0;
    for (const k of present) { const v = seriesCols[k][r]; if (v != null && !Number.isNaN(v)) { s += v; n++; } }
    means.push(n > 0 ? s / n : null); // all-NA row -> NaN in R -> null
  }
  return { names: ['years', ID], cols: [year, means] };
}

// ---- combine_RM_files -------------------------------------------------------
// texts[] (ordered as R's list.files would sort them) -> combined Frame.
// Each file is loaded with avg_series = TRUE (combine_RM_files' default) and
// column-bound, padding the shorter of {accumulator, new file} with null.
function combineRMFiles(texts) {
  let output = null; // { names, cols }
  for (const text of texts) {
    const tmp = loadRingMeasurer(text, { avgSeries: true }); // may throw (R has no tryCatch)
    if (output === null) { output = { names: tmp.names.slice(), cols: tmp.cols.map(c => c.slice()) }; continue; }

    const outLen = output.cols[0].length;
    const tmpLen = tmp.cols[0].length;
    const dif = outLen - tmpLen; // <0 => tmp longer
    const pad = (col, len) => col.concat(Array(Math.max(0, len - col.length)).fill(null));

    if (dif < 0) {
      // grow accumulator to tmpLen; years become 1..tmpLen; then append tmp data.
      const newYears = Array.from({ length: tmpLen }, (_, i) => i + 1);
      const cols = [newYears];
      for (let j = 1; j < output.cols.length; j++) cols.push(pad(output.cols[j], tmpLen));
      for (let j = 1; j < tmp.cols.length; j++) cols.push(tmp.cols[j].slice());
      output = { names: output.names.concat(tmp.names.slice(1)), cols };
    } else if (dif > 0) {
      const cols = output.cols.map(c => c.slice());
      for (let j = 1; j < tmp.cols.length; j++) cols.push(pad(tmp.cols[j], outLen));
      output = { names: output.names.concat(tmp.names.slice(1)), cols };
    } else {
      const cols = output.cols.map(c => c.slice());
      for (let j = 1; j < tmp.cols.length; j++) cols.push(tmp.cols[j].slice());
      output = { names: output.names.concat(tmp.names.slice(1)), cols };
    }
  }
  return output;
}

module.exports = { loadRingMeasurer, combineRMFiles, parseCSV };
