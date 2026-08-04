'use strict';
// ============================================================================
// T7.0  chron — port of dplR::chron(x, biweight = TRUE, prewhiten = FALSE).
//
// The Quick Chronology Checker (chrono_checker_app.R) calls:
//     chrono <- chron(det_chron_data[,-1])          # dplR::chron, defaults
//     chrono <- data.frame(years, sgi = chrono[,1]) # the "std" column
//
// dplR::chron with biweight=TRUE builds its "std" column as the row-wise Tukey
// biweight robust mean (apply(x, 1, tbrm)) and its "samp.depth" column as the
// per-row count of non-missing series. That "std" column is exactly what
// io/loaders.js::chronStd already computes (validated to ~1e-15 vs R). This
// module is a thin, standalone re-statement of that piece with the matching
// samp.depth column, so the engine has a named `chron()` mirroring dplR.
//
// prewhiten = FALSE is the only branch chrono_checker needs; the AR/res column
// is intentionally not ported (documented — chrono_checker never sets it).
//
// Input : a Frame of detrended series ONLY (no year column) — i.e. R's x[,-1].
// Output: Frame { names:['std','samp.depth'], cols:[std[], sampDepth[]] } plus
//         the convenience arrays returned alongside.
// Validated against dplR::chron in tools/chrono_checker_ground_truth.R.
// ============================================================================

const C = require('../analysis/comb.js');

function median(a) {
  const s = a.slice().sort((p, q) => p - q);
  const n = s.length, h = n >> 1;
  return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// dplR's compiled tbrm (Tukey's biweight robust mean, C = 9): median-centred,
// weighted by the biweight of deviations scaled by C*mad + 1e-6.
function tbrm(values, Cc = 9) {
  const x = values.filter(v => !C.isNA(v));
  const n = x.length;
  if (n === 0) return C.NA;
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

// Row-wise biweight mean over every series column of `frame` (dplR chron std).
function chronStd(frame) {
  const nr = C.nrow(frame), nc = C.ncol(frame);
  const out = new Array(nr);
  for (let r = 0; r < nr; r++) {
    const row = new Array(nc);
    for (let c = 0; c < nc; c++) row[c] = frame.cols[c][r];
    out[r] = tbrm(row, 9);
  }
  return out;
}

// dplR::chron(x, biweight = TRUE). `frame` = detrended series only (no years).
function chron(frame, opts = {}) {
  const biweight = opts.biweight !== undefined ? opts.biweight : true;
  const nr = C.nrow(frame), nc = C.ncol(frame);
  const std = new Array(nr);
  const sampDepth = new Array(nr);
  for (let r = 0; r < nr; r++) {
    const row = new Array(nc);
    let depth = 0;
    for (let c = 0; c < nc; c++) { const v = frame.cols[c][r]; row[c] = v; if (!C.isNA(v)) depth++; }
    // biweight ? tbrm : arithmetic mean (na.rm) — chrono_checker uses the default.
    if (biweight) {
      std[r] = tbrm(row, 9);
    } else {
      let s = 0; for (const v of row) if (!C.isNA(v)) s += v;
      std[r] = depth ? s / depth : C.NA;
    }
    sampDepth[r] = depth;
  }
  return { names: ['std', 'samp.depth'], cols: [std, sampDepth] };
}

module.exports = { chron, chronStd, tbrm };
