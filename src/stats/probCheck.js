'use strict';
// Port of ringdater::prob_check — a thin wrapper over dplR::corr.rwl.seg
// (already ported as corrRwlSeg) that flags aligned samples whose segment
// correlations against the master are not significant.
//
// Mirrors R/prob_check_function.R exactly, including:
//   * the (mislabelled) even/odd window adjustment: when `wind` is ODD, bin =
//     wind + 1; otherwise bin = wind. (R: even_odd <- wind %% 2 != 0.)
//   * the guard bin > 0.5 * nrow -> "Segment length too long".
//   * the corr.rwl.seg call regime: seg.length=bin, bin.floor=10, pcrit=0.05,
//     prewhiten=TRUE, biweight=TRUE, method="spearman", floor.plus1=FALSE,
//     master=NULL (all baked into corrRwlSeg).
//   * reshaping $flags into flagged samples + intervals, with the bin-string
//     gsub("[.]", " to ") so "1800.1819, 1810.1829" -> "1800 to 1819, 1810 to
//     1829", and the "No problems detected" empty-flags special case.
//
// Input is the shared Frame { names, cols } contract: cols[0] = years,
// cols[1..] = aligned series (missing = null). Output:
//   { message:  null | "No problems detected" | "Segment length too long",
//     samples:  string[]   // flagged sample ids (column order)
//     intervals:string[] } // parallel " to "-formatted interval strings

const { corrRwlSeg } = require('../corr_rwl_seg.js');

function isNA(v) { return v == null || (typeof v === 'number' && Number.isNaN(v)); }

// Build corrRwlSeg's rwl shape from a Frame (first col = years, rest = series).
function frameToRwl(frame) {
  const years = frame.cols[0].map(Number);
  const series = {};
  for (let c = 1; c < frame.cols.length; c++) {
    series[frame.names[c]] = frame.cols[c].map(v => (isNA(v) ? null : +v));
  }
  return { years, series };
}

function probCheck(frame, opts) {
  opts = opts || {};
  const wind = opts.wind != null ? opts.wind : 20;

  // R: len_test <- new.chrono[!is.na(new.chrono[,1]),]  -> rows with a year.
  const yearCol = frame.cols[0];
  let nrow = 0;
  for (let i = 0; i < yearCol.length; i++) if (!isNA(yearCol[i])) nrow++;

  // Even/odd window adjustment, replicated verbatim from ringdater (note the
  // condition fires when wind is ODD, despite the source comment).
  const evenOdd = wind % 2 !== 0;
  const bin = evenOdd ? Number(wind) + 1 : wind;

  if (bin > 0.5 * nrow) {
    return { message: 'Segment length too long', samples: [], intervals: [] };
  }

  const rwl = frameToRwl(frame);
  const check = corrRwlSeg(rwl, {
    segLength: bin, binFloor: 10, pcrit: 0.05, floorPlus1: false,
  });

  // Reshape $flags: names -> flagged samples, values -> intervals with the
  // gsub("[.]", " to ") replacement. Column (Object.keys) order preserved.
  const samples = [];
  const intervals = [];
  for (const id of Object.keys(check.flags)) {
    samples.push(id);
    intervals.push(check.flags[id].replace(/\./g, ' to '));
  }

  if (samples.length < 1) {
    return { message: 'No problems detected', samples: [], intervals: [] };
  }
  return { message: null, samples, intervals };
}

module.exports = { probCheck };
