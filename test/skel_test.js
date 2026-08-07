'use strict';
// ============================================================================
// skel_test.js — validation of the skeleton-plot maths (hanning + skelValues)
// and the skelPlot builder. No R available in this environment for a numeric
// ground-truth diff, so we check the dplR algorithm's structural invariants on a
// controlled synthetic series (marks land on the planted narrow rings, heights
// in 3..10, edges NA) plus that skelPlot returns a well-formed, renderable spec.
// Nonzero exit on any failure.
// ============================================================================
const { RD } = require('../web/ringdater.bundle.js');
const { skelValues, hanning, skelPlot, renderSvg } = RD;

let fails = 0;
function ok(name, cond, extra) {
  if (!cond) fails++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
}

// ---- hanning: centred, normalised, NA at the ends ----
const flat = new Array(20).fill(1);
const hf = hanning(flat, 9);
ok('hanning preserves a constant in the interior', Math.abs(hf[10] - 1) < 1e-12, 'h[10]=' + hf[10]);
ok('hanning NA at the ends (filt 9 -> first/last 4)', [0, 1, 2, 3].every(i => Number.isNaN(hf[i])) && [16, 17, 18, 19].every(i => Number.isNaN(hf[i])));

// ---- skelValues on a synthetic series with known narrow rings ----
const rw = [];
for (let i = 0; i < 40; i++) rw.push(5 + Math.sin(i) * 0.3);
rw[10] = 2.0; rw[20] = 0.5; rw[30] = 3.0;      // planted narrow rings; 20 is narrowest
const sk = skelValues(rw, 9);
const marks = [];
for (let i = 0; i < sk.length; i++) if (!Number.isNaN(sk[i])) marks.push([i, sk[i]]);
const markPos = marks.map(m => m[0]);
ok('marks fall on the planted narrow rings', [10, 20, 30].every(p => markPos.includes(p)), markPos.join(','));
ok('all heights are integers in 3..10', marks.every(m => Number.isInteger(m[1]) && m[1] >= 3 && m[1] <= 10));
ok('narrowest ring (pos 20) gets the tallest mark (10)', sk[20] === 10, 'sk[20]=' + sk[20]);
ok('first/last rings are NA (no neighbours)', Number.isNaN(sk[0]) && Number.isNaN(sk[sk.length - 1]));
ok('a wide/average ring is not marked', Number.isNaN(sk[15]), 'sk[15]=' + sk[15]);

// ---- divisor guard: zero-crossing (detrended-style) input must never mark a
// ring that is not genuinely narrower than its neighbours. Where the hanning
// divisor goes nonpositive the unguarded dplR formula flips sign and marks
// locally WIDE rings (the spike at 30 below); the guard NaNs those instead. ----
const zc = [];
for (let i = 0; i < 20; i++) zc.push(1.2 + 0.1 * Math.sin(i));
zc[10] = 0.3;                                   // true narrow ring
for (let i = 20; i < 40; i++) zc.push(-1.0 + 0.05 * Math.sin(i));
zc[30] = -0.2;                                  // locally WIDE ring, negative span
for (let i = 40; i < 60; i++) zc.push(1.2 + 0.1 * Math.sin(i));
const skz = skelValues(zc, 9);
let flipped = 0;
for (let i = 1; i < zc.length - 1; i++) {
  if (!Number.isNaN(skz[i]) && !(zc[i] <= (zc[i - 1] + zc[i + 1]) / 2)) flipped++;
}
ok('no marks on non-narrow rings (nonpositive-divisor guard)', flipped === 0, flipped + ' flipped marks');
ok('true narrow ring still marked on zero-crossing input', skz[10] === 10, 'skz[10]=' + skz[10]);

// ---- skelPlot builder: valid spec + renderable SVG ----
const frame = {
  names: ['year', 'A', 'B'],
  cols: [
    Array.from({ length: 40 }, (_, i) => i),
    rw.slice(),
    rw.slice(),                                 // identical -> should align at lag 0
  ],
};
// per-panel mark order (fixed contract): [0] grid, [1] baseline, [2] master, [3] sample
const spec = skelPlot(frame, 'A', 'B', 0, {});
ok('skelPlot returns decade-aligned row panels', spec && Array.isArray(spec.panels) && spec.panels.length >= 1 &&
  spec.panels.every(p => p.marks.length === 4 && p.marks.every(m => m.type === 'segment')),
  spec.panels ? spec.panels.length + ' panels' : 'no panels');
ok('skelPlot master marks point down, sample up',
  spec.panels.every(p => p.marks[2].y1.every(v => v <= 0)) &&
  spec.panels.every(p => p.marks[3].y1.every(v => v >= 0)));
ok('skelPlot exposes skeleton data', spec.data && Array.isArray(spec.data.skel_1) && Array.isArray(spec.data.skel_2));
const svg = renderSvg(spec);
ok('skelPlot renders a well-formed non-empty SVG', typeof svg === 'string' && /^<svg[\s\S]*<\/svg>$/.test(svg.trim()) && svg.length > 200, svg.length + ' chars');

