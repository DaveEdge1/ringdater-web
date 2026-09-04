'use strict';
// linePlot — crossdating overlay of two standardized series (port of the DATA +
// structure of R/line_plot_function.R). series_1 is drawn black; series_2 is
// drawn red with its year column shifted by an integer `lag`. Both are reduced
// to complete cases (year, value) before plotting. x breaks come from
// x.scale.bar over the rounded (nearest 10) combined year range.

const C = require('../analysis/comb.js');
const { xScaleBar } = require('./chartUtils.js');
const { toSVG, roundR, ownAxis } = require('./render.js');

// where a series was drawn, as [first, last] x (null when it has no data)
function span(xs) { return xs.length ? [Math.min(...xs), Math.max(...xs)] : null; }

// complete-cases (x, y) as parallel numeric arrays.
function completeXY(xs, ys) {
  const x = [], y = [];
  for (let i = 0; i < xs.length; i++) if (!C.isNA(xs[i]) && !C.isNA(ys[i])) { x.push(+xs[i]); y.push(+ys[i]); }
  return { x, y };
}

function linePlot(theData, series1Nm, series2Nm, lag = 0, opts = {}) {
  const f = C.asFrame(theData);
  if (C.ncol(f) <= 2) throw new Error('Error in line_plot(). Insufficient data to calculate correlations');
  if (lag % 1 !== 0) throw new Error('Error in line_plot(). lag should be a numeric integer.');
  const years = C.col(f, 0);
  const s1 = C.colByName(f, series1Nm);
  const s2 = C.colByName(f, series2Nm);
  if (s1 === undefined) throw new Error('Error in line_plot(). series_1_nm can not be found in the loaded data.');
  if (s2 === undefined) throw new Error('Error in line_plot(). series_2_nm can not be found in the loaded data.');

  const ring = opts.ringSeries || [];       // series with no years: label rings
  const ser1 = completeXY(years, s1);
  const ser2 = completeXY(years, s2);
  ser2.x = ser2.x.map(v => v + lag);      // shift series 2 by the lag

  const allX = ser1.x.concat(ser2.x);
  const allY = ser1.y.concat(ser2.y);
  const xMin = roundR(Math.min(...allX), -1);
  const xMax = roundR(Math.max(...allX), -1);

  const spec = {
    type: 'linePlot',
    width: opts.width || 760,
    height: opts.height || 300,
    linkAxis: 'year',            // x is the shared year axis: hover-linkable
    title: `${series1Nm} (black line) and ${series2Nm} lagged by ${lag} years (red line)`,
    xLabel: 'Years',
    yLabel: 'Standardised increment width',
    scales: {
      x: { domain: [Math.min(...allX), Math.max(...allX)], breaks: xScaleBar(xMin, xMax) },
      y: { domain: [Math.min(...allY), Math.max(...allY)], breaks: null },
    },
    marks: [
      { type: 'line', x: ser1.x, y: ser1.y, color: 'black', width: opts.plot_line || 0.5 },
      { type: 'line', x: ser2.x, y: ser2.y, color: 'red', width: opts.plot_line || 0.5 },
    ],
    legend: { entries: [{ label: series1Nm, color: 'black' }, { label: series2Nm, color: 'red' }] },
    // What a hovered x is in each series' OWN numbering: series 2 was shifted
    // right by the lag to draw it, so a dated series 2 reads that much earlier;
    // an undated one (opts.ringSeries) reads as a ring count from its own first
    // ring, which is the only numbering it has. See ownAxis in render.js.
    linkSeries: [
      ownAxis(series1Nm, 'black', span(ser1.x), 0, ring.indexOf(series1Nm) >= 0),
      ownAxis(series2Nm, 'red', span(ser2.x), lag, ring.indexOf(series2Nm) >= 0),
    ],
    colourbar: null,
    // exposed plotted data (validated against R)
    data: { series_1: ser1, series_2: ser2, lag },
  };
  return spec;
}

module.exports = { linePlot, toSVG };
