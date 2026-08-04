'use strict';
// Port of ringdater::auto_correl — lag 0..10 autocorrelation for each series.
// For each series column A, R computes:
//   lag 0: cor(A, A) over complete cases (== 1 when A varies)
//   lag k: dat1 = A, dat2 = c(rep(NA,k), A); comb.NA(dat1,dat2); complete.cases;
//          cor(comb[,1], comb[,2])  -> Pearson r of A[k+1..n] vs A[1..n-k]
// Returns a Frame: first column `lag` = 0..10, then one column per input series
// (named after the input series), holding the 11 correlation values.

const C = require('./comb.js');
const { pearsonCorTest } = require('../stats/cortest.js');

// Pearson r of the two-column, complete-cases overlap of dat1 vs dat2.
function corLag(dat1, dat2) {
  const comb = C.completeCases(C.combNA(dat1, dat2));
  return pearsonCorTest(C.col(comb, 0), C.col(comb, 1)).r;
}

function autoCorrel(input) {
  const f = C.asFrame(input);
  const nseries = C.ncol(f);
  if (nseries < 2) throw new Error('autoCorrel: insufficient data to calculate correlations');
  const inNames = C.names(f);

  const lag = [];
  for (let k = 0; k <= 10; k++) lag.push(k);

  const columns = [{ name: 'lag', values: lag }];
  for (let a = 1; a < nseries; a++) {
    const s = C.col(f, a);
    const rvals = [];
    for (let k = 0; k <= 10; k++) {
      const dat2 = k === 0 ? s.slice() : Array(k).fill(C.NA).concat(s);
      rvals.push(corLag(s.slice(), dat2));
    }
    columns.push({ name: inNames[a], values: rvals });
  }
  return C.frame(columns);
}

module.exports = { autoCorrel };
