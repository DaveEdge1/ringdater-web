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
const spec = skelPlot(frame, 'A', 'B', 0, {});
ok('skelPlot returns a spec with 3 segment marks', spec && spec.marks && spec.marks.length === 3 && spec.marks.every(m => m.type === 'segment'));
ok('skelPlot master marks point down, sample up', spec.marks[1].y1.every(v => v <= 0) && spec.marks[2].y1.every(v => v >= 0));
ok('skelPlot exposes skeleton data', spec.data && Array.isArray(spec.data.skel_1) && Array.isArray(spec.data.skel_2));
const svg = renderSvg(spec);
ok('skelPlot renders a well-formed non-empty SVG', typeof svg === 'string' && /^<svg[\s\S]*<\/svg>$/.test(svg.trim()) && svg.length > 200, svg.length + ' chars');

// lag shifts the sample marks by exactly `lag` on the x axis
const spec5 = skelPlot(frame, 'A', 'B', 5, {});
ok('lag shifts sample marks by +lag', spec5.marks[2].x0[0] - spec.marks[2].x0[0] === 5);

console.log('');
if (fails) { console.log('SKEL: ' + fails + ' FAIL'); process.exit(1); }
console.log('PASS: skeleton-plot maths + builder (dplR skel.plot port).');
