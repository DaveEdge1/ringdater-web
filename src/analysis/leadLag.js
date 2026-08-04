'use strict';
// ============================================================================
// lead_lag_analysis — the ringdater crossdating engine (port of
// R/lead_lag_analysis_function.R). Slides each series pair across a range of
// lags, computes Pearson cor.test at every lag over the complete-cases overlap,
// and returns two Frames:
//   masterLeadLag : the full per-pair lag x (lag,R_Val,P_Val,T_val,Overlap,
//                   First_ring,Last_ring) grid, ragged, assembled with combNA;
//                   columns prefixed  ser_1_<idA>_ser_2_<idB>_<field>.
//   crossDatRes   : best-3-matches-per-series summary, 17 fixed columns, with
//                   per-series header rows and NA separator rows between blocks.
//
// mode 1 = pairwise (every unordered pair a<b). mode 2 = chronology (only the
// master in column 2 vs every other series). complete=true overrides neg/pos_lag
// with the full overlap range (+-max(len_a,len_b)).
//
// Uses the shared Frame contract (comb.js) and pearsonCorTest (cortest.js).
// ============================================================================

const { combNA, isNA, NA } = require('./comb.js');
const { pearsonCorTest } = require('../stats/cortest.js');

const N_LIMIT = 5;

// 17 fixed column names for crossDatRes (other tasks depend on this contract).
const CROSS_NAMES = [
  'Series_1', 'Series_2', 'First_ring', 'Last_ring', 'col',
  'First_lag', 'First_R', 'First_P', 'First_Overlap',
  'Sec_lag', 'Sec_R', 'Sec_P', 'Sec_Overlap',
  'Third_lag', 'Third_R', 'Third_P', 'Third_Overlap',
];
const RES_FIELDS = ['lag', 'R_Val', 'P_Val', 'T_val', 'Overlap', 'First_ring', 'Last_ring'];

// min / max over an array ignoring NA (returns NA if none).
function minNA(a) { let m = Infinity, any = false; for (const v of a) if (!isNA(v)) { any = true; if (v < m) m = v; } return any ? m : NA; }
function maxNA(a) { let m = -Infinity, any = false; for (const v of a) if (!isNA(v)) { any = true; if (v > m) m = v; } return any ? m : NA; }

// Build the shifted overlap for a given lag and return the paired complete-cases
// values of (mod_ser_1, mod_ser_2). Mirrors the R c(NA..)/comb.NA + complete.cases.
function shiftedOverlap(seriesA, seriesB, lag) {
  let mod1, mod2;
  if (lag <= -1) {
    const pad = Array(Math.abs(lag)).fill(NA);
    mod1 = pad.concat(seriesA);
    mod2 = seriesB.concat(pad);
  } else if (lag === 0) {
    mod1 = seriesA.slice();
    mod2 = seriesB.slice();
  } else { // lag >= 1
    const pad = Array(lag).fill(NA);
    mod1 = seriesA.concat(pad);
    mod2 = pad.concat(seriesB);
  }
  const n = Math.max(mod1.length, mod2.length);
  const x = [], y = [];
  for (let i = 0; i < n; i++) {
    const v1 = i < mod1.length ? mod1[i] : NA;
    const v2 = i < mod2.length ? mod2[i] : NA;
    if (!isNA(v1) && !isNA(v2)) { x.push(v1); y.push(v2); }
  }
  return { x, y };
}

