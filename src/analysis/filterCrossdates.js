'use strict';
// Port of ringdater::filter_crossdates.
// Filters the `cross_dat_res` Frame produced by lead_lag_analysis (17 fixed
// columns: Series_1, Series_2, First_ring, Last_ring, col, First_lag, First_R,
// First_P, First_Overlap, Sec_lag, Sec_R, Sec_P, Sec_Overlap, Third_lag,
// Third_R, Third_P, Third_Overlap).
//
// R logic (columns 1-based -> JS 0-based in brackets):
//   tmp_1 = rows where col1[0] == target
//   tmp_2 = rows where col2[1] == target
//   the_data = rbind(tmp_1, tmp_2)                      // order + possible dups
//   keep rows where col7[6] >= r_val & col8[7] <= p_val & col9[8] >= overlap
//        (NA comparisons -> FALSE, i.e. dropped, matching R's subset())
//   signif: col7[6]->3, col8[7]->5, col11[10]->3, col12[11]->5,
//           col15[14]->3, col16[15]->5

const { isNA } = require('./comb.js');

// R signif(x, n): round x to n significant digits. Number.toPrecision matches
// R for non-tie values (correlation coefficients / p-values never land exactly
// on a rounding tie at the 3rd/5th significant digit).
function signif(x, n) {
  if (isNA(x)) return null;
  if (x === 0) return 0;
  return Number(x.toPrecision(n));
}

// Select rows by an explicit (possibly duplicated / reordered) index list.
function selectRows(f, idx) {
  return { names: f.names.slice(), cols: f.cols.map(c => idx.map(r => c[r])) };
}

function filterCrossdates(the_data, opts = {}) {
  const { r_val = 0.5, p_val = 0.05, overlap = 50, target = null } = opts;

  if (!the_data || !Array.isArray(the_data.names) || !Array.isArray(the_data.cols)) {
    throw new Error('Error in filter_crossdates: the_data is not of class data.frame');
  }
  if (typeof r_val !== 'number' || r_val < 0 || r_val > 1) {
    throw new Error('Error in filter_crossdates: r_val should be numeric value > 0 and < 1');
  }
  if (typeof p_val !== 'number' || p_val < 0 || p_val > 1) {
    throw new Error('Error in filter_crossdates: p_val should be numeric value > 0 and < 1');
  }
  if (typeof overlap !== 'number' || overlap % 1 !== 0 || overlap < 1) {
    throw new Error('Error in filter_crossdates: overlap should be numeric integer');
  }
  const col1 = the_data.cols[0], col2 = the_data.cols[1];
  const inCol1 = col1.some(v => v === target);
  const inCol2 = col2.some(v => v === target);
  if (!inCol1 || !inCol2) {
    throw new Error('Error in filter_crossdates: target must be a valid sample ID');
  }

  // rbind(subset col1==target, subset col2==target)
  const idx = [];
  for (let r = 0; r < col1.length; r++) if (col1[r] === target) idx.push(r);
  for (let r = 0; r < col2.length; r++) if (col2[r] === target) idx.push(r);

  let out = selectRows(the_data, idx);

  // subset on First_R[6] >= r_val & First_P[7] <= p_val & First_Overlap[8] >= overlap.
  // NA in any operand => NA logical => row dropped (R subset semantics).
  const keep = [];
  const c6 = out.cols[6], c7 = out.cols[7], c8 = out.cols[8];
  for (let r = 0; r < c6.length; r++) {
    if (isNA(c6[r]) || isNA(c7[r]) || isNA(c8[r])) continue;
    if (c6[r] >= r_val && c7[r] <= p_val && c8[r] >= overlap) keep.push(r);
  }
  out = selectRows(out, keep);

  // signif rounding of the R/P columns
  out.cols[6] = out.cols[6].map(v => signif(v, 3));
  out.cols[7] = out.cols[7].map(v => signif(v, 5));
  out.cols[10] = out.cols[10].map(v => signif(v, 3));
  out.cols[11] = out.cols[11].map(v => signif(v, 5));
  out.cols[14] = out.cols[14].map(v => signif(v, 3));
  out.cols[15] = out.cols[15].map(v => signif(v, 5));

  return out;
}

module.exports = { filterCrossdates, signif };
