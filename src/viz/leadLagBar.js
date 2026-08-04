'use strict';
// leadLagBar — bar chart of T-value vs lag for one series pair, with the best,
// 2nd and 3rd matches highlighted red / blue / green (port of
// R/lead_lag_bar_function.R). `theData` is the masterLeadLag Frame (columns
// prefixed ser_1_<s1>_ser_2_<s2>_<field>). The chart:
//   selected = rows with R_Val > 0        (subset(selected, R_Val>0))
//   ordered  = selected ordered by P_Val ascending (stable)
//   best/second/third = ordered[0..2]      (coloured red/blue/green over black)

const C = require('../analysis/comb.js');
const { xScaleBar } = require('./chartUtils.js');
const { toSVG, roundR } = require('./render.js');

const FIELDS = ['lag', 'R_Val', 'P_Val', 'T_val', 'Overlap', 'First_ring', 'Last_ring'];

function leadLagBarData(theData, sample1, sample2) {
  const f = C.asFrame(theData);
  const prefix = `ser_1_${sample1}_ser_2_${sample2}_`;
  const get = field => {
    const c = C.colByName(f, prefix + field);
    if (c === undefined) throw new Error('Error in lead_lag_bar(): Results not found for selected samples');
    return c;
  };
  const cols = {}; for (const fld of FIELDS) cols[fld] = get(fld);

  // rows with R_Val > 0, preserving original (lag-ascending) order
  const rows = [];
  for (let i = 0; i < cols.lag.length; i++) {
    if (!C.isNA(cols.R_Val[i]) && cols.R_Val[i] > 0) {
      rows.push({ lag: +cols.lag[i], R_Val: +cols.R_Val[i], P_Val: +cols.P_Val[i], T_val: +cols.T_val[i], i });
    }
  }
  // stable order by P_Val ascending (R order() keeps input order on ties)
  const ordered = rows.map(r => r).sort((a, b) => (a.P_Val - b.P_Val) || (a.i - b.i));
  return { selected: rows, ordered, best: ordered[0], second: ordered[1], third: ordered[2] };
}

function leadLagBar(theData, sample1, sample2, opts = {}) {
  const { selected, best, second, third } = leadLagBarData(theData, sample1, sample2);

  const lag = selected.map(r => r.lag);
  const tval = selected.map(r => r.T_val);
  const rank = new Map();
  if (best) rank.set(best.i, 'red');
  if (second) rank.set(second.i, 'blue');
  if (third) rank.set(third.i, 'green');
  const colors = selected.map(r => rank.get(r.i) || 'black');

  const xMin = roundR(Math.min(...lag), -1);
  const xMax = roundR(Math.max(...lag), -1);

  const spec = {
    type: 'leadLagBar',
    width: opts.width || 760,
    height: opts.height || 300,
    title: opts.title || `${sample1} vs ${sample2} lead-lag`,
    xLabel: 'Lag (Year)',
    yLabel: 'T_val',
    scales: {
      x: { domain: [Math.min(...lag), Math.max(...lag)], breaks: xScaleBar(xMin, xMax) },
      y: { domain: [Math.min(0, ...tval), Math.max(0, ...tval)], breaks: null },
    },
    marks: [{ type: 'bar', x: lag, y: tval, colors, baseline: 0 }],
    legend: { entries: [
      { label: 'best', color: 'red' }, { label: '2nd', color: 'blue' }, { label: '3rd', color: 'green' },
    ] },
    colourbar: null,
    data: {
      lag, T_val: tval, colors,
      best: best ? { lag: best.lag, T_val: best.T_val, P_Val: best.P_Val } : null,
      second: second ? { lag: second.lag, T_val: second.T_val, P_Val: second.P_Val } : null,
      third: third ? { lag: third.lag, T_val: third.T_val, P_Val: third.P_Val } : null,
    },
  };
  return spec;
}

module.exports = { leadLagBar, leadLagBarData, toSVG };