// main entry -----------------------------------------------------------------
function leadLag(frame, opts = {}) {
  const mode = opts.mode != null ? opts.mode : 1;
  let negLagOpt = opts.neg_lag != null ? opts.neg_lag : -20;
  let posLagOpt = opts.pos_lag != null ? opts.pos_lag : 20;
  const complete = opts.complete != null ? opts.complete : true;

  const multiple = (mode === 1);

  // de.tnd <- subset(the_data, !is.na(the_data[,1]))  (drop rows with NA year)
  const rawYear = frame.cols[0];
  const keep = [];
  for (let r = 0; r < rawYear.length; r++) if (!isNA(rawYear[r])) keep.push(r);
  const cols = frame.cols.map(c => keep.map(r => c[r]));
  const seriesIDs = frame.names.slice();   // 1-based R index i -> seriesIDs[i-1]
  const noSeries = cols.length;            // ncol(de.tnd)  (R 1-based count)
  const years = cols[0].map(v => (isNA(v) ? NA : +v));

  // crossDatRes assembled as a mixed-type Frame ({names, cols}); cols 0,1 hold
  // strings/NA (series ids), cols 2..16 hold numbers/NA.
  const crossCols = CROSS_NAMES.map(() => []);
  const pushCrossRow = (row) => { for (let j = 0; j < 17; j++) crossCols[j].push(row[j]); };

  let master = { names: [], cols: [] };    // grows via combNA (empty -> placeholder col)

  let a = 2;                               // R 1-based column index
  for (;;) {
    let b = a + 1;
    for (;;) {
      const seriesA = cols[a - 1];
      const seriesB = cols[b - 1];

      // measured span (unshifted) of each series, from (year,value) complete cases
      let aMin = NA, aMax = NA, aLen = 0, bLen = 0;
      for (let i = 0; i < years.length; i++) {
        if (!isNA(years[i]) && !isNA(seriesA[i])) { aLen++; const y = years[i]; if (isNA(aMin) || y < aMin) aMin = y; if (isNA(aMax) || y > aMax) aMax = y; }
      }
      for (let i = 0; i < years.length; i++) if (!isNA(seriesB[i])) bLen++;
      // ser_a_len / ser_b_len are counts of non-NA values (independent of year)
      let aCount = 0; for (const v of seriesA) if (!isNA(v)) aCount++;
      let bCount = 0; for (const v of seriesB) if (!isNA(v)) bCount++;

      const posLagLim = Math.max(aCount, bCount);
      const negLagLim = -Math.max(aCount, bCount);

      let posLag = posLagOpt, negLag = negLagOpt;
      if (complete) { posLag = posLagLim; negLag = negLagLim; }
      const maxPosLag = posLag > posLagLim ? posLagLim : posLag;
      const maxNegLag = negLag < negLagLim ? negLagLim : negLag;
      const correction = maxPosLag - maxNegLag;

      // per-lag results table (parallel arrays over the 7 fields)
      const resLag = [], resR = [], resP = [], resT = [], resOver = [], resFirst = [], resLast = [];
      for (let lag = maxNegLag; ; lag++) {
        // shifted date range of series_b: (years where b present) + lag
        let sMin = NA, sMax = NA;
        for (let i = 0; i < years.length; i++) {
          if (!isNA(years[i]) && !isNA(seriesB[i])) { const y = years[i] + lag; if (isNA(sMin) || y < sMin) sMin = y; if (isNA(sMax) || y > sMax) sMax = y; }
        }
        const { x, y } = shiftedOverlap(seriesA, seriesB, lag);
        let rVal = 0, pVal = 0, tVal = 0, over = 0;
        if (x.length >= N_LIMIT) {
          const ct = pearsonCorTest(x, y);
          rVal = ct.r;
          pVal = ct.p * correction;
          tVal = ct.t;
          over = Math.round(x.length);
        }
        resLag.push(lag); resR.push(rVal); resP.push(pVal); resT.push(tVal);
        resOver.push(over); resFirst.push(sMin); resLast.push(sMax);
        if (lag >= maxPosLag) break;
      }

      // ---- master_lead_lag: append this pair's 7 columns (ragged via combNA) --
      const prefix = 'ser_1_' + seriesIDs[a - 1] + '_ser_2_' + seriesIDs[b - 1] + '_';
      const pairCols = [resLag, resR, resP, resT, resOver, resFirst, resLast];
      const tmpFrame = { names: RES_FIELDS.map(f => prefix + f), cols: pairCols };
      master = combNA(master, tmpFrame);

      // ---- crossDatRes: filter R_Val>0, order by P_Val ascending (stable) -----
      const idx = [];
      for (let i = 0; i < resR.length; i++) if (resR[i] > 0) idx.push(i);
      idx.sort((i, j) => (resP[i] - resP[j]) || (i - j)); // stable: keep lag order on ties
      const pick = (rank, field) => {
        if (rank >= idx.length) return NA;
        const i = idx[rank];
        switch (field) {
          case 'lag': return resLag[i];
          case 'R': return resR[i];
          case 'P': return resP[i];
          case 'Overlap': return resOver[i];
          case 'First_ring': return resFirst[i];
          case 'Last_ring': return resLast[i];
        }
      };

      // header row for a new series block (first pair for this a)
      if (b === a + 1) {
        pushCrossRow([seriesIDs[a - 1], seriesIDs[a - 1], aMin, aMax, a,
          NA, NA, NA, NA, NA, NA, NA, NA, NA, NA, NA, NA]);
      }
      // result row for pair (a,b)
      pushCrossRow([
        seriesIDs[a - 1], seriesIDs[b - 1], pick(0, 'First_ring'), pick(0, 'Last_ring'), b,
        pick(0, 'lag'), pick(0, 'R'), pick(0, 'P'), pick(0, 'Overlap'),
        pick(1, 'lag'), pick(1, 'R'), pick(1, 'P'), pick(1, 'Overlap'),
        pick(2, 'lag'), pick(2, 'R'), pick(2, 'P'), pick(2, 'Overlap'),
      ]);

      b += 1;
      if (b > noSeries) break;
    }
    // NA separator row after each series-a block
    pushCrossRow(Array(17).fill(NA));

    if (multiple) {
      a += 1;
      if (a >= noSeries) break;
    } else break;
  }

  const crossDatRes = { names: CROSS_NAMES.slice(), cols: crossCols };
  return { crossDatRes, masterLeadLag: master };
}

module.exports = { leadLag };
