'use strict';
// Port of dplR's rwi.stats.running (Rbar / EPS running chronology statistics),
// specialised for the regime ringdater's R_bar_EPS actually uses:
//   method="pearson", running.window=TRUE, ids=NULL, prewhiten=FALSE, n=NULL,
//   period="max", first.start=NULL, zero.is.missing=TRUE.
//
// In this regime every series is its own tree with a single core, so the
// between/within-tree machinery collapses: there is no within-tree term
// (n.wt == 0 always) and rbar.tot == rbar.bt == rbar.eff. Multi-core trees
// (the `ids` argument) are intentionally NOT ported; see note below.
//
// Also note: dplR normalises each column by its mean before correlating, but
// Pearson correlation is scale-invariant, so that division is a no-op for the
// outputs we produce and is omitted. Only the zero.is.missing step (treating
// zeros as missing) affects results and is reproduced.
//
// Input `rwl` shape:
//   { years: number[], series: { [id]: (number|null)[] } }
// where each series array is aligned to `years` (same length) and missing
// values are null or NaN. Column order follows Object.keys(series).
//
// Output: array of one object per running segment:
//   { startYear, midYear, endYear, nCores, nTrees, n, rbarTot, eps }
// mirroring test$start.year, mid.year, end.year, n.cores, n.trees, n,
// rbar.tot and eps from rwi.stats.running.

function isMissing(v) {
  return v === null || v === undefined || (typeof v === 'number' && isNaN(v));
}

// Pearson correlation of paired values at the given 0-based row indices,
// using only rows where both series are present. Returns { r, nGood }.
function pairCor(a, b, rows) {
  let n = 0, sx = 0, sy = 0;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    const x = a[r], y = b[r];
    if (isMissing(x) || isMissing(y)) continue;
    n++; sx += x; sy += y;
  }
  if (n === 0) return { r: NaN, nGood: 0 };
  const mx = sx / n, my = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    const x = a[r], y = b[r];
    if (isMissing(x) || isMissing(y)) continue;
    const dx = x - mx, dy = y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  return { r: sxy / Math.sqrt(sxx * syy), nGood: n };
}

