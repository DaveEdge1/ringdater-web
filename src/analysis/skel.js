'use strict';
// Skeleton-plot maths — faithful port of dplR's hanning() + the skeleton-value
// calculation inside skel.plot(). Used by viz/skelPlot.js.
//
//   hanning(x, n)      -> centred Hann-window convolution filter (NA at the ends
//                         and wherever the window overlaps an NA), as R's
//                         filter(x, win, sides = 2, method = "convolution").
//   skelValues(rw, fw) -> integer skeleton heights 3..10 (else NaN) per ring:
//                         for each interior ring i,
//                           skel[i] = ( rw[i] - (rw[i-1]+rw[i+1])/2 ) / hanning[i]
//                         keep only negative (narrower-than-neighbours) values,
//                         rescale so the narrowest -> 10 / least -> 1, drop < 3,
//                         then ceiling() to integers (exactly dplR's steps).
//
// INPUT: raw ring widths (positive), as in dplR — the hanning division is the
// algorithm's own normalisation and assumes a positive local mean. Detrended
// series that cross zero (z-scores, first differences) make the divisor
// nonpositive and flip the narrowness sign; rings where hanning[i] <= 0 are
// therefore NaN'd (a no-op on faithful dplR inputs, which never produce them).

function hanning(x, n = 9) {
  const win = [];
  let s = 0;
  for (let k = 0; k < n; k++) { const w = 1 - Math.cos((2 * Math.PI / (n - 1)) * k); win.push(w); s += w; }
  for (let k = 0; k < n; k++) win[k] /= s;
  const m = Math.floor(n / 2), N = x.length, y = new Array(N).fill(NaN);
  for (let i = 0; i < N; i++) {
    let acc = 0, ok = true;
    for (let k = 0; k < n; k++) {
      const xi = i - m + k;
      const v = xi >= 0 && xi < N ? x[xi] : null;
      if (v == null || Number.isNaN(v)) { ok = false; break; }
      acc += win[k] * v;
    }
    if (ok) y[i] = acc;
  }
  return y;
}

function skelValues(rw, filtWeight = 9) {
  const n = rw.length;
  const dt = hanning(rw, filtWeight);
  const skel = new Array(n).fill(NaN);
  const diff = [];
  for (let i = 0; i < n - 1; i++) diff.push(rw[i + 1] - rw[i]);
  for (let i = 1; i <= n - 2; i++) {
    const a = diff[i - 1], b = -diff[i];
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(dt[i])) continue;
    if (dt[i] <= 0) continue;                    // nonpositive divisor: sign is meaningless
    skel[i] = ((a + b) / 2) / dt[i];             // = (rw[i] - mean(neighbours)) / hanning[i]
  }
  for (let i = 0; i < n; i++) if (skel[i] > 0) skel[i] = NaN;   // keep narrower-than-neighbours
  const vals = skel.filter(v => !Number.isNaN(v));
  if (vals.length) {
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const mult = (1 - 10) / ((mx - mn) || 1);     // newrange c(10, 1): narrowest -> 10
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(skel[i])) continue;
      const v = 10 + (skel[i] - mn) * mult;
      skel[i] = v < 3 ? NaN : Math.ceil(v);
    }
  }
  return skel;
}

module.exports = { hanning, skelValues };
