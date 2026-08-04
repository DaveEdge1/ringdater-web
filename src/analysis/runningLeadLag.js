'use strict';
// ============================================================================
// running_lead_lag — running lead-lag correlation between two series (port of
// R/running_lead_lag_function.R). For each lag in the range, series B is shifted
// against series A, a running Pearson correlation (rollcor, odd window `win`) is
// computed over the NA-padded overlap, and the centered rolling mean of the
// shifted years (zoo::rollmean, length n-win+1) labels each correlation. The
// long table of {year, lag, "R val"} rows is assembled with combNA +
// completeCases and stacked over all lags. Returns a Frame with columns
// year, lag, "R val" — or null when fewer than 15 rows survive (R's nrow<15 rule).
//
// This is the data generator behind the running-correlation heatmap.
//
// Reuses the shared Frame contract (comb.js), rollcor (rollcor.js) and, for the
// year labels, a direct reproduction of zoo::rollmean (centered simple mean;
// a window containing any NA yields NA; output length = n - win + 1).
// ============================================================================

const { combNA, completeCases, isNA, NA } = require('./comb.js');
const { rollcor } = require('./rollcor.js');

// zoo::rollmean(x, k) — centered simple moving average, align="center",
// na.pad=FALSE. Output length n-k+1; out[i] = mean(x[i..i+k-1]); any NA in the
// window -> NA (verified against zoo 1.8_15).
function rollmean(x, k) {
  const n = x.length;
  const out = [];
  for (let i = 0; i + k <= n; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < k; j++) { const v = x[i + j]; if (isNA(v)) { ok = false; break; } s += v; }
    out.push(ok ? s / k : NA);
  }
  return out;
}

function runningLeadLag(frame, opts = {}) {
  const s1 = opts.s1, s2 = opts.s2;
  let negLag = opts.neg_lag != null ? opts.neg_lag : -20;
  let posLag = opts.pos_lag != null ? opts.pos_lag : 20;
  let win = opts.win != null ? opts.win : 21;
  const complete = opts.complete != null ? opts.complete : true;

  const iA = frame.names.indexOf(s1);
  const iB = frame.names.indexOf(s2);
  if (iA < 0) throw new Error('runningLeadLag: s1 is not a valid sample ID');
  if (iB < 0) throw new Error('runningLeadLag: s2 is not a valid sample ID');

  // force odd window (even -> +1), matching R.
  if (win % 2 === 0) win = win + 1;

  const years = frame.cols[0].map(v => (isNA(v) ? NA : +v));
  const seriesA = frame.cols[iA];
  const seriesB = frame.cols[iB];

  // ser_a_len / ser_b_len: counts of non-NA values.
  let aLen = 0; for (const v of seriesA) if (!isNA(v)) aLen++;
  let bLen = 0; for (const v of seriesB) if (!isNA(v)) bLen++;

  const posLagLim = Math.max(aLen, bLen);
  const negLagLim = -Math.max(aLen, bLen);

  if (complete) { posLag = posLagLim; negLag = negLagLim; }
  const maxPosLag = posLag > posLagLim ? posLagLim : posLag;
  const maxNegLag = negLag < negLagLim ? negLagLim : negLag;

  // accumulate long-table rows across lags.
  const outYear = [], outLag = [], outR = [];

  for (let lag = maxNegLag; ; lag++) {
    let yrMod, mod1, mod2;
    if (lag <= -1) {
      const pad = Array(Math.abs(lag)).fill(NA);
      yrMod = pad.concat(years);
      mod1 = pad.concat(seriesA);
      mod2 = seriesB.concat(pad);
    } else if (lag === 0) {
      yrMod = years.slice();
      mod1 = seriesA.slice();
      mod2 = seriesB.slice();
    } else { // lag >= 1
      const pad = Array(lag).fill(NA);
      yrMod = years.concat(pad);
      mod1 = seriesA.concat(pad);
      mod2 = pad.concat(seriesB);
    }
    // analysis.data has exactly two (equal-length) columns; both must be present.
    const n = Math.max(mod1.length, mod2.length);
    let bothCount = 0;
    for (let i = 0; i < n; i++) if (!isNA(mod1[i]) && !isNA(mod2[i])) bothCount++;

    if (bothCount > win) {
      const corTest = rollcor(mod1, mod2, win);         // length n - win + 1
      const corYear = rollmean(yrMod, win);             // length n - win + 1
      // comb.NA(cor_year, lag_ser, cor_test) then complete.cases
      for (let i = 0; i < corYear.length; i++) {
        const y = corYear[i];
        const r = corTest[i];
        const rNA = r == null || Number.isNaN(r);
        if (!isNA(y) && !rNA) { outYear.push(y); outLag.push(lag); outR.push(r); }
      }
    }
    if (lag >= maxPosLag) break;
  }

  if (outYear.length < 15) return null;
  return { names: ['year', 'lag', 'R val'], cols: [outYear, outLag, outR] };
}

module.exports = { runningLeadLag, rollmean };