function rwiStatsRunning(rwl, opts) {
  opts = opts || {};
  const years = rwl.years;
  const nYears = years.length;
  const ids = Object.keys(rwl.series);
  const nSeries = ids.length;
  const zeroIsMissing = opts.zeroIsMissing !== false;

  // Build the working matrix as columns of numbers, applying zero.is.missing.
  const cols = ids.map(id => {
    const src = rwl.series[id];
    const out = new Array(nYears);
    for (let y = 0; y < nYears; y++) {
      const v = src[y];
      out[y] = (isMissing(v) || (zeroIsMissing && v === 0)) ? NaN : v;
    }
    return out;
  });

  const windowLength = opts.windowLength;
  const windowOverlap = opts.windowOverlap != null
    ? opts.windowOverlap : Math.floor(windowLength / 2);
  const windowAdvance = windowLength - windowOverlap;
  const minCorrOverlap = opts.minCorrOverlap != null
    ? opts.minCorrOverlap : Math.min(30, windowLength);

  if (windowLength < 3) throw new Error("minimum 'windowLength' is 3");
  if (windowAdvance < 1) throw new Error("'windowOverlap' is too large");
  if (windowLength > nYears) throw new Error("'windowLength' is larger than number of years");

  // notNA[y][j] and per-year tree (== series) presence count.
  const notNA = new Array(nYears);
  const goodRowFlag = new Array(nYears); // period="max": > 1 series present
  for (let y = 0; y < nYears; y++) {
    const row = new Array(nSeries);
    let cnt = 0;
    for (let j = 0; j < nSeries; j++) {
      const present = !isNaN(cols[j][y]);
      row[j] = present;
      if (present) cnt++;
    }
    notNA[y] = row;
    goodRowFlag[y] = cnt > 1;
  }

  // --- determine first.start2 (1-based) as dplR does when first.start=NULL ---
  let minGoodRow = -1; // 1-based
  for (let y = 0; y < nYears; y++) { if (goodRowFlag[y]) { minGoodRow = y + 1; break; } }
  if (minGoodRow < 0) throw new Error('too few years with enough trees');

  let firstStart;
  if (typeof opts.firstStart === 'number') {
    firstStart = opts.firstStart;
  } else {
    const minOffset = Math.max(0, minGoodRow - (windowLength - minCorrOverlap) - 1);
    const maxOffset = Math.min(minOffset + windowAdvance - 1, nYears - windowLength);
    let bestOffset = minOffset, bestData = -1;
    for (let offset = minOffset; offset <= maxOffset; offset++) {
      const nWinMinusOne = Math.floor((nYears - offset - windowLength) / windowAdvance);
      const maxIdx = offset + windowLength + nWinMinusOne * windowAdvance; // 1-based inclusive
      let nData = 0;
      for (let r1 = 1 + offset; r1 <= maxIdx; r1++) {
        const y = r1 - 1;
        if (!goodRowFlag[y]) continue;
        for (let j = 0; j < nSeries; j++) if (notNA[y][j]) nData++;
      }
      // >= keeps the LAST (largest) offset among ties, matching
      // offsets[n - which.max(rev(n.data)) + 1].
      if (nData >= bestData) { bestData = nData; bestOffset = offset; }
    }
    firstStart = bestOffset + 1;
  }

  // window start indices (1-based), seq(firstStart, nYears-windowLength+1, by=advance)
  const starts = [];
  for (let s = firstStart; s <= nYears - windowLength + 1; s += windowAdvance) starts.push(s);

  const out = [];
  for (const s of starts) {
    const eIdx = s + windowLength - 1;      // 1-based inclusive end row
    const startYear = years[s - 1];
    const endYear = years[eIdx - 1];
    const midYear = Math.floor((startYear + endYear) / 2);
    const rows = [];                        // 0-based rows in window
    for (let r = s - 1; r <= eIdx - 1; r++) rows.push(r);

    // between-tree pairwise correlations
    let rsumBt = 0, nBt = 0;
    const goodFlag = new Array(nSeries).fill(false);
    for (let i = 0; i < nSeries - 1; i++) {
      for (let j = i + 1; j < nSeries; j++) {
        const { r, nGood } = pairCor(cols[i], cols[j], rows);
        if (nGood >= minCorrOverlap && nGood > 0 && !isNaN(r)) {
          rsumBt += r; nBt++;
          goodFlag[i] = true; goodFlag[j] = true;
        }
      }
    }

    const rbarTot = nBt > 0 ? rsumBt / nBt : NaN;

    // presence counts over the window (cores == trees here)
    let nTrees = 0;
    for (let j = 0; j < nSeries; j++) {
      let any = false;
      for (let k = 0; k < rows.length; k++) { if (notNA[rows[k]][j]) { any = true; break; } }
      if (any) nTrees++;
    }
    const nCores = nTrees;

    let n = 0;
    for (let j = 0; j < nSeries; j++) if (goodFlag[j]) n++;

    // n.wt == 0 branch: rbar.eff = rbar.bt = rbar.tot when nBt > 0.
    const rbarEff = nBt > 0 ? rbarTot : NaN;
    const eps = n * rbarEff / ((n - 1) * rbarEff + 1);

    out.push({ startYear, midYear, endYear, nCores, nTrees, n, rbarTot, eps });
  }
  return out;
}

// Convenience wrapper matching ringdater's R_bar_EPS invocation exactly.
function rBarEps(rwl, window) {
  return rwiStatsRunning(rwl, {
    windowLength: window,
    windowOverlap: Math.floor(window / 2),
    firstStart: null,
    minCorrOverlap: Math.min(30, window),
    zeroIsMissing: true
  });
}

module.exports = { rwiStatsRunning, rBarEps };
