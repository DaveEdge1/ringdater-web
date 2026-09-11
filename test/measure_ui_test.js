'use strict';
// ============================================================================
// measure_ui_test.js â€” port-lifecycle validation for the Measure view.
//
// The other suites are no-DOM by design (see frontend_test.js), but the serial
// PORT LIFECYCLE cannot be checked that way: it lives in stream locks, reader
// cancellation and close() ordering, and its failure mode is a port left open
// so the NEXT connect dies with "The port is already open". That bug is
// invisible to a logic-only test and strands the operator mid-core, so this
// suite drives the real web/measure.js in a real headless Chrome against a mock
// SerialPort, and asserts the port is genuinely closed on every teardown path.
//
// Chrome is optional: with no browser found (or no global WebSocket, i.e. node
// < 22) the suite SKIPS with exit 0 rather than failing the run. Point
// CHROME_PATH at a binary to override discovery.
// ============================================================================
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8097;
const CDP = 9224;

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const c of CANDIDATES) { try { if (fs.existsSync(c)) return c; } catch (e) { /* keep looking */ } }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = url => new Promise((res, rej) =>
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej));

// A SerialPort stand-in that counts open/close and lets the test error the read
// stream on demand â€” the simulated cable fault that used to leak the port.
const MOCK = `
window.__mock = { openCount: 0, closeCount: 0, written: [], ctrl: null };
window.__fakePort = {
  readable: null, writable: null,
  open: function () {
    window.__mock.openCount++;
    this.readable = new ReadableStream({ start: function (c) { window.__mock.ctrl = c; } });
    this.writable = new WritableStream({ write: function (chunk) {
      window.__mock.written.push(Array.from(chunk).map(function (b) {
        return String.fromCharCode(b); }).join(''));
    } });
    return Promise.resolve();
  },
  close: function () {
    window.__mock.closeCount++;
    this.readable = null; this.writable = null;
    return Promise.resolve();
  },
};
navigator.serial.requestPort = function () { return Promise.resolve(window.__fakePort); };
navigator.serial.getPorts = function () { return Promise.resolve([]); };
1;
`;

