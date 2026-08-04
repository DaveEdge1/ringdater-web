'use strict';
// Parity test for src/viz/chartUtils.js against R ground truth
// (chartutils_gt.json). Exits nonzero on any mismatch. R is the oracle.
const fs = require('fs');
const path = require('path');
const { xScaleBar, yScaleBar, colPal, rDateRTheme } = require('../src/viz/chartUtils');

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'chartutils_gt.json'), 'utf8'));

let fails = 0;
const fail = (msg) => { console.error('FAIL: ' + msg); fails++; };

// numbers must be bit-exact (both sides are integer-step arithmetic in double)
function numArrEq(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- scale bars (must be exact) --------------------------------------------
let sbX = 0, sbY = 0;
for (const c of gt.scalebar) {
  const got = c.fn === 'x' ? xScaleBar(c.min, c.max) : yScaleBar(c.min, c.max);
  if (!numArrEq(got, c.breaks)) {
    fail(`${c.fn}ScaleBar(${c.min},${c.max}) JS=${JSON.stringify(got)} R=${JSON.stringify(c.breaks)}`);
  } else if (c.fn === 'x') sbX++; else sbY++;
}
console.log(`scalebar: xScaleBar ${sbX} cases, yScaleBar ${sbY} cases exact`);

// ---- col_pal (must be exact string equality) -------------------------------
let cp = 0;
for (const c of gt.colpal) {
  const got = colPal(c.scale);
  const ok = Array.isArray(got) && got.length === c.colors.length &&
             got.every((v, i) => v === c.colors[i]);
  if (!ok) fail(`colPal(${c.scale}) JS=${JSON.stringify(got)} R=${JSON.stringify(c.colors)}`);
  else cp++;
}
console.log(`colpal: ${cp} ramps exact`);

// ---- error parity spot checks ----------------------------------------------
function expectThrow(fn, label) {
  try { fn(); fail(`${label} did not throw`); }
  catch (e) { /* expected */ }
}
expectThrow(() => xScaleBar(10, 5), 'xScaleBar max<=min');
expectThrow(() => yScaleBar(5, 5), 'yScaleBar max==min');
expectThrow(() => colPal(0), 'colPal(0)');
expectThrow(() => colPal(5), 'colPal(5)');

// ---- rDateRTheme smoke (no numeric R target; structural checks) ------------
const th = rDateRTheme({ text_size: 14, line_width: 2, l: 8, leg_size: 4 });
if (th.text.size !== 14) fail('theme text size');
if (th.axis.line.width !== 2 || th.axis.line.color !== 'black') fail('theme axis line');
if (th.axis.ticks.width !== 2) fail('theme axis ticks width');
if (th.panel.background !== 'none') fail('theme panel blank');
if (th.gridMajor.color !== 'grey' || th.gridMajor.lineType !== 'dashed' || th.gridMajor.width !== 0.5) fail('theme grid major');
if (th.legend.position !== 'bottom') fail('theme legend position');
if (th.legend.keyWidth !== '4cm') fail('theme legend key width');
if (th.plotMargin.l !== 8 || th.plotMargin.t !== 10) fail('theme plot margin');
if (th.axis.tickLength !== '0.25cm') fail('theme tick length');
const dflt = rDateRTheme();
if (dflt.text.size !== 12 || dflt.legend.keyWidth !== '3cm' || dflt.plotMargin.l !== 10) fail('theme defaults');
expectThrow(() => rDateRTheme({ text_size: 0 }), 'theme text_size<=0');
expectThrow(() => rDateRTheme({ line_width: -1 }), 'theme line_width<=0');
console.log('rDateRTheme: structural checks ok');

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nALL PASS');
