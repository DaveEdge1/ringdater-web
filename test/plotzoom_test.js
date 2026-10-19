'use strict';
// ============================================================================
// plotzoom_test.js — the remembered VIEW in web/plotZoom.js.
//
// Every plot that zooms is rebuilt from scratch when anything about it changes
// (a new lag, a new candidate, another approved series), and the zoom used to
// live in the attach closure, so each of those threw the reader back out to the
// full extent — which defeats the one thing a zoom is for here: changing the
// lag WHILE zoomed in is how you see whether two series sit together at that
// lag. So the view is keyed to the plot and restored on re-render.
//
// plotZoom.js is browser-only but exports for node, and it touches the DOM only
// through the container, the rendered svg and (guarded) `document` — so the
// zoom can be driven here against hand-rolled stubs rather than a real browser.
// ============================================================================
const PlotZoom = require('../web/plotZoom.js');

let fails = 0;
function ok(name, cond, extra) {
  if (!cond) fails++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
}

console.log('plotZoom — remembered views\n');

const W = 760, H = 300;
function spec(xDomain) {
  return {
    type: 'linePlot', width: W, height: H,
    scales: { x: { domain: xDomain.slice(), breaks: [0, 100] }, y: { domain: [0, 2], breaks: [0, 1, 2] } },
    marks: []
  };
}
// A container and an svg with just the surface plotZoom touches. renderSvg
// records the spec it was handed, so the drawn domains are readable.
function harness() {
  const h = { drawn: [], handlers: {} };
  const svg = {
    style: {},
    getBoundingClientRect: function () { return { left: 0, top: 0, width: W, height: H }; },
    addEventListener: function (t, fn) { h.handlers[t] = fn; }
  };
  h.container = { innerHTML: '', querySelector: function () { return svg; } };
  h.renderSvg = function (s) { h.drawn.push(s.scales.x.domain.slice()); return '<svg/>'; };
  h.x = function () { return h.drawn[h.drawn.length - 1]; };
  return h;
}
function evt(extra) {
  return Object.assign({ clientX: W / 2, clientY: H / 2, deltaY: -120, deltaX: 0,
    preventDefault: function () {} }, extra || {});
}
// scroll up `times` at the plot's centre = zoom in on x
function zoomIn(h, times) {
  for (let i = 0; i < (times || 1); i++) h.handlers.wheel(evt());
}

// 1. no key: every attach opens at the full extent (the old behaviour, kept) ---
const plain = harness();
PlotZoom.attachDataZoom(plain.container, spec([1000, 2000]), plain.renderSvg);
zoomIn(plain, 4);
const plainZoomed = plain.x();
PlotZoom.attachDataZoom(plain.container, spec([1000, 2000]), plain.renderSvg);
ok('an unkeyed plot still opens at the full extent',
  plainZoomed[0] > 1000 && plain.x()[0] === 1000 && plain.x()[1] === 2000,
  'zoomed to ' + JSON.stringify(plainZoomed.map(Math.round)) + ', reopened at ' + JSON.stringify(plain.x()));

// 2. the lag changes: same plot, new extent, window held ----------------------
PlotZoom.resetViews();
const a = harness();
PlotZoom.attachDataZoom(a.container, spec([1000, 2000]), a.renderSvg, { viewKey: 'pair:A|B' });
zoomIn(a, 6);
const held = a.x();
ok('scrolling zooms the x window in', held[1] - held[0] < 400,
  JSON.stringify(held.map(Math.round)));
// a lag change rebuilds the spec — wider extent, because the lagged series moved
const b = harness();
PlotZoom.attachDataZoom(b.container, spec([900, 2100]), b.renderSvg, { viewKey: 'pair:A|B' });
ok('the same plot redrawn at a new lag keeps the zoomed window',
  Math.abs(b.x()[0] - held[0]) < 1e-9 && Math.abs(b.x()[1] - held[1]) < 1e-9,
  JSON.stringify(b.x().map(Math.round)) + ' vs the full extent [900,2100]');

// 3. a different plot is a different view -------------------------------------
const c = harness();
PlotZoom.attachDataZoom(c.container, spec([1000, 2000]), c.renderSvg, { viewKey: 'pair:A|C' });
ok('another pair opens at its own full extent',
  c.x()[0] === 1000 && c.x()[1] === 2000, JSON.stringify(c.x()));

// 4. double-click resets AND releases the plot back to its data ---------------
b.handlers.dblclick(evt());
ok('double-click returns to the full extent', b.x()[0] === 900 && b.x()[1] === 2100,
  JSON.stringify(b.x()));
const d = harness();
PlotZoom.attachDataZoom(d.container, spec([800, 2200]), d.renderSvg, { viewKey: 'pair:A|B' });
ok('...and a plot left at home follows the next extent rather than pinning the old one',
  d.x()[0] === 800 && d.x()[1] === 2200, JSON.stringify(d.x()));

// 5. panning is remembered too, and resetViews() forgets everything -----------
const e = harness();
PlotZoom.attachDataZoom(e.container, spec([1000, 2000]), e.renderSvg, { viewKey: 'pair:A|B' });
zoomIn(e, 6);
const beforeReset = e.x();
PlotZoom.resetViews();
const f = harness();
PlotZoom.attachDataZoom(f.container, spec([1000, 2000]), f.renderSvg, { viewKey: 'pair:A|B' });
ok('resetViews() drops every remembered window (new data loaded)',
  beforeReset[1] - beforeReset[0] < 400 && f.x()[0] === 1000 && f.x()[1] === 2000,
  'held ' + JSON.stringify(beforeReset.map(Math.round)) + ', reopened ' + JSON.stringify(f.x()));

// 6. the y window is held as well (Shift+scroll zooms width) ------------------
PlotZoom.resetViews();
const g = harness();
g.renderSvg = function (s) { g.drawn.push(s.scales.y.domain.slice()); return '<svg/>'; };
PlotZoom.attachDataZoom(g.container, spec([1000, 2000]), g.renderSvg, { viewKey: 'pair:Y' });
for (let i = 0; i < 4; i++) g.handlers.wheel(evt({ shiftKey: true }));
const yHeld = g.x();
const g2 = harness();
g2.renderSvg = function (s) { g2.drawn.push(s.scales.y.domain.slice()); return '<svg/>'; };
PlotZoom.attachDataZoom(g2.container, spec([1000, 2000]), g2.renderSvg, { viewKey: 'pair:Y' });
ok('a zoomed y (width) window is held across the re-render',
  yHeld[1] - yHeld[0] < 2 && Math.abs(g2.x()[0] - yHeld[0]) < 1e-9 &&
  Math.abs(g2.x()[1] - yHeld[1]) < 1e-9,
  JSON.stringify(yHeld.map(function (v) { return Math.round(v * 100) / 100; })));

console.log(fails ? '\nFAIL: ' + fails + ' check(s) failed.' : '\nPASS: remembered views hold across re-renders.');
process.exit(fails ? 1 : 0);
