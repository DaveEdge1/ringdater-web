'use strict';
// ============================================================================
// Port of ringdater's alignment functions (T1.8a/b/c):
//   alignSeries    <- align_series        (align_series_function.R)
//   alignToChron   <- align_to_chron      (align_to_chron_function.R)
//   ontoAlignDated <- onto_align_dated    (onto_align_dated_function.R)
//
// All operate on the shared `Frame` shape from comb.js (ordered named columns,
// rectangular, NA === null, first column = years/increment). `crossDates` is the
// filtered 17-col `cross_dat_res` Frame (Series_1, Series_2, First_ring,
// Last_ring, col, First_lag, ...) produced by lead_lag_analysis + filter_crossdates.
// ============================================================================

const C = require('./comb.js');
const { isNA, NA } = C;

// integer sequence a:b (inclusive), matching R's `c(a:b)`.
function seq(a, b) {
  const out = [];
  for (let x = a; x <= b; x++) out.push(x);
  return out;
}

// remove a single column (by 0-based position) from a Frame.
function removeCol(f, i) {
  return {
    names: f.names.filter((_, c) => c !== i),
    cols: f.cols.filter((_, c) => c !== i),
  };
}

// prepend `n` NA rows to every column (R's rbind(NA.frame, body) / c(NA_ser, x)).
function topPad(f, n) {
  if (n <= 0) return { names: f.names.slice(), cols: f.cols.map(c => c.slice()) };
  const pad = Array(n).fill(NA);
  return { names: f.names.slice(), cols: f.cols.map(c => pad.concat(c)) };
}

// complete.cases over a (years, values) pair -> arrays of the kept years/values.
function completePair(years, vals) {
  const y = [], v = [];
  for (let i = 0; i < years.length; i++) {
    if (!isNA(years[i]) && !isNA(vals[i])) { y.push(+years[i]); v.push(vals[i]); }
  }
  return { y, v };
}

// ---------------------------------------------------------------------------
// T1.8a  align_series
// Shift each crossdated series by its best lag relative to `sel_target` and join
// on a common year axis via comb.NA.
// ---------------------------------------------------------------------------
function alignSeries(the_data, cross_dates, sel_target) {
  if (typeof sel_target !== 'string') {
    throw new Error('Error in align_series(). sel_target is not a character string.');
  }
  if (!the_data || !Array.isArray(the_data.cols)) {
    throw new Error('Error in align_series(). Required data are not a data.frame');
  }
  if (C.ncol(the_data) <= 2) throw new Error('Error in align_series(). Insufficient data in the_data');
  if (C.nrow(the_data) <= 1) throw new Error('Error in align_series(). Insufficient data in the_data');
  if (!cross_dates || !Array.isArray(cross_dates.cols)) {
    throw new Error('Error in align_series(). Required cross_dates are not a data.frame');
  }
  if (C.ncol(cross_dates) <= 2) throw new Error('Error in align_series(). Insufficient data in cross_dates');

  const yearsAll = C.col(the_data, 0);
  const targVals = C.colByName(the_data, sel_target);

  // target: complete.cases(year, target); record its min/max year.
  const t = completePair(yearsAll, targVals);
  const targMinYr = Math.min(...t.y);
  const targMaxYr = Math.max(...t.y);

  // ser_dates: {id, min, max}. First row = the target.
  const serDates = [{ id: sel_target, min: targMinYr, max: targMaxYr }];

  const cd1 = cross_dates.cols[0];   // Series_1
  const cd2 = cross_dates.cols[1];   // Series_2
  const cd6 = cross_dates.cols[5];   // First_lag
  const nSeries = cd1.length;

  for (let i = 0; i < nSeries; i++) {
    let newSample, lag;
    if (cd1[i] === sel_target) { newSample = String(cd2[i]); lag = cd6[i]; }
    else { newSample = String(cd1[i]); lag = -cd6[i]; }

    const nv = C.colByName(the_data, newSample);
    const p = completePair(yearsAll, nv);
    const shifted = p.y.map(yy => yy + lag);   // years shifted by the best lag
    serDates.push({ id: newSample, min: Math.min(...shifted), max: Math.max(...shifted) });
  }

  const minNewYr = Math.min(...serDates.map(s => s.min));
  const maxNewYr = Math.max(...serDates.map(s => s.max));
  const newYears = seq(minNewYr, maxNewYr);

  // Build the aligned frame by comb.NA-ing each front-padded series onto the axis.
  let aligned = C.frame([{ name: '', values: newYears }]);
  const sampleID = serDates.map(s => s.id);
  for (let i = 0; i < sampleID.length; i++) {
    let tmp = C.colByName(the_data, sampleID[i]).filter(x => !isNA(x));  // drop NA, keep order
    const dif = Math.abs(serDates[i].min - minNewYr);
    if (dif >= 1) tmp = Array(dif).fill(NA).concat(tmp);   // front-pad to align the start year
    aligned = C.combNA(aligned, tmp);
  }
  return C.setNames(aligned, ['Year', ...sampleID]);
}

// ---------------------------------------------------------------------------
// T1.8b  align_to_chron  (chronology-analysis mode)
// Replace the arithmetic mean chronology (col 2) with the individual series used
// to build it, joined on a common year axis.
// ---------------------------------------------------------------------------
function alignToChron(the_data, chrono) {
  // drop the 2nd column (the arithmetic mean chronology).
  const td = removeCol(the_data, 1);

  const tdYears = C.col(td, 0).map(Number);
  const minTd = Math.min(...tdYears);
  const maxTd = Math.max(...tdYears);
  const chYears = C.col(chrono, 0).map(Number);
  const chMin = Math.min(...chYears);
  const chMax = Math.max(...chYears);

  const newYears = seq(Math.min(minTd, chMin), Math.max(maxTd, chMax));
  let out = C.frame([{ name: '', values: newYears }]);

  // chrono body (all but its year column), top-padded if it starts later.
  const chBody = removeCol(chrono, 0);
  out = C.combNA(out, chMin > minTd ? topPad(chBody, Math.abs(chMin - minTd)) : chBody);

  // series body (all but the year column), top-padded if the chronology starts earlier.
  const tdBody = removeCol(td, 0);
  out = C.combNA(out, chMin < minTd ? topPad(tdBody, Math.abs(minTd - chMin)) : tdBody);

  const outNames = [...C.names(chrono), ...C.names(td).slice(1)];
  return C.setNames(out, outNames);
}

// ---------------------------------------------------------------------------
// T1.8c  onto_align_dated
// Ontogenetically align date-aligned series: strip each series' leading NAs so it
// starts at ring 1, join via comb.NA, and prepend a 1..n `ring` column.
// ---------------------------------------------------------------------------
function ontoAlignDated(df) {
  const nm = C.names(df);
  // first sample = column 2 with its NAs removed.
  let onto = C.frame([{ name: nm[1], values: C.col(df, 1).filter(x => !isNA(x)) }]);
  for (let i = 2; i < C.ncol(df); i++) {
    const tmp = C.frame([{ name: nm[i], values: C.col(df, i).filter(x => !isNA(x)) }]);
    onto = C.combNA(onto, tmp);
  }
  const ring = seq(1, C.nrow(onto));
  return { names: ['ring', ...onto.names], cols: [ring, ...onto.cols] };
}

module.exports = { alignSeries, alignToChron, ontoAlignDated };