async function main() {
  const chromePath = findChrome();
  if (!chromePath || typeof WebSocket === 'undefined') {
    console.log('SKIP  measure_ui_test: ' +
      (chromePath ? 'no global WebSocket (needs node >= 22)' : 'no Chrome/Edge found') +
      ' â€” set CHROME_PATH to run it.');
    return 0;
  }

  const server = spawn(process.execPath, [path.join(ROOT, 'web/serve.js'), String(PORT)], { stdio: 'ignore' });
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'rdw-measure-ui-test'),
    '--remote-debugging-port=' + CDP, 'about:blank'], { stdio: 'ignore' });

  let failed = 0;
  const check = (name, cond, detail) => {
    if (!cond) failed++;
    console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : '  (' + (detail || '') + ')'));
  };

  try {
    let targets = null;
    for (let i = 0; i < 40 && !targets; i++) {
      await sleep(500);
      try { targets = JSON.parse(await get(`http://127.0.0.1:${CDP}/json`)); } catch (e) { /* booting */ }
    }
    if (!targets) throw new Error('Chrome DevTools endpoint never came up');

    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const send = (m, p) => new Promise(r => {
      const n = ++id; pending.set(n, r);
      ws.send(JSON.stringify({ id: n, method: m, params: p || {} }));
    });
    await new Promise(r => ws.addEventListener('open', r));
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    });
    const js = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description
          || r.exceptionDetails.text);
      }
      return r.result.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('DOM.enable');
    // A headless page is never the focused window, and an unfocused page fires
    // no focus/blur events at all — which would silently skip anything the view
    // does when a field is left. Emulating focus makes them fire as they do on
    // a bench machine.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await send('Page.navigate', { url: `http://localhost:${PORT}/index.html` });
    await sleep(3500);

    // The view now carries a sitting between visits (see the autosave section
    // below), so a run has to start from a known empty one rather than whatever
    // the last run left in this Chrome profile. Clearing the slot by hand is not
    // enough — the page would write its restored sitting straight back out — so
    // the session itself is emptied, which clears the slot with it.
    await js(`window.confirm = function () { return true; };
      window.MeasureUI.startFresh(); 1`);
    await sleep(300);

    await js(MOCK);
    await js(`document.querySelector('nav.tabs button[data-view="measure"]').click(); 1`);

    // connect
    await js(`document.getElementById('vroConnect').click(); 1`);
    await sleep(600);
    let st = JSON.parse(await js(`JSON.stringify({o: __mock.openCount, c: __mock.closeCount,
      open: !!__fakePort.readable, wrote: __mock.written.join('')})`));
    check('connect opens the port', st.o === 1 && st.open, JSON.stringify(st));
    check('auto-zero sends "C" + CR on connect', st.wrote === 'C\r', JSON.stringify(st.wrote));

    // one foot-switch press
    await js(`__mock.ctrl.enqueue(new TextEncoder().encode('1.234\\r')); 1`);
    await sleep(400);
    check('a press records one ring',
      (await js(`document.querySelectorAll('#vroTable tbody tr[data-i]').length`)) === 1);
    check('width taken verbatim under auto-zero',
      (await js(`document.querySelector('#vroTable tbody tr[data-i] td:nth-child(2)').textContent`)) === '1.234');
    check('VRO re-zeroed after the ring',
      (await js(`__mock.written.join('')`)) === 'C\rC\r');

    // a read error must still close the port (the regression)
    await js(`__mock.ctrl.error(new Error('simulated cable fault')); 1`);
    await sleep(700);
    st = JSON.parse(await js(`JSON.stringify({c: __mock.closeCount, open: !!__fakePort.readable})`));
    check('read error closes the port', st.c === 1 && !st.open, JSON.stringify(st));

    // ...and reconnecting afterwards must work
    await js(`document.getElementById('vroConnect').click(); 1`);
    await sleep(600);
    st = JSON.parse(await js(`JSON.stringify({o: __mock.openCount, open: !!__fakePort.readable,
      msg: document.getElementById('measureMsg').textContent})`));
    check('reconnect after a read error succeeds', st.o === 2 && st.open, JSON.stringify(st));
    check('no "already open" error surfaces', !/already open/i.test(st.msg), st.msg);

    // explicit disconnect
    await js(`document.getElementById('vroConnect').click(); 1`);
    await sleep(600);
    st = JSON.parse(await js(`JSON.stringify({c: __mock.closeCount, open: !!__fakePort.readable})`));
    check('explicit disconnect closes the port', st.c === 2 && !st.open, JSON.stringify(st));

    check('measured rings survive the disconnects',
      (await js(`document.querySelectorAll('#vroTable tbody tr[data-i]').length`)) === 1);

    // ---- audible ring feedback -------------------------------------------
    // The decade rule is asserted directly; the wiring is asserted by standing
    // in for MeasureAudio.ring and counting how it is called.
    check('markers follow the 1 / 10 / 50 / 100 / 1000 hierarchy',
      (await js(`JSON.stringify([1,9,10,11,49,50,51,100,150,999,1000,2000,1100].map(function (n) {
        return window.MeasureAudio.markerFor(n); }))`)) ===
      '["ring","ring","decade","ring","ring","fifty","ring","hundred","fifty",' +
      '"ring","thousand","thousand","hundred"]',
      await js(`JSON.stringify([1,9,10,11,49,50,51,100,150,999,1000,2000,1100].map(function (n) {
        return window.MeasureAudio.markerFor(n); }))`));
    // The decade marker used to be the woodblock hit twice, and that read at the
    // pedal as a slipped second press. No marker may share the ring's voice.
    check('no marker uses the ring voice of a press',
      (await js(`JSON.stringify(window.MeasureAudio.markers().map(function (k) {
        return window.MeasureAudio.voicesFor(k); }))`)) ===
      '[["hit"],["mallet"],["mallet","mallet"],["mallet","mallet","mallet"],' +
      '["mallet","mallet","mallet","mallet"]]',
      await js(`JSON.stringify(window.MeasureAudio.markers().map(function (k) {
        return window.MeasureAudio.voicesFor(k); }))`));
    // The pencil dots on a core: one at a decade, two at a fifty, three at a
    // century, four at a thousand. The marker is that count, sounded.
    check('each marker counts out its dots on the one marimba note',
      (await js(`JSON.stringify(window.MeasureAudio.markers().slice(1).map(function (k) {
        return window.MeasureAudio.voicesFor(k).length; }))`)) === '[1,2,3,4]',
      await js(`JSON.stringify(window.MeasureAudio.markers().slice(1).map(function (k) {
        return window.MeasureAudio.voicesFor(k).length; }))`));

    // A ring lands on several intervals at once; if the weaker won, the stronger
    // marker would never sound at all.
    check('the stronger marker wins where the intervals coincide',
      (await js(`window.MeasureAudio.isFifty(50) && !window.MeasureAudio.isDecade(50) &&
        window.MeasureAudio.isHundred(100) && !window.MeasureAudio.isFifty(100) &&
        window.MeasureAudio.isThousand(1000) && !window.MeasureAudio.isHundred(1000)`)) === true);
    // 150 is a fifty and not a century: only every SECOND fifty is a hundred.
    check('a fifty that is not a hundred stays a fifty',
      (await js(`window.MeasureAudio.markerFor(150)`)) === 'fifty');
    // Four notes at a 0.2 s spacing run to 0.8 s — long, but it is a thousandth
    // ring, and the audition has to leave room for it rather than talk over it.
    check('a marker knows how long it takes to sound',
      (await js(`(function () { var A = window.MeasureAudio;
        return A.lengthOf('thousand') > A.lengthOf('hundred') &&
          A.lengthOf('hundred') > A.lengthOf('fifty') &&
          A.lengthOf('fifty') > A.lengthOf('ring') &&
          A.lengthOf('thousand') < 1.2; })()`)) === true,
      await js(`JSON.stringify(window.MeasureAudio.markers().map(function (k) {
        return window.MeasureAudio.lengthOf(k); }))`));
    check('marker rule rejects zero and negatives',
      (await js(`window.MeasureAudio.markerFor(0) === 'ring' &&
        window.MeasureAudio.markerFor(-50) === 'ring'`)) === true);
    check('sound is on by default with an audible level',
      (await js(`window.MeasureAudio.enabled() && window.MeasureAudio.volume() > 0`)) === true);

    // Test tones is the only way to hear the far end of the hierarchy without
    // measuring a thousand rings, so it must audition ALL of it, in order and
    // without the markers running into one another.
    await js(`window.__auditioned = [];
      window.__realPreview = window.MeasureAudio.preview;
      window.MeasureAudio.preview = function (k) {
        window.__auditioned.push([k, Date.now()]); return true; };
      document.getElementById('vroTestTones').click(); 1`);
    await sleep(3400);
    check('Test tones auditions every marker, weakest first',
      (await js(`JSON.stringify(window.__auditioned.map(function (a) { return a[0]; }))`)) ===
      '["ring","decade","fifty","hundred","thousand"]',
      await js(`JSON.stringify(window.__auditioned.map(function (a) { return a[0]; }))`));
    check('...leaving each marker room to finish before the next starts',
      (await js(`(function () {
        var a = window.__auditioned, A = window.MeasureAudio;
        for (var i = 1; i < a.length; i++) {
          if ((a[i][1] - a[i - 1][1]) / 1000 < A.lengthOf(a[i - 1][0])) return false;
        }
        return a.length === 5;
      })()`)) === true,
      await js(`JSON.stringify(window.__auditioned)`));
    await js(`window.MeasureAudio.preview = window.__realPreview; 1`);

    // A fresh series, then twelve presses through the real frame handler.
    await js(`window.__rings = [];
      window.__realMarker = window.MeasureAudio.markerFor;
      window.MeasureAudio.ring = function (n) {
        window.__rings.push(n); return window.__realMarker(n); };
      window.confirm = function () { return true; };
      document.getElementById('vroNew').click(); 1`);
    await sleep(300);
    await js(`document.getElementById('vroConnect').click(); 1`);
    await sleep(600);
    for (let n = 0; n < 12; n++) {
      await js(`__mock.ctrl.enqueue(new TextEncoder().encode('0.9${n % 10}\\r')); 1`);
      await sleep(70);
    }
    await sleep(400);
    const rung = JSON.parse(await js(`JSON.stringify(window.__rings)`));
    check('every recorded ring sounds exactly once',
      rung.length === 12 && rung.join(',') === '1,2,3,4,5,6,7,8,9,10,11,12', rung.join(','));
    check('the tenth ring is the one that gets a marker',
      rung.filter(n => n % 10 === 0).join(',') === '10', rung.join(','));

    // ---- several series in one sitting ------------------------------------
    // A radius is routinely measured twice to check it, and a specimen's radii
    // belong in one .rwl, so "New series" must park the current series beside
    // the new one — never discard it. (The audio section above already clicked
    // it once, with one ring measured, then pressed twelve times into the new
    // series.)
    let sess = JSON.parse(await js(`JSON.stringify(window.MeasureUI.session())`));
    check('New series parks the previous one instead of discarding it',
      sess.length === 2 && sess[0].rings === 1 && sess[1].rings === 12,
      JSON.stringify(sess));
    check('the new series takes the next name, not a generic one',
      sess[0].id === 'NEW1' && sess[1].id === 'NEW2', JSON.stringify(sess.map(s => s.id)));
    check('the foot switch adds to the new series only', sess[1].active === true);
    check('the table carries one width column per series',
      (await js(`document.querySelectorAll('#vroTable thead th').length`)) === 3);
    check('the column being measured is marked',
      (await js(`document.querySelector('#vroTable thead th.col-active').textContent`)).indexOf('NEW2') === 0,
      await js(`document.querySelector('#vroTable thead th.col-active').textContent`));
    check('the parked series still has its ring in the table',
      (await js(`document.querySelector('#vroTable tbody tr[data-i="0"] td[data-s="0"]').textContent`)) === '1.234');
    check('both series are drawn on the trace',
      (await js(`document.querySelectorAll('#vroTrace polyline').length`)) === 2);

    // ---- aligning the series by hand --------------------------------------
    // A radius measured twice is read against the first, and the two only line
    // up ring for ring once a missed ring is allowed for. The lag is stepped by
    // hand on a number box; the table and the trace follow every step, and no
    // width is touched — an alignment set by eye is not a measurement.
    const rowVal = (r, sIdx) => `(function () {
      var td = document.querySelector('#vroTable tbody tr[data-i="${r}"] td[data-s="${sIdx}"]');
      return td ? td.textContent : 'no cell'; })()`;
    const rowsNow = `document.querySelectorAll('#vroTable tbody tr[data-i]').length`;
    const dotX = `(function () { var d = document.querySelector('#vroTrace circle.ring-dot');
      return d ? Math.round(d.getBoundingClientRect().left) : -1; })()`;
    const setLag = (v) => `(function () {
      var b = document.getElementById('vroLag');
      b.value = '${v}';
      b.dispatchEvent(new Event('input', { bubbles: true }));
      return b.value; })()`;
    const frame = `JSON.stringify(window.MeasureUI.sessionFrame().cols)`;

    const beforeRows = await js(rowsNow);
    const firstNew2 = await js(rowVal(0, 1));
    const firstNew1 = await js(rowVal(0, 0));
    const beforeDot = await js(dotX);
    const beforeFrame = await js(frame);
    check('the align box is offered once there is a second series to align to',
      (await js(`document.getElementById('vroLagRow').style.display`)) !== 'none' &&
      (await js(`document.getElementById('vroLag').getAttribute('step')`)) === '1' &&
      (await js(`document.getElementById('vroLag').type`)) === 'number',
      await js(`document.getElementById('vroLag').outerHTML`));
    check('a lag slides the series being measured down the table',
      (await js(`${setLag(2)}; ${rowVal(2, 1)}`)) === firstNew2 &&
      (await js(rowVal(0, 1))) === '' &&
      (await js(rowsNow)) === beforeRows + 2,
      await js(rowVal(2, 1)) + ' / ' + await js(rowVal(0, 1)) + ' / ' + await js(rowsNow));
    check('...leaving the series it is being aligned against where it was',
      (await js(rowVal(0, 0))) === firstNew1, await js(rowVal(0, 0)));
    check('...and the trace moves with it, on the same input event',
      (await js(dotX)) > beforeDot, await js(dotX) + ' was ' + beforeDot);
    check('...and the column heading says where its rings now start',
      (await js(`document.querySelector('#vroTable thead th.col-active .lagmark').textContent`)) === '+2',
      await js(`document.querySelector('#vroTable thead th.col-active').textContent`));
    check('...and the selected ring keeps its ring, moving to its new row',
      (await js(`document.querySelector('#vroTable tbody tr.sel').getAttribute('data-i')`)) === '13' &&
      (await js(`window.MeasureUI.session()[1].lag`)) === 2,
      await js(`document.querySelector('#vroTable tbody tr.sel').getAttribute('data-i')`));
    check('...and clicking a row still selects the ring that row holds',
      (await js(`document.querySelector('#vroTable tbody tr[data-i="5"] td[data-s="1"]').click();
        document.querySelector('#vroTable tbody tr.sel').getAttribute('data-i')`)) === '5' &&
      (await js(rowVal(5, 1))) !== '',
      await js(`document.querySelector('#vroTable tbody tr.sel').getAttribute('data-i')`));

    // The cursor names a ring of the series being MEASURED. Under a lag that is
    // no longer the row number — the row belongs to whichever series starts at
    // row 1 — so it reads out the active series' own count, and names the row
    // alongside it because the table beside the trace is numbered by row.
    check('the cursor names the ring of the series being measured, not the row',
      (await js(`document.querySelector('#vroTable tbody tr[data-i="5"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); document.querySelector('#vroCursor .cur-text').textContent`)).indexOf('ring 4 · row 6 · ') === 0 &&
      (await js(`document.querySelector('#vroCursor .cur-text').textContent`)).slice(-3) === ' mm',
      await js(`document.querySelector('#vroCursor .cur-text').textContent`));
    // Before its first ring the active series has no ring there at all; the
    // count runs on, bracketed and dimmed, as the crossdating cursor does
    // outside a series' span.
    check('...and a row before its first ring is bracketed rather than misnamed',
      (await js(`document.querySelector('#vroTable tbody tr[data-i="0"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); document.querySelector('#vroCursor .cur-text').textContent`)) === '(ring -1) · row 1' &&
      (await js(`document.querySelector('#vroCursor .cur-text').getAttribute('opacity')`)) === '0.65',
      await js(`document.querySelector('#vroCursor .cur-text').textContent`));
    check('...and the axis stops claiming the shared index is a ring numbering',
      (await js(`document.querySelector('#vroTrace svg text:nth-last-of-type(2)').textContent`)) === 'row 1',
      await js(`document.querySelector('#vroTrace svg text:nth-last-of-type(2)').textContent`));

    // A negative lag cannot push rings off the top of the table: the series it
    // is aligned against slides down instead, and the rows renumber.
    check('a negative lag moves the OTHER series down rather than losing rings',
      (await js(`${setLag(-1)}; ${rowVal(1, 0)}`)) === firstNew1 &&
      (await js(rowVal(0, 0))) === '' &&
      (await js(rowVal(0, 1))) === firstNew2,
      await js(rowVal(1, 0)) + ' / ' + await js(rowVal(0, 0)) + ' / ' + await js(rowVal(0, 1)));
    check('the widths themselves are untouched by any of it',
      (await js(frame)) === beforeFrame,
      'frame changed under a lag');
    // A lag typed with an extra digit would ask the table for tens of thousands
    // of empty rows; past the longest series it aligns nothing anyway.
    check('an absurd lag is clamped to where the series still overlap',
      (await js(`${setLag(9999)}; window.MeasureUI.session()[1].lag`)) === 12 &&
      (await js(rowsNow)) === 24,
      await js(`window.MeasureUI.session()[1].lag`) + ' / ' + await js(rowsNow));
    // A box mid-edit is left alone. A number input reports a half-typed "-" as
    // an empty value, and rewriting that to "0" would eat the minus sign before
    // the digit meant to follow it ever arrives.
    check('a box being typed into is not rewritten under the operator',
      (await js(`(function () {
        var b = document.getElementById('vroLag');
        b.focus(); b.value = '';
        b.dispatchEvent(new Event('input', { bubbles: true }));
        return b.value === '' && document.activeElement === b; })()`)) === true,
      await js(`document.getElementById('vroLag').value`));
    check('...and is squared up once it is left',
      (await js(`(function () { var b = document.getElementById('vroLag');
        b.blur(); return b.value; })()`)) === '0',
      await js(`document.getElementById('vroLag').value`));

    check('Reset puts every series back on ring 1',
      (await js(`document.getElementById('vroLagReset').click();
        ${rowVal(0, 1)}`)) === firstNew2 &&
      (await js(rowsNow)) === beforeRows &&
      (await js(`JSON.stringify(window.MeasureUI.session().map(function (e) { return e.lag; }))`)) ===
        '[0,0]',
      await js(`JSON.stringify(window.MeasureUI.session().map(function (e) { return e.lag; }))`));
    // Lined up ring for ring, row and ring are the same number again and the
    // cursor says so once, without a row to disambiguate.
    check('...so the cursor drops the row once nothing is lagged',
      (await js(`document.querySelector('#vroTable tbody tr[data-i="5"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); document.querySelector('#vroCursor .cur-text').textContent`)).indexOf('ring 6 · ') === 0 &&
      (await js(`document.querySelector('#vroCursor .cur-text').textContent`)).indexOf('row') < 0 &&
      (await js(`document.querySelector('#vroTrace svg text:nth-last-of-type(2)').textContent`)) === 'ring 1',
      await js(`document.querySelector('#vroCursor .cur-text').textContent`));
    await js(`document.getElementById('vroTableWrap')
      .dispatchEvent(new MouseEvent('mouseleave', { bubbles: false })); 1`);
    // Put the selection back where the rest of the suite expects to find it.
    await js(`document.querySelector('#vroTable tbody tr[data-i="11"] td[data-s="1"]').click(); 1`);
    await sleep(200);

    // Clicking inside another series' column moves the work there — that is how
    // a radius left half-done is picked up again.
    await js(`document.querySelector('#vroTable tbody tr[data-i="0"] td[data-s="0"]').click(); 1`);
    await sleep(300);
    check('clicking another column makes that series the one being measured',
      (await js(`window.MeasureUI.session()[0].active`)) === true &&
      (await js(`document.getElementById('vroId').value`)) === 'NEW1');
    await js(`__mock.ctrl.enqueue(new TextEncoder().encode('0.500\\r')); 1`);
    await sleep(400);
    sess = JSON.parse(await js(`JSON.stringify(window.MeasureUI.session())`));
    check('measuring resumes on the series that was picked up',
      sess[0].rings === 2 && sess[1].rings === 12, JSON.stringify(sess));

    // Discarding is its own deliberate act, and takes only the active series.
    await js(`document.getElementById('vroDiscard').click(); 1`);
    await sleep(300);
    sess = JSON.parse(await js(`JSON.stringify(window.MeasureUI.session())`));
    check('Discard removes only the series being measured',
      sess.length === 1 && sess[0].id === 'NEW2' && sess[0].rings === 12, JSON.stringify(sess));

    // ---- loading an existing series to amend ------------------------------
    // Half of measuring is finishing a core that was put down, or fixing a ring
    // that crossdating showed to be wrong. The path that matters is the one
    // that writes back: an amended series must REPLACE its pool column, not
    // land beside it as a near-identical duplicate.
    await js(`window.AppUI.loadExample();
      document.querySelector('nav.tabs button[data-view="measure"]').click();
      window.confirm = function () { return true; };
      document.getElementById('vroLoadOpen').click(); 1`);
    await sleep(400);
    const poolCount = await js(`window.AppUI.loadableSeries().length`);
    check('the load panel lists every loaded series',
      (await js(`document.querySelectorAll('#vroLoadSeries option').length`)) === poolCount,
      String(poolCount));

    const before = JSON.parse(await js(`JSON.stringify(window.AppUI.seriesWidths('sample_b', 'pool'))`));
    await js(`var sel = document.getElementById('vroLoadSeries');
      sel.value = String(window.AppUI.loadableSeries().findIndex(function (o) { return o.name === 'sample_b'; }));
      sel.dispatchEvent(new Event('change')); 1`);
    await sleep(200);
    // A set is what comes in by default; the second button is the way to take
    // one series out of it, and it must name the one the picker is on.
    check('the load button offers the whole set',
      (await js(`document.getElementById('vroLoadGo').textContent`)) ===
      'Load all ' + poolCount + ' series',
      await js(`document.getElementById('vroLoadGo').textContent`));
    check('...with one series still available on its own',
      (await js(`document.getElementById('vroLoadOne').textContent`)) === 'Only "sample_b"' &&
      (await js(`document.getElementById('vroLoadOne').style.display`)) !== 'none',
      await js(`document.getElementById('vroLoadOne').textContent`));

    await js(`document.getElementById('vroLoadOne').click(); 1`);
    await sleep(500);
    check('loading fills the ring table with the whole series',
      (await js(`document.querySelectorAll('#vroTable tbody tr[data-i]').length`)) === before.length,
      String(before.length));
    check('the loaded widths are the pool widths',
      (await js(`document.querySelector('#vroTable tbody tr[data-i] td[data-s="0"]').textContent`)) ===
      before[0].toFixed(3), String(before[0]));
    check('the load panel closes behind itself',
      (await js(`document.getElementById('vroLoadPanel').style.display`)) === 'none');
    check('the view says which pool series is being amended',
      /sample_b/.test(await js(`document.getElementById('vroOrigin').textContent`)),
      await js(`document.getElementById('vroOrigin').textContent`));

    // Selecting a ring in a long series must leave the table where it is. The
    // table follows the newest ring while measuring, and that must not turn
    // every repaint into a jump to the bottom — the row being worked on would
    // scroll out from under the operator on the click that selected it.
    check('clicking a ring leaves the table where it is',
      (await js(`(function () {
        var w = document.getElementById('vroTableWrap');
        w.scrollTop = 0;
        document.querySelector('#vroTable tbody tr[data-i="2"] td[data-s="0"]').click();
        return w.scrollTop;
      })()`)) === 0);
    check('...and still selects the ring that was clicked',
      (await js(`document.querySelector('#vroTable tbody tr.sel').getAttribute('data-i')`)) === '2');
    check('editing a ring does not jump the table either',
      (await js(`(function () {
        window.prompt = function () { return '1.111'; };
        var w = document.getElementById('vroTableWrap');
        w.scrollTop = 0;
        document.getElementById('vroEdit').click();
        return w.scrollTop;
      })()`)) === 0);

    // ---- the trace and the table are one view -----------------------------
    // A ring is a row in the table and a point on the trace above it. The cursor
    // is the one ring index both views show at once, so a row can be found on
    // the plot — and a bump in the plot found in the table — without counting
    // rings across the two. `cursorAt(i)` is true when the cursor line stands on
    // the i-th ring's dot; the dots are the active series' own widths.
    const cursorAt = (i) => `(function () {
      var g = document.getElementById('vroCursor');
      if (!g || g.getAttribute('display') === 'none') return 'hidden';
      var d = document.querySelectorAll('#vroTrace circle.ring-dot')[${i}];
      if (!d) return 'no dot ${i}';
      var l = g.querySelector('.cur-line').getBoundingClientRect(), r = d.getBoundingClientRect();
      return Math.abs((l.left + l.right) / 2 - (r.left + r.right) / 2) < 1.5;
    })()`;
    // Ring 3 (index 2) is the row the scroll checks above clicked and edited.
    check('the cursor marks the selected ring on the trace',
      (await js(cursorAt(2))) === true, String(await js(cursorAt(2))));
    check('hovering a row moves the cursor to that ring',
      (await js(`document.querySelector('#vroTable tbody tr[data-i="5"]')
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); ${cursorAt(5)}`)) === true,
      String(await js(cursorAt(5))));
    check('...and hovering alone does not change the selection',
      (await js(`document.querySelector('#vroTable tbody tr.sel').getAttribute('data-i')`)) === '2');
    check('...and the hovered ring is named on the trace',
      /^ring 6/.test(await js(`document.querySelector('#vroCursor .cur-text').textContent`)),
      await js(`document.querySelector('#vroCursor .cur-text').textContent`));
    check('leaving the table puts the cursor back on the selected ring',
      (await js(`document.getElementById('vroTableWrap')
        .dispatchEvent(new MouseEvent('mouseleave', { bubbles: false })); ${cursorAt(2)}`)) === true);

    // The same tie read the other way round.
    const atRing = (i) => `(function () {
      var d = document.querySelectorAll('#vroTrace circle.ring-dot')[${i}].getBoundingClientRect();
      return { x: (d.left + d.right) / 2, y: (d.top + d.bottom) / 2 };
    })()`;
    check('hovering the trace lights the row it belongs to',
      (await js(`(function () {
        var p = ${atRing(7)};
        document.querySelector('#vroTrace svg').dispatchEvent(new MouseEvent('mousemove',
          { bubbles: true, clientX: p.x, clientY: p.y }));
        var tr = document.querySelector('#vroTable tbody tr.hov');
        return tr ? tr.getAttribute('data-i') : 'none';
      })()`)) === '7',
      String(await js(`(function () { var tr = document.querySelector('#vroTable tbody tr.hov');
        return tr ? tr.getAttribute('data-i') : 'none'; })()`)));
    check('...without selecting it — hovering is not a click',
      (await js(`document.querySelector('#vroTable tbody tr.sel').getAttribute('data-i')`)) === '2');
    check('clicking the trace selects that ring in the table',
      (await js(`(function () {
        var p = ${atRing(7)};
        document.querySelector('#vroTrace svg').dispatchEvent(new MouseEvent('click',
          { bubbles: true, clientX: p.x, clientY: p.y }));
        return document.querySelector('#vroTable tbody tr.sel').getAttribute('data-i');
      })()`)) === '7');
    await js(`document.getElementById('vroTrace')
      .dispatchEvent(new MouseEvent('mouseleave', { bubbles: false })); 1`);
    check('a ring selected from the trace is the one the ring buttons act on',
      (await js(`document.getElementById('vroTable')
        .querySelector('tr.sel td[data-s="0"]').textContent`)) ===
      (await js(`(window.AppUI.seriesWidths('sample_b', 'pool')[7]).toFixed(3)`)),
      await js(`document.getElementById('vroTable').querySelector('tr.sel td[data-s="0"]').textContent`));

    // Amend ring 1, then write it back over the series it came from.
    await js(`window.prompt = function () { return '9.999'; };
      document.querySelector('#vroTable tbody tr[data-i="0"] td[data-s="0"]').click();
      document.getElementById('vroEdit').click(); 1`);
    await sleep(300);
    await js(`document.getElementById('vroUpdatePool').click(); 1`);
    await sleep(400);
    const after = JSON.parse(await js(`JSON.stringify(window.AppUI.seriesWidths('sample_b', 'pool'))`));
    check('updating writes the edit back into the pool', after[0] === 9.999, String(after[0]));
    // Ring 3 carries the edit made by the scroll check above; everything the
    // operator did not touch must come back byte for byte.
    check('the rest of the series is untouched',
      after.length === before.length && after[1] === before[1] && after[2] === 1.111 &&
      after.slice(3).join(',') === before.slice(3).join(','),
      after.length + ' vs ' + before.length + ', ring3=' + after[2]);
    check('updating does not duplicate the series',
      (await js(`window.AppUI.loadableSeries().length`)) === poolCount);
    check('the amended series keeps its place in the pool',
      (await js(`window.AppUI.loadableSeries()[
        window.AppUI.loadableSeries().findIndex(function (o) { return o.name === 'sample_b'; })].name`)) === 'sample_b');

    // Re-measure the same specimen alongside the amended series — the whole
    // point of a session — so the pool handoff has both a linked series and an
    // unlinked one to deal with.
    await js(`document.getElementById('vroNew').click(); 1`);
    await sleep(300);
    for (const w of ['0.410', '0.620']) {
      // Park the table at its foot before each press: the rings of the second
      // series land near the TOP of a table as long as the first series, so a
      // view sitting at the bottom is exactly the state the follow rule has to
      // recover from.
      await js(`var w = document.getElementById('vroTableWrap');
        w.scrollTop = w.scrollHeight; 1`);
      await js(`__mock.ctrl.enqueue(new TextEncoder().encode('${w}\\r')); 1`);
      await sleep(120);
    }
    await sleep(300);
    // The table follows the ring being ADDED, not the foot of the table. The
    // second series is two rings long beside a first that runs to hundreds, so
    // scrolling to the bottom would leave the operator watching empty cells
    // hundreds of rings below the ring they just measured.
    check('the ring table is long enough here to scroll at all',
      (await js(`(function () { var w = document.getElementById('vroTableWrap');
        return w.scrollHeight - w.clientHeight; })()`)) > 20,
      (await js(`document.querySelectorAll('#vroTable tbody tr[data-i]').length`)) + ' rows');
    check('a ring measured on a short series beside a long one stays in view',
      (await js(`(function () {
        var w = document.getElementById('vroTableWrap');
        var c = document.querySelector('#vroTable tbody tr[data-i="1"] td[data-s="1"]');
        if (!c) return 'no cell';
        var wr = w.getBoundingClientRect(), cr = c.getBoundingClientRect();
        var h = w.querySelector('thead').getBoundingClientRect().height;
        // Fully inside the box AND clear of the header sitting sticky over it.
        return cr.top >= wr.top + h - 1 && cr.bottom <= wr.bottom + 1;
      })()`)) === true,
      await js(`JSON.stringify({ top: document.getElementById('vroTableWrap').scrollTop,
        h: document.getElementById('vroTableWrap').scrollHeight })`));
    sess = JSON.parse(await js(`JSON.stringify(window.MeasureUI.session())`));
    check('a second measurement of the same series sits beside the first',
      sess.length === 2 && sess[0].id === 'sample_b' && sess[1].id === 'sample_b2' &&
      sess[0].rings === before.length && sess[1].rings === 2, JSON.stringify(sess));

    // With one column per series, a highlight that says only WHICH ROW is half
    // the answer. The table's hover and selection are tinted with the active
    // series' own trace colour — the colour of its line, its legend entry and
    // the cursor — so the table also says which series a click would edit.
    const lineVar = `getComputedStyle(document.getElementById('vroTable'))
      .getPropertyValue('--vro-line').trim()`;
    const hovVar = `getComputedStyle(document.getElementById('vroTable'))
      .getPropertyValue('--vro-hov').trim()`;
    // The tint is the series colour blended toward the row's white, which keeps
    // the ORDER of the three channels — a blue series stays bluest, an orange
    // one reddest. Comparing that order says the tint came from this series
    // without pinning the test to the blend fraction.
    const channelOrder = (v) => `(function () { var s = ${v};
      var m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
      var c = m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16),
                   parseInt(m[1].slice(4), 16)]
                : s.replace(/[^0-9,.]/g, '').split(',').slice(0, 3).map(Number);
      return c.map(function (_, i) { return i; })
        .sort(function (a, b) { return c[b] - c[a]; }).join(''); })()`;
    const legendColour = `document.querySelector('#vroTrace text[font-weight="bold"]')
      .getAttribute('fill')`;
    const second = await js(lineVar);
    check('the table takes the colour of the series being measured',
      second === (await js(legendColour)) && second.length > 0,
      second + ' vs legend ' + await js(legendColour));
    check('the row hover is a tint of that same colour, not a fixed one',
      (await js(channelOrder(hovVar))) === (await js(channelOrder(lineVar))) &&
      (await js(hovVar)) !== (await js(lineVar)),
      await js(hovVar) + ' vs ' + await js(lineVar));
    // A header the rows can be read through is worse than no tint: the ring
    // table's header is sticky, and the rows scroll underneath it.
    check('the tints are opaque, so the sticky header stays readable',
      (await js(`['--vro-hov','--vro-sel','--vro-sel-col','--vro-col','--vro-col-head']
        .every(function (k) {
          var v = getComputedStyle(document.getElementById('vroTable')).getPropertyValue(k);
          return v.indexOf('rgba') < 0 && v.trim().indexOf('rgb(') === 0;
        })`)) === true,
      await js(`['--vro-hov','--vro-sel','--vro-sel-col','--vro-col','--vro-col-head']
        .map(function (k) { return getComputedStyle(document.getElementById('vroTable'))
          .getPropertyValue(k); }).join(' ')`));
    check('picking up the other series re-tints the table',
      (await js(`document.querySelector('#vroTable tbody tr[data-i="0"] td[data-s="0"]').click();
        ${lineVar}`)) !== second,
      await js(lineVar) + ' was ' + second);
    check('...and it still matches the trace that series is drawn on',
      (await js(lineVar)) === (await js(legendColour)),
      await js(lineVar) + ' vs ' + await js(legendColour));
    // Back to the series being measured, which the pool handoff below reports on.
    await js(`document.querySelector('#vroTable tbody tr[data-i="0"] td[data-s="1"]').click(); 1`);
    await sleep(200);
    check('the table returns to the second series when it is picked up again',
      (await js(lineVar)) === second && (await js(`window.MeasureUI.session()[1].active`)) === true,
      await js(lineVar) + ' vs ' + second);

    // "Add to pool" takes the whole sitting: the series already linked to a pool
    // entry is written back over itself, the ones that are not are added. A
    // second click must therefore change nothing — measuring in progress cannot
    // be allowed to breed copies in the pool.
    //
    // It is "Add to pool AND CROSSDATE", so it also hands over to the Explore
    // tab and runs the analysis there: measuring and crossdating are one act,
    // and stopping at the pool leaves the operator on a settings page.
    await js(`document.getElementById('vroAddPool').click(); 1`);
    await sleep(500);
    const afterAdd = await js(`window.AppUI.loadableSeries().length`);
    check('adding puts the unlinked series in and updates the linked one',
      afterAdd === poolCount + 1, poolCount + ' -> ' + afterAdd);
    check('...and hands over to the Explore tab',
      (await js(`document.querySelector('nav.tabs button.active').getAttribute('data-view')`)) === 'explore',
      await js(`document.querySelector('nav.tabs button.active').getAttribute('data-view')`));
    // the run is chunked through setTimeout, so wait for it rather than guess
    let ran = false;
    for (let i = 0; i < 120 && !ran; i++) { await sleep(500); ran = await js(`window.AppUI.hasResult()`); }
    check('the crossdate runs itself, with no second click', ran, 'no result after 60s');
    check('...over the series that was just measured',
      (await js(`window.AppUI.result().undated.names.indexOf('sample_b2') > 0`)) === true,
      await js(`window.AppUI.result().undated.names.join(',')`));
    check('...and the plots open on it, not on whatever was first in the pool',
      (await js(`document.getElementById('p_series1').value + ' vs ' +
        document.getElementById('p_series2').value`)).indexOf('sample_b2') >= 0,
      await js(`document.getElementById('p_series1').value + ' vs ' +
        document.getElementById('p_series2').value`));
    // The hand-over prefers the pair's OWN row, so the table shows what the
    // plots show. A series this short correlates with nothing (every r is NA),
    // so it is filtered out of the results table and the plots are opened
    // directly instead — which is the point: the series you cannot score is the
    // one you most need to look at. Its row exists in the unfiltered table, and
    // that is the row the hand-over clicks when there is one.
    await js(`var f = document.getElementById('f_apply');
      f.checked = false; f.dispatchEvent(new Event('change')); 1`);
    await sleep(400);
    check('the pair the hand-over opens has a row of its own to select',
      (await js(`(function () {
        var s1 = document.getElementById('p_series1').value;
        var rows = document.querySelectorAll('#resTable tbody tr[data-s1]');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].getAttribute('data-s1') === s1 &&
              rows[i].getAttribute('data-s2') === 'sample_b2') { rows[i].click(); break; }
        }
        var sel = document.querySelector('#resTable tbody tr.sel');
        return (sel ? sel.getAttribute('data-s1') + ' vs ' + sel.getAttribute('data-s2') : 'none') +
          ' | plots ' + document.getElementById('p_series1').value + ' vs ' +
          document.getElementById('p_series2').value;
      })()`)).indexOf('sample_b2 | plots') > 0,
      await js(`(function () { var sel = document.querySelector('#resTable tbody tr.sel');
        return sel ? sel.getAttribute('data-s1') + ' vs ' + sel.getAttribute('data-s2') : 'none'; })()`));

    await js(`document.querySelector('nav.tabs button[data-view="measure"]').click(); 1`);
    await sleep(200);
    await js(`document.getElementById('vroAddPool').click(); 1`);
    await sleep(500);
    check('adding twice does not duplicate anything',
      (await js(`window.AppUI.loadableSeries().length`)) === afterAdd,
      String(await js(`window.AppUI.loadableSeries().length`)));
    await js(`document.querySelector('nav.tabs button[data-view="measure"]').click(); 1`);
    await sleep(200);
    check('the series just added is now linked to its pool entry',
      /linked to "sample_b2" in the pool/.test(
        await js(`document.getElementById('vroOrigin').textContent`)),
      await js(`document.getElementById('vroOrigin').textContent`));

    // A file opened here is NOT merged into the pool: editing one copy while the
    // stale one is analysed beside it is the failure this path exists to avoid.
    const poolBeforeFile = await js(`window.AppUI.loadableSeries().length`);
    await js(`document.getElementById('vroLoadOpen').click();
      var from = document.getElementById('vroLoadFrom');
      from.value = 'file'; from.dispatchEvent(new Event('change')); 1`);
    await sleep(200);
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#vroLoadFile' });
    await send('DOM.setFileInputFiles', {
      nodeId: input.nodeId,
      files: [path.join(ROOT, 'test/fixtures/extdata/undated_example.csv')],
    });
    // CDP populates .files but does not reliably fire the change event.
    await js(`document.getElementById('vroLoadFile').dispatchEvent(new Event('change')); 1`);
    await sleep(600);
    check('a file lists its series without touching the pool',
      (await js(`document.querySelectorAll('#vroLoadSeries option').length`)) === 13 &&
      (await js(`window.AppUI.loadableSeries().length`)) === poolBeforeFile,
      (await js(`document.querySelectorAll('#vroLoadSeries option').length`)) + ' / ' +
      (await js(`window.AppUI.loadableSeries().length`)));

    await js(`var sel = document.getElementById('vroLoadSeries');
      sel.value = 'sample_c'; sel.dispatchEvent(new Event('change'));
      document.getElementById('vroLoadOne').click(); 1`);
    await sleep(600);
    check('a series loaded from a file fills the table',
      (await js(`document.querySelectorAll('#vroTable tbody tr[data-i]').length`)) > 0,
      String(await js(`document.querySelectorAll('#vroTable tbody tr[data-i]').length`)));
    check('a file series offers no in-place update',
      (await js(`document.getElementById('vroUpdatePool').style.display`)) === 'none' &&
      /a file/.test(await js(`document.getElementById('vroOrigin').textContent`)),
      await js(`document.getElementById('vroOrigin').textContent`));
    check('opening a file still leaves the pool alone',
      (await js(`window.AppUI.loadableSeries().length`)) === poolBeforeFile);
    // The other half of the scroll rule: a ring arriving off the wire IS a
    // reason to move, or the operator loses sight of what they are measuring.
    await js(`document.getElementById('vroTableWrap').scrollTop = 0; 1`);
    await js(`__mock.ctrl.enqueue(new TextEncoder().encode('0.777\\r')); 1`);
    await sleep(400);
    check('a newly measured ring still pulls the table to the tail',
      (await js(`(function () { var w = document.getElementById('vroTableWrap');
        return w.scrollTop > 0 && w.scrollTop + w.clientHeight >= w.scrollHeight - 2; })()`)) === true,
      await js(`JSON.stringify({ top: document.getElementById('vroTableWrap').scrollTop,
        h: document.getElementById('vroTableWrap').scrollHeight })`));

    // ---- what the .rwl is called -------------------------------------------
    // Saving must not quietly rename a series. The download is intercepted so
    // the ids the file actually carries can be read back out of it — those ids
    // are the names the series come back under on the next load.
    await js(`window.__saved = [];
      window.AppUI.triggerDownload = function (d) { window.__saved.push(d); };
      var n = document.getElementById('vroId');
      n.value = 'CMP519B';
      n.dispatchEvent(new Event('input'));
      n.dispatchEvent(new Event('change')); 1`);
    await sleep(200);
    check('a name .rwl cannot carry is flagged before saving, not after',
      (await js(`document.getElementById('vroRwlIdWrap').style.display`)) !== 'none' &&
      /CMP519/.test(await js(`document.getElementById('vroRwlNote').textContent`)),
      await js(`document.getElementById('vroRwlNote').textContent`));

    await js(`document.getElementById('vroSaveRwl').click(); 1`);
    await sleep(300);
    let names = JSON.parse(await js(`JSON.stringify(
      window.RD.readRWL(window.__saved[0].content, { fileName: 'x.rwl' }).names)`));
    check('one .rwl holds every series of the sitting',
      names.length === 3, JSON.stringify(names));
    check('the standard layout still writes the safe 6-character id',
      names.indexOf('CMP519') >= 0, JSON.stringify(names));
    check('...and says so rather than letting it pass unnoticed',
      /CMP519B \\u2192 CMP519|CMP519B → CMP519/.test(
        await js(`document.getElementById('measureMsg').textContent`)),
      await js(`document.getElementById('measureMsg').textContent`));

    // Opting into the wider id keeps the name, and the preview agrees with the
    // file before a byte is written.
    await js(`var b = document.getElementById('vroLongId');
      b.checked = true; b.dispatchEvent(new Event('change'));
      document.getElementById('vroSaveRwl').click(); 1`);
    await sleep(300);
    names = JSON.parse(await js(`JSON.stringify(
      window.RD.readRWL(window.__saved[1].content, { fileName: 'x.rwl' }).names)`));
    check('the 8-character option keeps the full name',
      names.indexOf('CMP519B') >= 0, JSON.stringify(names));
    // The warning names every series the id field cannot carry, so a name that
    // now fits must drop out of it — the other series in the sitting keep theirs.
    check('a name that fits drops out of the warning',
      !/CMP519/.test(await js(`(function () { var n = document.getElementById('vroId');
        n.value = 'CMP519'; n.dispatchEvent(new Event('input'));
        return document.getElementById('vroRwlNote').textContent; })()`)),
      await js(`document.getElementById('vroRwlNote').textContent`));

    // Two series whose names collapse to the same Tucson id would silently
    // overwrite each other inside one file. That is a refusal, not a rename.
    await js(`window.MeasureUI.activate(0);
      var n = document.getElementById('vroId');
      n.value = 'CMP519X'; n.dispatchEvent(new Event('change'));
      window.MeasureUI.activate(1);
      n.value = 'CMP519Y'; n.dispatchEvent(new Event('change'));
      var b = document.getElementById('vroLongId');
      b.checked = false; b.dispatchEvent(new Event('change'));
      window.__saved = [];
      document.getElementById('vroSaveRwl').click(); 1`);
    await sleep(300);
    check('two series that would share one .rwl id are refused, not merged',
      (await js(`window.__saved.length`)) === 0 &&
      /cannot hold both/.test(await js(`document.getElementById('measureMsg').textContent`)),
      await js(`document.getElementById('measureMsg').textContent`));
    check('...and the 8-character id resolves it',
      (await js(`(function () {
        var b = document.getElementById('vroLongId');
        b.checked = true; b.dispatchEvent(new Event('change'));
        document.getElementById('vroSaveRwl').click();
        return window.__saved.length;
      })()`)) === 1);

    // ---- a file comes in whole --------------------------------------------
    // A file of one specimen's radii is a SET: they were measured together and
    // are only readable against each other, so opening one brings every series
    // in it onto the table side by side. The picker says which of them the foot
    // switch carries on with, not which one gets loaded. Left to last: it makes
    // the table wide, and every check above wants a sitting of a few series.
    const sessBefore = JSON.parse(await js(`JSON.stringify(window.MeasureUI.session())`));
    const keptIds = sessBefore.filter((e) => e.rings).map((e) => e.id);
    await js(`window.confirm = function () { return true; };
      document.getElementById('vroLoadOpen').click();
      var from = document.getElementById('vroLoadFrom');
      from.value = 'file'; from.dispatchEvent(new Event('change')); 1`);
    await sleep(200);
    const doc2 = await send('DOM.getDocument');
    const input2 = await send('DOM.querySelector', { nodeId: doc2.root.nodeId, selector: '#vroLoadFile' });
    await send('DOM.setFileInputFiles', {
      nodeId: input2.nodeId,
      files: [path.join(ROOT, 'test/fixtures/extdata/undated_example.csv')],
    });
    await js(`document.getElementById('vroLoadFile').dispatchEvent(new Event('change')); 1`);
    await sleep(700);
    check('the load button offers the whole file',
      (await js(`document.getElementById('vroLoadGo').textContent`)) === 'Load all 13 series',
      await js(`document.getElementById('vroLoadGo').textContent`));

    const poolBeforeAll = await js(`window.AppUI.loadableSeries().length`);
    await js(`var sel = document.getElementById('vroLoadSeries');
      sel.value = 'sample_c'; sel.dispatchEvent(new Event('change'));
      document.getElementById('vroLoadGo').click(); 1`);
    await sleep(1200);
    let fileSess = JSON.parse(await js(`JSON.stringify(window.MeasureUI.session())`));
    check('every series in the file comes onto the table',
      fileSess.length === keptIds.length + 13,
      JSON.stringify(fileSess.map((e) => e.id)));
    check('...under the names the file gave them',
      fileSess.slice(-13).map((e) => e.id).join(',') ===
      'sample_a,sample_b,sample_c,sample_d,sample_e,sample_f,sample_g,sample_h,sample_i,sample_j,sample_k,sample_l,sample_m',
      fileSess.slice(-13).map((e) => e.id).join(','));
    check('...and the picked one is the series being measured',
      (fileSess.filter((e) => e.active)[0] || {}).id === 'sample_c',
      JSON.stringify(fileSess.filter((e) => e.active)));
    check('the series measured in this sitting are kept beside them',
      fileSess.slice(0, keptIds.length).map((e) => e.id).join(',') === keptIds.join(','),
      fileSess.slice(0, keptIds.length).map((e) => e.id).join(','));
    check('no two series on the table share a name',
      fileSess.map((e) => e.id).length === new Set(fileSess.map((e) => e.id)).size,
      fileSess.map((e) => e.id).join(','));
    check('every loaded series gets a column of its own',
      (await js(`document.querySelectorAll('#vroTable thead th').length`)) === fileSess.length + 1,
      String(await js(`document.querySelectorAll('#vroTable thead th').length`)));
    check('...and a chip to switch back to',
      (await js(`document.querySelectorAll('#vroSeriesList .chip').length`)) === fileSess.length,
      String(await js(`document.querySelectorAll('#vroSeriesList .chip').length`)));
    check('the series being measured is the one whose widths are on screen',
      (await js(`(function () {
        var i = window.MeasureUI.session().findIndex(function (e) { return e.active; });
        var td = document.querySelector('#vroTable tbody tr[data-i="0"] td[data-s="' + i + '"]');
        return td ? td.textContent : 'none';
      })()`)) === (await js(`window.AppUI.seriesWidths('sample_c', 'pool')[0].toFixed(3)`)),
      await js(`(function () {
        var i = window.MeasureUI.session().findIndex(function (e) { return e.active; });
        var td = document.querySelector('#vroTable tbody tr[data-i="0"] td[data-s="' + i + '"]');
        return td ? td.textContent : 'none'; })()`));
    check('loading a whole file still leaves the pool alone',
      (await js(`window.AppUI.loadableSeries().length`)) === poolBeforeAll);
    check('the load panel closes behind a whole file too',
      (await js(`document.getElementById('vroLoadPanel').style.display`)) === 'none');
    check('the sitting says how many series arrived',
      /13 series/.test(await js(`document.getElementById('measureMsg').textContent`)),
      await js(`document.getElementById('measureMsg').textContent`));
    check('the whole file is saveable as one sitting',
      (await js(`window.MeasureUI.sessionFrame().names.length`)) === fileSess.length + 1,
      String(await js(`window.MeasureUI.sessionFrame().names.length`)));

    // A loaded set is a table like any other: one series of it can be put down
    // again without taking the rest with it.
    await js(`document.getElementById('vroDiscard').click(); 1`);
    await sleep(500);
    fileSess = JSON.parse(await js(`JSON.stringify(window.MeasureUI.session())`));
    check('discarding one of a loaded set keeps the others',
      fileSess.length === keptIds.length + 12 && fileSess.every((e) => e.id !== 'sample_c'),
      String(fileSess.length));

    // ---- autosave: the sitting outlives the tab --------------------------
    // The whole point of the view is that the rings exist nowhere else yet, so
    // this asserts the one thing that matters: close the page mid-core, come
    // back, and the sitting is still there.
    const saveBefore = JSON.parse(await js(`JSON.stringify(window.MeasureUI.session())`));
    const ringsSaveBefore = saveBefore.reduce((n, e) => n + e.rings, 0);
    await js(`window.MeasureUI.saveNow(); 1`);
    const snap = JSON.parse(await js(`JSON.stringify(window.MeasureUI.savedSnapshot())`));
    check('the sitting is mirrored into browser storage',
      !!snap && snap.entries.length === saveBefore.length &&
      snap.entries.reduce((n, e) => n + e.series.rings.length, 0) === ringsSaveBefore,
      snap ? snap.entries.length + ' series' : 'nothing stored');
    check('widths are stored as integer microns, not rounded mm',
      snap.entries.some(e => e.series.rings.some(r => Number.isInteger(r.width) && r.width > 100)),
      JSON.stringify((snap.entries[0].series.rings || []).slice(0, 2)));

    // the tab goes away mid-core
    await send('Page.navigate', { url: `http://localhost:${PORT}/index.html` });
    await sleep(3500);
    await js(`document.querySelector('nav.tabs button[data-view="measure"]').click(); 1`);
    await sleep(400);
    const saveAfter = JSON.parse(await js(`JSON.stringify(window.MeasureUI.session())`));
    check('every series comes back after the page is reloaded',
      saveAfter.length === saveBefore.length &&
      saveAfter.map(e => e.id).join(',') === saveBefore.map(e => e.id).join(',') &&
      saveAfter.reduce((n, e) => n + e.rings, 0) === ringsSaveBefore,
      saveAfter.length + ' series / ' + saveAfter.reduce((n, e) => n + e.rings, 0) + ' rings');
    check('...including which one the foot switch was feeding',
      saveAfter.findIndex(e => e.active) === saveBefore.findIndex(e => e.active),
      saveAfter.findIndex(e => e.active) + ' vs ' + saveBefore.findIndex(e => e.active));
    check('...and their alignment',
      saveAfter.map(e => e.lag).join(',') === saveBefore.map(e => e.lag).join(','),
      saveAfter.map(e => e.lag).join(','));
    check('the restored rings are painted, not just held',
      (await js(`document.querySelectorAll('#vroTable tbody tr[data-i]').length`)) > 0);
    check('the view says what it picked up',
      /Picked up where you left off/.test(await js(`document.getElementById('vroRestored').textContent`)),
      await js(`document.getElementById('vroRestored').textContent`));

    // and the way out of it clears the table AND the slot
    await js(`window.confirm = function () { return true; };
      document.getElementById('vroFresh').click(); 1`);
    await sleep(500);
    const fresh = JSON.parse(await js(`JSON.stringify(window.MeasureUI.session())`));
    check('start fresh empties the sitting',
      fresh.length === 1 && fresh[0].rings === 0, JSON.stringify(fresh));
    check('...and clears the saved slot, so the next visit starts clean',
      (await js(`window.MeasureUI.savedSnapshot()`)) == null,
      JSON.stringify(await js(`window.MeasureUI.savedSnapshot()`)));

    ws.close();
  } finally {
    try { chrome.kill(); } catch (e) { /* already gone */ }
    try { server.kill(); } catch (e) { /* already gone */ }
  }

  console.log(failed ? '\nFAILURES: ' + failed : '\nALL PASS');
  return failed ? 1 : 0;
}

main().then(code => { process.exitCode = code; })
  .catch(err => { console.log('HARNESS ERROR: ' + err.message); process.exitCode = 1; });
