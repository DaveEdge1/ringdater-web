'use strict';
// Minimal Gauss-Newton nonlinear least squares with step-halving, approximating
// R's stats::nls() default (Gauss-Newton, relative-offset convergence). Not
// bit-exact with R's iteration, but converges to the same least-squares optimum
// for the well-conditioned growth models used in detrending.

// Solve a small dense linear system A x = b by Gaussian elimination w/ partial pivot.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.slice().concat(b[i]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-300) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

// model(params, i) -> predicted y at index i (i is 0-based; caller maps to t=i+1)
// grad(params, i) -> array of d model / d param_j
// Returns {params, fitted, converged} or null on failure.
function gaussNewton(y, model, grad, start, opts = {}) {
  const maxit = opts.maxit || 50;   // R's nls default maxiter
  const tol = opts.tol || 1e-8;
  const n = y.length, p = start.length;
  let params = start.slice();
  let prevRss = Infinity;
  for (let iter = 0; iter < maxit; iter++) {
    // residuals and Jacobian
    const r = new Array(n), J = new Array(n);
    let rss = 0;
    for (let i = 0; i < n; i++) {
      const f = model(params, i);
      if (!isFinite(f)) return null;
      r[i] = y[i] - f;
      rss += r[i] * r[i];
      J[i] = grad(params, i);
    }
    // normal equations: (JtJ) delta = Jt r
    const JtJ = Array.from({ length: p }, () => new Array(p).fill(0));
    const Jtr = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < p; a++) {
        Jtr[a] += J[i][a] * r[i];
        for (let b = a; b < p; b++) JtJ[a][b] += J[i][a] * J[i][b];
      }
    }
    for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) JtJ[a][b] = JtJ[b][a];
    const delta = solve(JtJ, Jtr);
    if (!delta) return null;
    // step-halving: accept the largest fraction of delta that lowers RSS
    let step = 1, newParams, newRss;
    for (let h = 0; h < 30; h++) {
      newParams = params.map((v, j) => v + step * delta[j]);
      newRss = 0;
      let ok = true;
      for (let i = 0; i < n; i++) {
        const f = model(newParams, i);
        if (!isFinite(f)) { ok = false; break; }
        const e = y[i] - f; newRss += e * e;
      }
      if (ok && newRss <= rss) break;
      step /= 2;
      if (h === 29) return null;
    }
    params = newParams;
    if (Math.abs(prevRss - newRss) <= tol * (newRss + tol)) {
      const fitted = params.map((_, i) => 0);
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = model(params, i);
      return { params, fitted: out, converged: true };
    }
    prevRss = newRss;
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = model(params, i);
  return { params, fitted: out, converged: false };
}

module.exports = { gaussNewton, solve };
