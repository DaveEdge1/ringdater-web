'use strict';
// Port of ringdater::correl_replace.
// For each series (columns 2..ncol of the Frame; column 1 is years), build an
// arithmetic mean chronology from ALL the OTHER series, then correlate the
// series against that leave-one-out mean with a Pearson cor.test.
//
// Returns a Frame with six columns:
//   "Series ID", "First Ring", "Last ring", "R value", "P value",
//   "Overlap with chronology"
// (first column holds series-id strings; the rest are numeric).

const { isNA, nrow, ncol, rowMeans } = require('./comb.js');
const { pearsonCorTest } = require('../stats/cortest.js');

const COLHEAD = ['Series ID', 'First Ring', 'Last ring', 'R value',
  'P value', 'Overlap with chronology'];

function correlReplace(the_data) {
  if (!the_data || !Array.isArray(the_data.names) || !Array.isArray(the_data.cols)) {
    throw new Error('Error in correl_replace(). Required data are not a data.frame');
  }
  if (ncol(the_data) <= 3) {
    throw new Error('Error in correl_replace(). Insufficient data to calculate correlations');
  }

  const year = the_data.cols[0];
  const N = nrow(the_data);
  const nc = ncol(the_data);

  const idCol = [], firstCol = [], lastCol = [], rCol = [], pCol = [], overCol = [];

  for (let ser = 1; ser < nc; ser++) {              // 0-based: series columns 1..nc-1
    const series = the_data.cols[ser];

    // chron_mean = rowMeans over every series column except `ser` (year excluded).
    const otherIdx = [];
    for (let c = 1; c < nc; c++) if (c !== ser) otherIdx.push(c);
    const chronMean = rowMeans(the_data, { cols: otherIdx, naRm: true });

    // complete cases of (series, chron_mean) for the correlation
    const sx = [], sy = [];
    for (let r = 0; r < N; r++) {
      if (!isNA(series[r]) && !isNA(chronMean[r])) { sx.push(series[r]); sy.push(chronMean[r]); }
    }
    const ct = pearsonCorTest(sx, sy);

    // over = nrow of complete cases of (year, series, chron_mean)
    let over = 0;
    for (let r = 0; r < N; r++) {
      if (!isNA(year[r]) && !isNA(series[r]) && !isNA(chronMean[r])) over++;
    }

    // first / last = min / max year where (year, series) both present
    let first = Infinity, last = -Infinity;
    for (let r = 0; r < N; r++) {
      if (!isNA(year[r]) && !isNA(series[r])) {
        if (year[r] < first) first = year[r];
        if (year[r] > last) last = year[r];
      }
    }

    idCol.push(the_data.names[ser]);
    firstCol.push(first);
    lastCol.push(last);
    rCol.push(ct.r);
    pCol.push(ct.p);
    overCol.push(over);
  }

  return {
    names: COLHEAD.slice(),
    cols: [idCol, firstCol, lastCol, rCol, pCol, overCol],
  };
}

module.exports = { correlReplace, COLHEAD };
