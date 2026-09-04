'use strict';
// ============================================================================
// plot_hover_test.js — the linked year cursor on the crossdating plots.
//
// The line plot and the skeleton plot draw two series on ONE axis with the
// second shifted by the crossdate lag, so the cursor standing on year 1930 of
// the master is standing on year 1923 of the sample. Reading that pairing off
// the plot is the act crossdating consists of, and it is the one thing a
// no-DOM test cannot check: the labels are drawn by web/plotLink.js into a
// live SVG, from geometry that only exists once the page has laid it out.
//
// So this suite drives the real page in a real headless Chrome: it renders the
// two builders' own SVG, links them, dispatches a hover at a known year and
// reads the labels back — their text, their colours, and that they stay inside
// the panel.
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
const PORT = 8099;
const CDP = 9226;

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

// Two series with a real crossdate to find: the sample is the master's own
// growth, moved LAG years along. The values only have to be positive and
// varied — the skeleton plot marks narrow rings, and flat data has none.
const LAG = 7, Y0 = 1900, N = 90;
const SETUP = `
window.__panels = (function () {
  var years = [], master = [], sample = [];
  for (var i = 0; i < ${N}; i++) {
    years.push(${Y0} + i);
    master.push(1 + 0.45 * Math.sin(i / 3.1) + 0.25 * Math.sin(i / 7.7) + (i % 5) * 0.03);
    sample.push(1 + 0.45 * Math.sin((i - ${LAG}) / 3.1) + 0.25 * Math.sin((i - ${LAG}) / 7.7) + ((i + 2) % 5) * 0.03);
  }
  var frame = { names: ['year', 'MASTER', 'SAMPLE'], cols: [years, master, sample] };
  var line = RD.linePlot(frame, 'MASTER', 'SAMPLE', ${LAG});
  var skel = RD.skelPlot(frame, 'MASTER', 'SAMPLE', ${LAG}, {});
  var host = document.createElement('div');
  host.id = 'hoverHost';
  host.style.cssText = 'position:fixed;left:0;top:0;background:#fff;z-index:9999';
  var lineDiv = document.createElement('div'); lineDiv.id = 'hoverLine';
  var skelDiv = document.createElement('div'); skelDiv.id = 'hoverSkel';
  lineDiv.innerHTML = RD.renderSvg(line);
  skelDiv.innerHTML = RD.renderSvg(skel);
  host.appendChild(lineDiv); host.appendChild(skelDiv);
  document.body.appendChild(host);
  window.PlotLink.linkYearHover([lineDiv, skelDiv]);
  return { lag: ${LAG}, rows: skel.panels.length };
})();
1;`;

// Hover the line plot's hotzone at a given year of the SHARED (master) axis.
const hoverAt = year => `(function () {
  var hot = document.querySelector('#hoverLine rect.rd-hot');
  var r = hot.getBoundingClientRect();
  var xmin = +hot.getAttribute('data-xmin'), xmax = +hot.getAttribute('data-xmax');
  var cx = r.left + (${year} - xmin) / (xmax - xmin) * r.width;
  hot.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: r.top + r.height / 2 }));
  return 1;
})()`;

// Every cursor label in a container: its text, its colour, whether it is dimmed.
const labelsIn = sel => `JSON.stringify(Array.prototype.map.call(
  document.querySelectorAll('${sel} .rd-cursor text'), function (t) {
    return { text: t.textContent, fill: t.getAttribute('fill'), dim: t.getAttribute('opacity') };
  }))`;

