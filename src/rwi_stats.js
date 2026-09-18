'use strict';
// Port of dplR's rwi.stats.running (Rbar / EPS running chronology statistics),
// specialised for the regime ringdater's R_bar_EPS actually uses:
//   method="pearson", running.window=TRUE, ids=NULL, prewhiten=FALSE, n=NULL,
//   period="max", first.start=NULL, zero.is.missing=TRUE.
//
// By default every series is its own tree with a single core, so the
// between/within-tree machinery collapses: there is no within-tree term
// (n.wt == 0 always) and rbar.tot == rbar.bt == rbar.eff. That is dplR's
// behaviour with ids=NULL and is what R_bar_EPS has always produced here.
//
// TREES. Most collections take two or more radii from each tree, and two radii
// of one tree share wood, not just climate — on chronologies/ut550.rwl (110
// cores from 60 trees) the mean correlation within a tree is 0.663 against 0.361
// between trees. Counting cores as independent replicates therefore overstates
// how well a site is sampled. Pass `treeOf` (or `inferTrees`) and the full dplR
// machinery runs: rbar.wt, rbar.bt, the effective correlation rbar.eff, and an
// EPS on the number of TREES rather than cores. At full sample depth the
// difference is cosmetic (EPS .985 vs .971 on ut550); at the old end of a
// chronology, where the question is whether a stretch is usable at all, the two
// conventions disagree — 12 cores from 6 trees give EPS .873 per core and .772
// per tree, either side of the conventional .85.
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
// rbar.tot and eps from rwi.stats.running. With `treeOf` supplied each row also
// carries rbarWt, rbarBt, rbarEff, epsCores, snr and sss.

// ---------------------------------------------------------------------------
// inferTrees(ids) — group core ids into trees.
//
// The ITRDB convention is SITE + tree number + core letter, so RCB010A and
// RCB010B are two radii of tree RCB010. Stripping trailing letters recovers
// that. It is only applied where it actually groups something: if no two ids
// share a stem the ids are left alone, so a collection that names cores some
// other way is not silently mangled. Callers should show the grouping and let
// it be corrected — it changes EPS.
// ---------------------------------------------------------------------------
function inferTrees(ids) {
  // Strip a trailing run of letters ONLY when what remains ends in a digit, which
  // is what the convention actually says: site code + tree NUMBER + core letter.
  // Without that guard any ids ending in a letter collapse together — the test
  // fixture's sample_a .. sample_j all became the single tree "sample_", and a
  // wrong grouping silently changes EPS.
  const stem = id => {
    const t = String(id).replace(/[A-Za-z]+$/, '');
    return (t.length && /\d$/.test(t)) ? t : String(id);
  };
  const groups = new Map();
  for (const id of ids) {
    const k = stem(id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(id);
  }
  let grouped = false;
  for (const v of groups.values()) if (v.length > 1) { grouped = true; break; }
  const treeOf = {};
  for (const id of ids) treeOf[id] = grouped ? stem(id) : String(id);
  const trees = {};
  for (const id of ids) (trees[treeOf[id]] = trees[treeOf[id]] || []).push(id);
  return { treeOf, trees, nTrees: Object.keys(trees).length, grouped };
}

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

  // Tree grouping. `treeOf` is an explicit {coreId: treeId} map; `inferTrees:true`
  // derives one from the ids. Neither given = dplR's ids=NULL, every core its own
  // tree, which is what every existing caller gets.
  let treeOf = null;
  if (opts.treeOf) treeOf = opts.treeOf;
  else if (opts.inferTrees) treeOf = inferTrees(ids).treeOf;
  const treeIdx = treeOf ? ids.map(id => (treeOf[id] != null ? String(treeOf[id]) : String(id))) : null;

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

    // Pairwise correlations, split into pairs from the SAME tree (two radii of
    // one stem) and pairs from different trees. With no tree map every pair is
    // between-tree and this reduces exactly to what it did before.
    let rsumBt = 0, nBt = 0, rsumWt = 0, nWt = 0;
    const goodFlag = new Array(nSeries).fill(false);
    for (let i = 0; i < nSeries - 1; i++) {
      for (let j = i + 1; j < nSeries; j++) {
        const { r, nGood } = pairCor(cols[i], cols[j], rows);
        if (nGood >= minCorrOverlap && nGood > 0 && !isNaN(r)) {
          if (treeIdx && treeIdx[i] === treeIdx[j]) { rsumWt += r; nWt++; }
          else { rsumBt += r; nBt++; }
          goodFlag[i] = true; goodFlag[j] = true;
        }
      }
    }

    const rbarWt = nWt > 0 ? rsumWt / nWt : NaN;
    const rbarBt = nBt > 0 ? rsumBt / nBt : NaN;
    const rbarTot = (nWt + nBt) > 0 ? (rsumWt + rsumBt) / (nWt + nBt) : NaN;

    // presence counts over the window
    let nCores = 0;
    const treesPresent = treeIdx ? new Set() : null;
    for (let j = 0; j < nSeries; j++) {
      let any = false;
      for (let k = 0; k < rows.length; k++) { if (notNA[rows[k]][j]) { any = true; break; } }
      if (any) { nCores++; if (treesPresent) treesPresent.add(treeIdx[j]); }
    }
    const nTrees = treesPresent ? treesPresent.size : nCores;

    let n = 0;
    for (let j = 0; j < nSeries; j++) if (goodFlag[j]) n++;

    // dplR: with no within-tree pairs, rbar.eff = rbar.bt = rbar.tot. With them,
    // the cores of a tree are averaged down to one effective series first —
    // c.eff cores per tree, correlating rbar.wt among themselves — and EPS is
    // then computed on the number of TREES.
    let rbarEff, epsN;
    if (nWt > 0 && Number.isFinite(rbarBt) && Number.isFinite(rbarWt)) {
      const cEff = nTrees > 0 ? nCores / nTrees : 1;
      rbarEff = rbarBt / (rbarWt + (1 - rbarWt) / cEff);
      epsN = nTrees;
    } else {
      rbarEff = nBt > 0 ? rbarTot : NaN;
      epsN = n;
    }
    const eps = epsN * rbarEff / ((epsN - 1) * rbarEff + 1);

    const row = { startYear, midYear, endYear, nCores, nTrees, n, rbarTot, eps };
    if (treeIdx) {
      // EPS the old way (every core an independent replicate), kept beside the
      // tree-aware one so the convention is visible rather than assumed.
      const epsCores = n * rbarTot / ((n - 1) * rbarTot + 1);
      // Signal-to-noise and subsample signal strength, both standard companions
      // to EPS: SNR says how much common signal there is per unit of noise, SSS
      // how well this many trees represents the full collection.
      const snr = epsN * rbarEff / (1 - rbarEff);
      row.rbarWt = rbarWt; row.rbarBt = rbarBt; row.rbarEff = rbarEff;
      row.epsCores = epsCores; row.snr = snr;
      row.nWt = nWt; row.nBt = nBt;
    }
    out.push(row);
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

// subsample signal strength: how well `nTrees` trees represent `nMax` of them.
function sss(nTrees, nMax, rbarEff) {
  if (!(nTrees > 0) || !(nMax > 0) || !Number.isFinite(rbarEff)) return NaN;
  return (nTrees * (1 + (nMax - 1) * rbarEff)) / (nMax * (1 + (nTrees - 1) * rbarEff));
}

module.exports = { rwiStatsRunning, rBarEps, inferTrees, sss };