// every mark is drawn in the row panel whose x-domain contains it
ok('marks land in their own row panel', spec.panels.every(function (p) {
  var d = p.scales.x.domain;
  return p.marks[2].x0.concat(p.marks[3].x0).every(function (x) { return x >= d[0] && x < d[1]; });
}));

// lag shifts the sample marks by exactly `lag` on the x axis
function firstSampleX(s) {
  var xs = [];
  s.panels.forEach(function (p) { xs = xs.concat(p.marks[3].x0); });
  return Math.min.apply(null, xs);
}
const spec5 = skelPlot(frame, 'A', 'B', 5, {});
ok('lag shifts sample marks by +lag', firstSampleX(spec5) - firstSampleX(spec) === 5);

// a multi-century span wraps into multiple 120-year rows at fixed scale
const longRw = [];
for (let i = 0; i < 300; i++) longRw.push(5 + Math.sin(i) * 0.3 + (i % 47 === 0 ? -3 : 0));
const longFrame = { names: ['year', 'A', 'B'], cols: [Array.from({ length: 300 }, (_, i) => i + 1001), longRw.slice(), longRw.slice()] };
const specL = skelPlot(longFrame, 'A', 'B', 0, {});
ok('300-year series wraps into multiple decade-aligned 120-year rows',
  specL.panels.length >= 2 &&
  specL.panels[0].scales.x.domain[0] % 10 === 0 &&
  specL.panels.every(p => p.scales.x.domain[1] - p.scales.x.domain[0] === 120),
  specL.panels.length + ' panels from ' + specL.panels[0].scales.x.domain[0]);
ok('long-series SVG renders', /^<svg[\s\S]*<\/svg>$/.test(renderSvg(specL).trim()));

// ---- the plot window is the data overlap +10% each side ----
// A occupies rows 0..99, B rows 50..149 -> overlap [50,99], ext 5 -> [45,104].
{
  const n = 150;
  const noisy = i => 5 + Math.sin(i * 1.7) * 1.5;
  const colA = Array.from({ length: n }, (_, i) => (i < 100 ? noisy(i) : null));
  const colB = Array.from({ length: n }, (_, i) => (i >= 50 ? noisy(i + 3) : null));
  const fr = { names: ['year', 'A', 'B'], cols: [Array.from({ length: n }, (_, i) => i), colA, colB] };
  const sp = skelPlot(fr, 'A', 'B', 0, {});
  ok('window = overlap extended 10%', sp.data.overlap[0] === 50 && sp.data.overlap[1] === 99 &&
    sp.data.window[0] === 45 && sp.data.window[1] === 104,
    'overlap=' + sp.data.overlap + ' window=' + sp.data.window);
  const allMarkX = [];
  sp.panels.forEach(p => { allMarkX.push.apply(allMarkX, p.marks[2].x0.concat(p.marks[3].x0)); });
  ok('all marks inside the window', allMarkX.every(x => x >= 45 && x <= 104), JSON.stringify(allMarkX));
  ok('single 120-year row covers the window', sp.panels.length === 1 && sp.panels[0].scales.x.domain[0] === 40);
}

// ---- density matching: an outlier-dominated series is topped up to the
// denser series' dplR mark count instead of showing almost no marks ----
{
  const n = 120;
  // "chronology": gentle variation + one extreme narrow outlier -> dplR yields ~1 mark
  const chronCol = Array.from({ length: n }, (_, i) => 5 + Math.sin(i) * 0.25);
  chronCol[60] = 0.05;
  // "sample": strong variation -> many dplR marks
  const sampCol = Array.from({ length: n }, (_, i) => 5 + Math.sin(i * 1.7) * 2);
  const fr = { names: ['year', 'M', 'S'], cols: [Array.from({ length: n }, (_, i) => i), chronCol, sampCol] };
  const sp = skelPlot(fr, 'M', 'S', 0, {});
  const mMarks = [], sMarks = [];
  sp.panels.forEach(p => { mMarks.push.apply(mMarks, p.marks[2].x0); sMarks.push.apply(sMarks, p.marks[3].x0); });
  ok('sparser series topped up to matching density', mMarks.length === sMarks.length && mMarks.length >= 5,
    mMarks.length + ' vs ' + sMarks.length + ' (k=' + sp.data.marksPerSeries + ')');
  // the outlier is still the tallest master mark
  const outlierPanel = sp.panels.find(p => p.scales.x.domain[0] <= 60 && 60 < p.scales.x.domain[1]);
  const oi = outlierPanel.marks[2].x0.indexOf(60);
  ok('outlier narrow ring keeps the tallest (10) mark', oi >= 0 && outlierPanel.marks[2].y1[oi] === -10);
}

console.log('');
if (fails) { console.log('SKEL: ' + fails + ' FAIL'); process.exit(1); }
console.log('PASS: skeleton-plot maths + builder (dplR skel.plot port).');