async function main() {
  const chromePath = findChrome();
  if (!chromePath || typeof WebSocket === 'undefined') {
    console.log('SKIP  plot_hover_test: ' +
      (chromePath ? 'no global WebSocket (needs node >= 22)' : 'no Chrome/Edge found') +
      ' — set CHROME_PATH to run it.');
    return 0;
  }

  const server = spawn(process.execPath, [path.join(ROOT, 'web/serve.js'), String(PORT)], { stdio: 'ignore' });
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--window-size=1400,1200',
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'rdw-plot-hover-test'),
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
    await send('Page.navigate', { url: `http://localhost:${PORT}/index.html` });
    await sleep(3000);
    await js(SETUP);

    // The hotzone is what carries the mapping; without it nothing below works.
    check('the line plot declares both plotted series on its hotzone',
      (await js(`(function () {
        var s = JSON.parse(document.querySelector('#hoverLine rect.rd-hot').getAttribute('data-series'));
        return s.map(function (e) { return e.label + ':' + e.offset + ':' + e.color; }).join(' | ');
      })()`)) === `MASTER:0:black | SAMPLE:-${LAG}:red`,
      await js(`document.querySelector('#hoverLine rect.rd-hot').getAttribute('data-series')`));

    // ---- the pairing the plot exists to be read for ------------------------
    await js(hoverAt(1930));
    let labels = JSON.parse(await js(labelsIn('#hoverLine')));
    check('the cursor names a year for each series',
      labels.length === 2, JSON.stringify(labels));
    check('...the first being the master own year under the cursor',
      labels[0].text === 'MASTER 1930', JSON.stringify(labels[0]));
    check('...and the second the sample year, the lag earlier',
      labels[1].text === 'SAMPLE ' + (1930 - LAG), JSON.stringify(labels[1]));
    check('each year is in the colour its series is drawn in',
      labels[0].fill === 'black' && labels[1].fill === 'red', JSON.stringify(labels));
    check('neither is dimmed where both series have rings',
      !labels[0].dim && !labels[1].dim, JSON.stringify(labels));

    // ---- the same cursor, on the skeleton rows ----------------------------
    const rows = await js(`window.__panels.rows`);
    check('the skeleton plot is drawn in rows', rows >= 1, String(rows));
    const skelLabels = JSON.parse(await js(labelsIn('#hoverSkel')));
    check('hovering the line plot labels the skeleton row holding that year',
      skelLabels.length === 2 && skelLabels[0].text === 'MASTER 1930' &&
      skelLabels[1].text === 'SAMPLE ' + (1930 - LAG), JSON.stringify(skelLabels));
    check('...in the colours the skeleton marks carry, not the line plot ones',
      skelLabels[0].fill === '#2c7fb8' && skelLabels[1].fill === '#c0392b',
      JSON.stringify(skelLabels));
    check('only the row that contains the year is labelled',
      (await js(`document.querySelectorAll('#hoverSkel svg .rd-cursor').length`)) === 1,
      String(await js(`document.querySelectorAll('#hoverSkel svg .rd-cursor').length`)));

    // ---- a year one series does not reach ---------------------------------
    // Past the master's last ring the cursor is still somewhere on the sample,
    // and the master's number is an extrapolation of where its rings WOULD be.
    // Saying so is the difference between a reading and a guess.
    const last = Y0 + N - 1;
    await js(hoverAt(last + 4));
    labels = JSON.parse(await js(labelsIn('#hoverLine')));
    check('a year outside a series own rings is bracketed',
      labels.length === 2 && labels[0].text === 'MASTER (' + (last + 4) + ')' &&
      labels[1].text === 'SAMPLE ' + (last + 4 - LAG), JSON.stringify(labels));
    check('...and dimmed, so a reading is not confused with an extrapolation',
      !!labels[0].dim && !labels[1].dim, JSON.stringify(labels));

    // ---- the label stays on the plot --------------------------------------
    // At the right-hand end the plate would run off the panel, so it flips to
    // the other side of the line rather than being clipped away.
    const edges = [['at the left edge', Y0 + 1], ['at the right edge', last + LAG - 1]];
    for (const pair of edges) {
      await js(hoverAt(pair[1]));
      const box = JSON.parse(await js(`(function () {
        var hot = document.querySelector('#hoverLine rect.rd-hot');
        var p = document.querySelector('#hoverLine .rd-cursor rect');
        return JSON.stringify({ x: +hot.getAttribute('x'), w: +hot.getAttribute('width'),
          px: +p.getAttribute('x'), pw: +p.getAttribute('width') });
      })()`));
      check('the label stays inside the panel ' + pair[0],
        box.px >= box.x - 0.5 && box.px + box.pw <= box.x + box.w + 0.5, JSON.stringify(box));
    }

    // ---- leaving clears both panels ---------------------------------------
    await js(`document.getElementById('hoverLine')
      .dispatchEvent(new MouseEvent('mouseleave', { bubbles: false })); 1`);
    check('leaving the plot takes every cursor with it',
      (await js(`document.querySelectorAll('#hoverHost .rd-cursor').length`)) === 0,
      String(await js(`document.querySelectorAll('#hoverHost .rd-cursor').length`)));

    // ---- an UNDATED series is counted in rings, not named a year ----------
    // The Explore page's comparison frame sits on the CHRONOLOGY's calendar
    // years: comb.NA puts an undated series' ring 1 on the frame's first row,
    // so the axis value under it is a chronology year, not anything the series
    // knows. Its own numbering is ring counts from its first ring — which is
    // what the panel declares (ringSeries) and the cursor must show.
    const ring1 = Y0 + LAG;                       // where the sample's ring 1 is drawn
    await js(`(function () {
      var years = [], master = [], sample = [];
      for (var i = 0; i < ${N}; i++) {
        years.push(${Y0} + i);
        master.push(1 + 0.45 * Math.sin(i / 3.1) + 0.25 * Math.sin(i / 7.7) + (i % 5) * 0.03);
        sample.push(1 + 0.45 * Math.sin((i - ${LAG}) / 3.1) + 0.25 * Math.sin((i - ${LAG}) / 7.7) + ((i + 2) % 5) * 0.03);
      }
      var frame = { names: ['year', 'MASTER', 'SAMPLE'], cols: [years, master, sample] };
      var opt = { ringSeries: ['SAMPLE'] };
      var host = document.createElement('div');
      host.id = 'hoverRingHost';
      host.style.cssText = 'position:fixed;left:0;top:0;background:#fff;z-index:10000';
      var lineDiv = document.createElement('div'); lineDiv.id = 'hoverRingLine';
      var skelDiv = document.createElement('div'); skelDiv.id = 'hoverRingSkel';
      lineDiv.innerHTML = RD.renderSvg(RD.linePlot(frame, 'MASTER', 'SAMPLE', ${LAG}, opt));
      skelDiv.innerHTML = RD.renderSvg(RD.skelPlot(frame, 'MASTER', 'SAMPLE', ${LAG}, opt));
      host.appendChild(lineDiv); host.appendChild(skelDiv);
      document.body.appendChild(host);
      window.PlotLink.linkYearHover([lineDiv, skelDiv]);
      return 1;
    })()`);
    const hoverRing = year => `(function () {
      var hot = document.querySelector('#hoverRingLine rect.rd-hot');
      var r = hot.getBoundingClientRect();
      var xmin = +hot.getAttribute('data-xmin'), xmax = +hot.getAttribute('data-xmax');
      hot.dispatchEvent(new MouseEvent('mousemove', { bubbles: true,
        clientX: r.left + (${year} - xmin) / (xmax - xmin) * r.width, clientY: r.top + r.height / 2 }));
      return 1;
    })()`;

    await js(hoverRing(1930));
    labels = JSON.parse(await js(labelsIn('#hoverRingLine')));
    check('the dated series still reads as a year',
      labels.length === 2 && labels[0].text === 'MASTER 1930', JSON.stringify(labels));
    check('the undated series reads as a ring count from its first ring',
      labels[1].text === 'SAMPLE ring ' + (1930 - ring1 + 1), JSON.stringify(labels[1]));
    check('the ring count carries to the skeleton row',
      (JSON.parse(await js(labelsIn('#hoverRingSkel')))[1] || {}).text ===
        'SAMPLE ring ' + (1930 - ring1 + 1), await js(labelsIn('#hoverRingSkel')));
    check('the number alone is emboldened, not the word "ring"',
      (await js(`(function () {
        var t = document.querySelectorAll('#hoverRingLine .rd-cursor text')[1];
        return Array.prototype.map.call(t.querySelectorAll('tspan'), function (s) {
          return s.textContent + '/' + (s.getAttribute('font-weight') || 'normal');
        }).join(' | ');
      })()`)) === 'SAMPLE ring /normal | ' + (1930 - ring1 + 1) + '/bold',
      await js(`document.querySelectorAll('#hoverRingLine .rd-cursor text')[1].innerHTML`));

    // before the sample's first ring there is no ring to count: an
    // extrapolation, bracketed and dimmed like an out-of-range year
    await js(hoverRing(ring1 - 3));
    labels = JSON.parse(await js(labelsIn('#hoverRingLine')));
    check('before the first ring the count is bracketed and dimmed',
      labels[1].text === 'SAMPLE (ring -2)' && !!labels[1].dim && !labels[0].dim,
      JSON.stringify(labels));

    // ---- a panel that names no series still shows its own year ------------
    check('a panel with no series declared falls back to the plain year',
      (await js(`(function () {
        var d = document.createElement('div');
        d.id = 'hoverPlain';
        d.style.cssText = 'position:fixed;left:0;top:600px;background:#fff;z-index:9999';
        var yy = [], aa = [], bb = [];
        for (var i = 0; i < 41; i++) { yy.push(1900 + i); aa.push(i % 7); bb.push((i + 3) % 5); }
        var spec = RD.linePlot({ names: ['year', 'A', 'B'], cols: [yy, aa, bb] }, 'A', 'B', 0);
        delete spec.linkSeries;
        d.innerHTML = RD.renderSvg(spec);
        document.body.appendChild(d);
        window.PlotLink.linkYearHover([d]);
        var hot = d.querySelector('rect.rd-hot');
        var r = hot.getBoundingClientRect();
        hot.dispatchEvent(new MouseEvent('mousemove', { bubbles: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
        var t = d.querySelectorAll('.rd-cursor text');
        return t.length + ':' + (t[0] ? t[0].textContent : '');
      })()`)) === '1:1920',
      await js(`(function () { var t = document.querySelectorAll('#hoverPlain .rd-cursor text');
        return t.length + ':' + (t[0] ? t[0].textContent : ''); })()`));

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
