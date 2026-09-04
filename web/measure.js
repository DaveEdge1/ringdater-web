/* ============================================================================
 * measure.js — the Measure view: acquire ring widths from a Velmex VRO stage
 * over the Web Serial API, then hand the series straight to the crossdating
 * pool without a file ever touching disk.
 *
 * Division of labour, matching the rest of the frontend: everything that can be
 * tested under node lives in src/measure/ (vro.js = framing/parsing/mode
 * detection, series.js = the ring-width state machine, both reachable as
 * RD.vro / RD.createMeasureSeries). This file is the browser-only shell: port
 * permission, the read loop, DOM painting.
 *
 * Web Serial requires a SECURE CONTEXT — https:// or http://localhost. On
 * file:// `navigator.serial` is simply undefined, so the view degrades to an
 * explanatory notice rather than a dead Connect button. The GitHub Pages
 * deployment is https, so port permission persists per-origin and a return
 * visit reconnects without re-prompting.
 * ==========================================================================*/
(function () {
  'use strict';

  var RD = window.RD;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escA(s) { return esc(s).replace(/"/g, '&quot;'); }
  function setMsg(id, text, kind) {
    var el = $(id); if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  var V = RD.vro;
  var RAW_KEEP = 10;          // frames shown in the monitor
  var DETECT_TARGET = 4;      // presses before mode detection is confident

  // ---- state ---------------------------------------------------------------
  // A sitting at the stage is several series, not one: a radius is routinely
  // measured twice to check it, and a specimen's radii belong together in one
  // .rwl. So the view holds a SESSION — every series started here, in order —
  // and "New series" parks the current one beside the others rather than
  // throwing it away. `series` and `origin` always point at the active entry;
  // setSeries / setOrigin / activate keep them and the session in step.
  var session = [{ series: RD.createMeasureSeries({ id: 'NEW1' }), origin: null, lag: 0 }];
  var active = 0;
  var series = session[0].series;
  var port = null, reader = null, reading = false;
  var pendingWrite = Promise.resolve();   // in-flight command, awaited before close
  var framer = V.createFramer();
  var rawFrames = [];         // recent wire frames, newest last (the monitor)
  var rawMicrons = [];        // every VALUE frame, in arrival order
  var modeLocked = false;     // true once the operator confirms or overrides
  var selected = null;        // selected ring index in the table
  var shownCount = 0;         // rings the table last painted (see renderTable)
  // The trace and the ring table are two views of one thing, tied together by a
  // ring index: `hoverRing` is the ring the pointer is over in EITHER of them,
  // and `hoverFrom` is which one it came from, so neither clears the other's
  // hover on the way out. With nothing hovered the cursor falls back to the
  // selected ring — which, while the pedal is running, is the ring just measured.
  var hoverRing = null, hoverFrom = null;
  var traceGeom = null;       // the last trace's ring-index <-> pixel mapping
  var autoZero = true;        // clear the VRO after each ring, as Tellervo does
  // Where the ACTIVE series' rings came from, when they were not measured here:
  // { name, source: 'pool'|'chron'|'file' }. Only a pool series can be written
  // back in place; everything else can only be added or saved. Provenance is
  // per series, so it lives in the session entry and this is a pointer to the
  // active one.
  var origin = session[0].origin;
  var fileFrame = null;       // series read from a file for loading, not yet chosen
  var zeroSentAt = 0;         // timestamp of the last "C", for ack suppression

  // A frame arriving right after a zero command, reading essentially nothing, is
  // the readout acknowledging the clear rather than a ring — the stage cannot
  // physically have advanced a measurable distance in that time. Recording it
  // would interleave a spurious 0 mm ring between every real one.
  var ZERO_ACK_MS = 400;
  var ZERO_ACK_MICRONS = 5;

  function supported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }

  // ---- the session ---------------------------------------------------------
  function setSeries(s) { session[active].series = s; series = s; }
  function setOrigin(o) { session[active].origin = o; origin = o; }
  function measured() { return session.filter(function (e) { return e.series.length; }); }
  function ringTotal() {
    return session.reduce(function (n, e) { return n + e.series.length; }, 0);
  }

  // ---- alignment -----------------------------------------------------------
  // A lag slides one series against the others in the shared ring index, so a
  // radius measured twice can be read ring for ring against the first — the
  // ring the second measurement missed shows up as the row where the two
  // columns stop agreeing. It is an ALIGNMENT OF THE VIEW: no width changes,
  // and what a save or an add to the pool writes is untouched, since a lag the
  // operator set by eye is not a measurement.
  //
  // The stored lags are normalised for display, so whichever series starts
  // earliest starts at row 1 and no ring is ever pushed off the top.
  function offsets() {
    var lags = session.map(function (e) { return e.lag || 0; });
    var base = Math.min.apply(null, lags);
    return lags.map(function (l) { return l - base; });
  }
  function activeOffset() { return offsets()[active]; }
  function rowCount() {
    var off = offsets();
    return session.reduce(function (m, e, i) {
      return Math.max(m, e.series.length + off[i]);
    }, 0);
  }
  // The two directions between a table row and a ring of the ACTIVE series.
  // Everything the ring buttons act on is a ring index; everything drawn is a row.
  function rowOf(ring) { return ring == null ? null : ring + activeOffset(); }
  function ringOf(row) {
    if (!series.length) return null;
    return Math.max(0, Math.min(row - activeOffset(), series.length - 1));
  }

  // How far a series can usefully be slid: past the length of the longest one
  // it no longer overlaps anything, and a lag typed with an extra digit would
  // otherwise ask the table for tens of thousands of empty rows.
  function lagLimit() {
    return session.reduce(function (m, e) { return Math.max(m, e.series.length); }, 1);
  }
  function setLag(v) {
    var lim = lagLimit(), n = Math.round(Number(v));
    session[active].lag = isFinite(n) ? Math.max(-lim, Math.min(lim, n)) : 0;
    render();
  }

  // Make one series the one being measured and edited. The stage settings shown
  // belong to the series, not to the view — a specimen can hold a radius
  // measured pith-to-bark beside one measured the other way — so the controls
  // follow it. The raw log is dropped: it describes frames that produced the
  // series we are leaving, and replaying it into this one would invent rings.
  function activate(i) {
    if (i < 0 || i >= session.length) return;
    active = i;
    series = session[i].series;
    origin = session[i].origin;
    rawMicrons = [];
    selected = series.length ? series.length - 1 : null;
    $('vroId').value = series.id;
    $('vroMode').value = series.mode;
    $('vroDir').value = series.direction;
    render();
    // A series with no rings yet has no row to hold in view, and the table is
    // most likely parked at the foot of a longer series measured before it.
    // Ring 1 lands at the top, so start there.
    if (!series.length) $('vroTableWrap').scrollTop = 0;
  }

  // A re-measured radius is conventionally the first name with the next number
  // on it (CMP519B -> CMP519B2), so offer that rather than a generic NEW2.
  function nextSeriesName(base) {
    var m = /^(.*?)(\d+)$/.exec(base || '');
    var stem = m ? m[1] : (base || 'NEW');
    var n = m ? Number(m[2]) + 1 : 2;
    var taken = session.map(function (e) { return e.series.id; });
    var name = stem + n;
    while (taken.indexOf(name) >= 0) name = stem + (++n);
    return name;
  }

  // Audible ring feedback, resolved at call time so it degrades to silence if
  // measure-audio.js is absent — and so tests can stand in for it.
  function sound(n) {
    if (window.MeasureAudio) window.MeasureAudio.ring(n);
  }

  // ---- outbound commands ---------------------------------------------------
  // A writer locks port.writable, so one is taken and released per command
  // rather than held for the session; commands are rare and tiny.
  // Commands are QUEUED, never issued concurrently: a writer locks
  // port.writable, so a second getWriter() while the first is still in flight
  // throws — and that stray throw used to escape into connect()'s error path
  // and null out the port, leaving it open with nothing able to close it.
  function sendCommand(cmd) {
    var run = pendingWrite.catch(function () {}).then(function () {
      if (!port || !port.writable) return false;
      var writer;
      try {
        writer = port.writable.getWriter();
      } catch (err) {
        setMsg('measureMsg', 'Serial port busy, "' + cmd + '" not sent.', 'warn');
        return false;
      }
      return writer.write(V.commandBytes(cmd))
        .then(function () { pushRaw('> ' + cmd); return true; })
        .catch(function (err) {
          setMsg('measureMsg', 'Could not send "' + cmd + '" to the VRO: ' +
            ((err && err.message) || err), 'err');
          return false;
        })
        .finally(function () { try { writer.releaseLock(); } catch (e) { /* gone */ } });
    });
    pendingWrite = run.catch(function () {});
    return run;
  }

  function zeroTheVro() {
    zeroSentAt = Date.now();
    return sendCommand(V.ZERO);
  }

  // ---- connection ----------------------------------------------------------
  function setConnected(on, label) {
    $('vroStatus').textContent = label || (on ? 'connected' : 'not connected');
    $('vroStatus').className = 'pill ' + (on ? 'ok' : 'off');
    $('vroConnect').textContent = on ? 'Disconnect' : 'Connect to VRO';
    $('measureControls').style.display = on || ringTotal() ? '' : 'none';
  }

  // Reconnect silently to a port the operator has already granted, so a return
  // visit to the Pages origin is one click, not another permission dialog.
  function restorePort() {
    if (!supported() || !navigator.serial.getPorts) return;
    navigator.serial.getPorts().then(function (ports) {
      if (ports && ports.length) {
        port = ports[0];
        setConnected(false, 'port remembered — click to connect');
      }
    }).catch(function () { /* nothing remembered; ignore */ });
  }

  // A SerialPort exposes streams only while it is open, which is the only
  // reliable way to ask "does this page already hold the port?".
  function isOpen(p) { return !!(p && (p.readable || p.writable)); }

  function connect() {
    if (reading) { disconnect(); return; }
    if (!supported()) return;

    var pick = port ? Promise.resolve(port) : navigator.serial.requestPort();
    pick.then(function (p) {
      port = p;
      // Adopt a port this page already has open — after a read error or a
      // half-finished close, opening it again throws "already open" and the
      // operator is left unable to reconnect without restarting the browser.
      if (isOpen(port)) return null;
      return port.open(V.PORT_OPTIONS);
    }).then(function () {
      framer.reset();
      reading = true;
      setConnected(true, 'connected · 9600 8N1');
      readLoop();
      // Start from a known state: with auto-zero on, the readout may be sitting
      // at whatever position the last operator left it, and the first press
      // would otherwise report that instead of a ring width.
      if (autoZero) {
        applyAutoZero(true, true);   // quiet: this function issues the zero itself
        return zeroTheVro().then(function () {
          setMsg('measureMsg', 'Connected and zeroed. Press the foot switch to ' +
            'record a ring.', 'ok');
        });
      }
      setMsg('measureMsg', 'Connected. Press the foot switch to record a ring.', 'ok');
    }).catch(function (err) {
      // The operator dismissing the chooser is a normal outcome, not an error.
      if (err && err.name === 'NotFoundError') {
        setMsg('measureMsg', 'No port chosen.', '');
        return;
      }
      setMsg('measureMsg', portErrorHelp(err), 'err');
      // Only forget the port if it never opened. Nulling it while it IS open
      // strands it: releasePort() would find nothing to close.
      if (isOpen(port)) releasePort(); else port = null;
      setConnected(false);
    });
  }

  // "Already open" means THIS page still holds the port — a different problem
  // from another program owning it, and blaming Tellervo for it sends the
  // operator off closing software that was never the cause.
  function portErrorHelp(err) {
    var m = (err && err.message) || String(err);
    if (/already open/i.test(m)) {
      return 'This page still has the port open from an earlier session. Click ' +
             'Connect again — it will reuse it. (If that fails, reload the page.)';
    }
    if (/in use|access denied|failed to open/i.test(m)) {
      return 'Could not open the port: ' + m + ' — Tellervo (or another program) ' +
             'may still be holding it. Close it and try again.';
    }
    return 'Could not open the port: ' + m;
  }

  function readLoop() {
    if (!port || !port.readable) return;
    try {
      reader = port.readable.getReader();
    } catch (err) {
      // The stream is still locked by a reader from a previous session.
      setMsg('measureMsg', 'The port is held by a previous read session (' +
        ((err && err.message) || err) + '). Reload the page to clear it.', 'err');
      releasePort();
      return;
    }
    (function pump() {
      reader.read().then(function (res) {
        if (res.done) { safeRelease(); return; }
        framer.push(res.value).forEach(handleFrame);
        if (reading) pump(); else safeRelease();
      }).catch(function (err) {
        // Do NOT just stop reading: leaving the port open here is what makes a
        // later Connect fail with "already open".
        setMsg('measureMsg', 'Serial read stopped: ' + ((err && err.message) || err), 'err');
        releasePort();
      });
    })();
  }

  function safeRelease() {
    try { if (reader) reader.releaseLock(); } catch (e) { /* already released */ }
  }

  // The one place the port is torn down. Every step is attempted even if an
  // earlier one fails, because a half-released port is exactly the state that
  // strands the operator: cancel the reader, drop its lock, then close.
  function releasePort() {
    reading = false;
    var step = Promise.resolve();

    if (reader) {
      var r = reader;
      step = step
        .then(function () { return r.cancel(); })
        .catch(function () { /* already cancelled or errored */ })
        .then(function () { try { r.releaseLock(); } catch (e) { /* fine */ } });
    }

    return step
      .then(function () {
        // Any command still in flight holds the writable stream; wait it out.
        return pendingWrite;
      })
      .catch(function () {})
      .then(function () {
        try { framer.flush().forEach(handleFrame); } catch (e) { /* fine */ }
        if (port && isOpen(port)) return port.close();
      })
      .catch(function (err) {
        // Surfaced rather than swallowed — a close that fails silently leaves
        // the UI claiming "disconnected" while the port is still held.
        setMsg('measureMsg', 'The port did not close cleanly (' +
          ((err && err.message) || err) + '). Reload the page if Connect keeps failing.', 'warn');
      })
      .then(function () {
        reader = null;
        setConnected(false, 'disconnected');
      });
  }

  function disconnect() {
    return releasePort().then(function () {
      if (!/did not close/.test($('measureMsg').textContent || '')) {
        setMsg('measureMsg', 'Disconnected. The measured series is still here.', '');
      }
    });
  }

  // ---- incoming frames -----------------------------------------------------
  function handleFrame(line) {
    var r = V.parseLine(line);
    pushRaw(r.status === V.VALUE ? line : line + '   (' + r.status + ')');

    if (r.status === V.UNITS) {
      // Wrong unit mode is not recoverable by us and every further frame would
      // be mis-scaled, so stop rather than record bad millimetres.
      setMsg('measureMsg', r.message, 'err');
      disconnect();
      return;
    }
    if (r.status !== V.VALUE) return;

    // Swallow the readout's acknowledgement of a zero command (see ZERO_ACK_MS).
    if (autoZero && Math.abs(r.microns) <= ZERO_ACK_MICRONS &&
        (Date.now() - zeroSentAt) < ZERO_ACK_MS) {
      rawFrames[rawFrames.length - 1] += '   (zero ack — ignored)';
      $('vroRaw').textContent = rawFrames.join('\n');
      return;
    }

    // Order matters: record the frame and the ring FIRST, then run detection.
    // Detection can re-derive the whole series from rawMicrons, so the current
    // reading has to be in that log exactly once and already applied — running
    // detection first would replay it and then add it again.
    rawMicrons.push(r.microns);
    series.addReading(r.microns);
    sound(series.length);

    // Clear the readout so the next press reports the next ring directly. This
    // is Tellervo's behaviour and the reason the mode is pinned to incremental
    // while auto-zero is on — there is no accumulating position to difference.
    if (autoZero) zeroTheVro();
    else if (!modeLocked) runDetection();

    var rings = series.state().rings;
    var last = rings[rings.length - 1];
    if (last && last.width < 0) {
      setMsg('measureMsg', 'Negative width (' + (last.width / 1000).toFixed(3) +
        ' mm) — the stage moved backwards. Press Undo.', 'err');
    } else if (modeLocked) {
      setMsg('measureMsg', '', '');
    }
    selected = series.length - 1;
    render();
  }

  function pushRaw(text) {
    rawFrames.push(text);
    if (rawFrames.length > RAW_KEEP) rawFrames.shift();
    $('vroRaw').textContent = rawFrames.join('\n');
  }

  // ---- readout-mode detection ---------------------------------------------
  // The VRO does not announce whether it reports absolute position or
  // self-zeroed increments, so infer it from the first few presses and show the
  // operator the evidence rather than a silent assumption.
  function runDetection() {
    var d = V.detectMode(rawMicrons);
    var box = $('vroDetect');
    if (!d.mode) {
      box.innerHTML = '<span class="hint">' + esc(d.reason) + '</span>';
      return;
    }
    var enough = d.samples >= DETECT_TARGET;
    box.innerHTML =
      '<strong>Readout looks ' + esc(d.mode) + '</strong> ' +
      '<span class="hint">' + esc(d.reason) + '</span>' +
      (enough ? ' <button class="btn secondary" id="vroAcceptMode">Use ' + esc(d.mode) + '</button>' : '');

    if (d.mode !== series.mode) applyMode(d.mode, true);
    if (enough) {
      $('vroAcceptMode').addEventListener('click', function () {
        modeLocked = true;
        box.innerHTML = '<span class="hint">Mode fixed: ' + esc(series.mode) + '.</span>';
        setMsg('measureMsg', 'Readout mode set to ' + series.mode + '.', 'ok');
      });
    }
  }

  // Re-deriving past rings is only valid while every ring came from one raw
  // frame under one unchanged regime. Absent rings, inserts, deletes and a
  // mid-core auto-zero toggle all break that correspondence.
  function canReplay() {
    if (rawMicrons.length !== series.length) return false;
    return series.state().rings.every(function (r) { return !r.note || /^negative/.test(r.note); });
  }

  // Switching mode changes how every frame becomes a width. When the raw log
  // still matches the rings, replay it so earlier rings are not left computed
  // the old way; otherwise change the regime going forward only, and say so.
  function applyMode(mode, quiet) {
    if (mode === series.mode) return;
    if (series.length && !canReplay()) {
      series.mode = mode;
      // Coming back to cumulative, the readout is at zero (or about to be), so
      // the next frame measures from there.
      if (mode === V.CUMULATIVE) series.zeroAt(0);
      $('vroMode').value = mode;
      if (!quiet) setMsg('measureMsg', 'Now recording as ' + mode +
        '. Rings already measured were left as they were.', 'warn');
      render();
      return;
    }
    var next = RD.createMeasureSeries({ id: series.id, mode: mode, direction: series.direction });
    rawMicrons.forEach(function (m) { next.addReading(m); });
    setSeries(next);
    $('vroMode').value = mode;
    if (!quiet) setMsg('measureMsg', 'Re-derived ' + series.length + ' rings as ' + mode + '.', 'ok');
    render();
  }

  // Auto-zero and the readout mode are two views of one decision: if the VRO is
  // cleared after every ring there is no running position to difference, so the
  // frames ARE widths. Keep them in lockstep rather than letting the operator
  // set a contradictory pair.
  function applyAutoZero(on, quiet) {
    autoZero = !!on;
    $('vroAutoZero').checked = autoZero;
    $('vroMode').disabled = autoZero;
    if (series.length) rawMicrons = [];   // regime changed mid-core; no replay
    if (autoZero) {
      modeLocked = true;
      // Nothing to report: the disabled mode control already reads "incremental",
      // and the reason lives in the checkbox tooltip.
      $('vroDetect').innerHTML = '';
      applyMode(V.INCREMENTAL, true);
      if (!quiet && reading) zeroTheVro();
    } else {
      modeLocked = false;
      applyMode(V.CUMULATIVE, true);
      $('vroDetect').innerHTML = '<span class="hint">Press the foot switch a few ' +
        'times to identify the readout mode.</span>';
    }
    $('vroMode').value = series.mode;
    render();
  }

  // ---- editing actions -----------------------------------------------------
  function needSelection() {
    if (selected == null || !series.state().rings[selected]) {
      setMsg('measureMsg', 'Select a ring in the table first.', 'err');
      return false;
    }
    return true;
  }

  var Actions = {
    // Clear the readout and the running reference together, so hardware and
    // software agree that the stage is now at zero.
    zero: function () {
      series.zeroAt(0);
      if (reading) {
        zeroTheVro().then(function (ok) {
          setMsg('measureMsg', ok ? 'VRO zeroed. The next press measures from here.'
                                  : 'Reference reset, but the VRO did not accept the command.',
            ok ? 'ok' : 'err');
        });
      } else {
        setMsg('measureMsg', 'Reference reset to zero (not connected).', '');
      }
      render();
    },
    // Diagnostic: ask the VRO for its current position without the foot switch.
    // Also the only way to prove the outbound path works before a real core.
    request: function () {
      if (!reading) { setMsg('measureMsg', 'Connect first.', 'err'); return; }
      sendCommand(V.REQUEST).then(function (ok) {
        if (ok) setMsg('measureMsg', 'Sent "S" — the reply appears in the raw frames.', 'ok');
      });
    },
    absent: function () {
      series.addAbsent();
      // An absent ring is still a ring: it sounds, and it counts toward the
      // decade, so the audible count stays in step with the ring numbers.
      sound(series.length);
      selected = series.length - 1;
      setMsg('measureMsg', 'Locally absent ring recorded (0 mm).', 'ok');
      render();
    },
    undo: function () {
      if (!series.undo()) { setMsg('measureMsg', 'Nothing to undo.', ''); return; }
      // Keep the raw log in step so a later mode change replays the same rings.
      if (rawMicrons.length > series.length) rawMicrons.length = series.length;
      selected = series.length ? Math.min(selected, series.length - 1) : null;
      setMsg('measureMsg', 'Undone.', '');
      render();
    },
    edit: function () {
      if (!needSelection()) return;
      var cur = series.state().rings[selected].width / 1000;
      var ans = window.prompt('Width in mm for ring ' + (selected + 1) + ':', cur.toFixed(3));
      if (ans == null) return;
      var mm = Number(ans);
      if (!isFinite(mm) || mm < 0) { setMsg('measureMsg', 'Enter a width in mm, 0 or more.', 'err'); return; }
      series.setWidth(selected, Math.round(mm * 1000));
      render();
    },
    insert: function () {
      if (!needSelection()) return;
      var ans = window.prompt('Width in mm of the ring to insert before ring ' +
        (selected + 1) + ' (0 = locally absent):', '0');
      if (ans == null) return;
      var mm = Number(ans);
      if (!isFinite(mm) || mm < 0) { setMsg('measureMsg', 'Enter a width in mm, 0 or more.', 'err'); return; }
      series.insert(selected, Math.round(mm * 1000));
      render();
    },
    remove: function () {
      if (!needSelection()) return;
      series.remove(selected);
      if (selected >= series.length) selected = series.length ? series.length - 1 : null;
      render();
    },
    // Start another series BESIDE the ones already measured. Re-measuring a
    // radius to check it, and measuring the several radii of one specimen, are
    // the same act as far as this view is concerned: both end as columns of one
    // .rwl, so neither may cost the operator what is already on the table.
    newSeries: function () {
      series.id = $('vroId').value.trim() || series.id;
      if (!series.length) {
        setMsg('measureMsg', '"' + series.id + '" has no rings yet — it is already the ' +
          'series you are measuring.', '');
        return;
      }
      var from = series;
      session.push({
        series: RD.createMeasureSeries({
          id: nextSeriesName(from.id), mode: from.mode, direction: from.direction,
        }),
        origin: null,
        lag: 0,
      });
      modeLocked = autoZero;          // with auto-zero on the mode is not in doubt
      activate(session.length - 1);
      if (autoZero && reading) zeroTheVro();
      setMsg('measureMsg', 'Started "' + series.id + '" beside "' + from.id +
        '". Both are saved together; click a name above to go back to one.', 'ok');
    },
    // The way OUT of the session, kept separate from starting a new series so
    // that losing work always takes a deliberate click of its own.
    discard: function () {
      if (series.length && !window.confirm('Discard "' + series.id + '" (' +
        series.length + ' rings)? The other series are kept.')) return;
      var gone = series.id;
      session.splice(active, 1);
      if (!session.length) {
        session.push({ series: RD.createMeasureSeries({ id: 'NEW1', mode: $('vroMode').value, direction: $('vroDir').value }), origin: null, lag: 0 });
      }
      modeLocked = autoZero;
      activate(Math.min(active, session.length - 1));
      if (autoZero && reading) zeroTheVro();
      setMsg('measureMsg', 'Discarded "' + gone + '".', '');
    },
  };

  // ---- loading an existing series -----------------------------------------
  // Measuring a core is rarely one sitting: a slide gets put down half-done, a
  // ring turns out to be false, a series comes back from crossdating with a
  // missing ring to insert. All of that is the same act — put an existing series
  // back on the table, then edit it or carry on from its last ring.

  function loadPanelOpen() { return $('vroLoadPanel').style.display !== 'none'; }

  function showLoadPanel(on) {
    $('vroLoadPanel').style.display = on ? '' : 'none';
    $('vroLoadOpen').textContent = on ? 'Close' : 'Load an existing series…';
    if (on) { fileFrame = null; $('vroLoadFile').value = ''; setMsg('vroLoadMsg', '', ''); fillLoadSeries(); }
  }

  // Options for the "Series" picker: either what the app already holds, or what
  // the chosen file turned out to contain.
  function fillLoadSeries() {
    var sel = $('vroLoadSeries');
    var fromFile = $('vroLoadFrom').value === 'file';
    var opts;
    if (fromFile) {
      opts = fileFrame
        ? fileFrame.names.slice(1).map(function (n) { return { value: n, label: n }; })
        : [];
    } else {
      opts = (window.AppUI.loadableSeries() || []).map(function (o, i) {
        return { value: String(i), label: o.label };
      });
    }
    sel.innerHTML = opts.length
      ? opts.map(function (o) { return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>'; }).join('')
      : '<option value="">' + (fromFile ? 'choose a file first' : 'nothing loaded yet') + '</option>';
    sel.disabled = !opts.length;
    $('vroLoadGo').disabled = !opts.length;
    syncLoadButtons();
  }

  // What the two buttons offer depends on how much there is to bring in. With
  // one series they are one act, so the second button is hidden; with a set,
  // the whole set is the default and the picker says which of them the foot
  // switch carries on with.
  function syncLoadButtons() {
    var all = loadGroup(), one = $('vroLoadOne'), go = $('vroLoadGo');
    if (!one || !go) return;
    var pick = chosenSeries();
    go.textContent = all.length > 1
      ? 'Load all ' + all.length + ' series'
      : 'Load into the table';
    one.style.display = all.length > 1 ? '' : 'none';
    one.textContent = 'Only "' + (pick ? pick.name : '') + '"';
    one.disabled = !pick;
  }

  function onLoadFile(ev) {
    var f = ev.target.files && ev.target.files[0];
    fileFrame = null;
    fillLoadSeries();
    if (!f) return;
    setMsg('vroLoadMsg', 'Reading ' + f.name + '…', '');
    window.AppUI.readSeriesFile(f, function (err, frame) {
      if (err) { setMsg('vroLoadMsg', err.message, 'err'); fillLoadSeries(); return; }
      fileFrame = frame;
      fillLoadSeries();
      var n = frame.names.length - 1;
      setMsg('vroLoadMsg', f.name + ': ' + n + ' series' + (n > 1 ? ' — pick one.' : '.'), 'ok');
    });
  }

  // Every series the picker is pointing INTO — a file's whole contents, the
  // whole pool, or the members of one chronology. A specimen's radii were
  // measured in one sitting and are read against each other, so the set is the
  // unit that comes onto the table; the picker then says which of them the foot
  // switch carries on with.
  //
  // Both frame kinds bottom-pad short series with null (a dated one also pads
  // the head), so the pad is trimmed from each end before the widths are taken.
  // What was trimmed off the HEAD is kept as `lead`: it is where the series sat
  // on the shared axis, and it becomes its alignment lag on the table.
  function loadGroup() {
    if ($('vroLoadFrom').value === 'file') {
      if (!fileFrame) return [];
      var bad = function (v) { return v == null || (typeof v === 'number' && isNaN(v)); };
      return fileFrame.names.slice(1).map(function (n, i) {
        var col = fileFrame.cols[i + 1].slice();
        while (col.length && bad(col[col.length - 1])) col.pop();
        var lead = 0; while (lead < col.length && bad(col[lead])) lead++;
        return {
          name: n, widths: col.slice(lead), lead: lead,
          origin: { name: n, source: 'file' },
        };
      }).filter(function (o) { return o.widths.length; });
    }
    var sel = $('vroLoadSeries');
    var o = (window.AppUI.loadableSeries() || [])[Number(sel.value)];
    if (!o) return [];
    return (window.AppUI.seriesGroup(o.source, o.chron) || []).map(function (g) {
      return {
        name: g.name, widths: g.widths, lead: g.lead,
        origin: { name: g.name, source: g.source, chron: g.chron },
      };
    }).filter(function (g) { return g.widths.length; });
  }

  // The one series the picker points at, out of that group.
  function chosenSeries() {
    var sel = $('vroLoadSeries');
    if (!sel.value && sel.value !== '0') return null;
    var group = loadGroup();
    if ($('vroLoadFrom').value === 'file') {
      return group.filter(function (g) { return g.name === sel.value; })[0] || null;
    }
    var o = (window.AppUI.loadableSeries() || [])[Number(sel.value)];
    if (!o) return null;
    return group.filter(function (g) { return g.name === o.name; })[0] || null;
  }

  // A name already on the table is not free to reuse: two columns with one name
  // break every by-name lookup downstream, and the operator cannot tell the
  // chips apart either.
  function freeName(name, taken) {
    var id = name || 'NEW1', base = id, n = 1;
    while (taken.indexOf(id) >= 0) id = base + '_' + (++n);
    return id;
  }

  function doLoad() {
    var pick = chosenSeries();
    if (!pick) { setMsg('vroLoadMsg', 'Choose a series to load.', 'err'); return; }
    if (!pick.widths.length) { setMsg('vroLoadMsg', '"' + pick.name + '" has no ring widths.', 'err'); return; }
    if (series.length && !window.confirm('Replace "' + series.id + '" (' + series.length +
        ' rings) with "' + pick.name + '"? Other series in this session are kept. ' +
        'To load it alongside instead, start a new series first.')) return;

    // The operator's mode and direction describe the stage and the core in front
    // of them, not the file, so they are kept. Direction still matters here:
    // loadWidthsMm takes oldest-first and flips a bark-to-pith core back into
    // the order the stage will continue in.
    setSeries(RD.createMeasureSeries({
      id: pick.name, mode: series.mode, direction: $('vroDir').value,
    }));
    series.loadWidthsMm(pick.widths);
    rawMicrons = [];              // nothing here came off the wire; no replay
    selected = series.length - 1;
    setOrigin(pick.origin);
    $('vroId').value = pick.name;
    showLoadPanel(false);
    finishLoad('Loaded ' + series.length + ' rings from ' + whereFrom() + '. ');
  }

  // Bring in EVERY series the picker points into, side by side — what a file of
  // one specimen's radii is: a set measured together and only readable against
  // each other. Nothing already on the table is lost; the loaded series land
  // beside whatever has been measured in this sitting, and only an untouched
  // empty series makes way, having nothing in it to keep.
  var MANY_SERIES = 16;   // past this the table is wide enough to be worth a question

  function doLoadAll() {
    var all = loadGroup();
    if (!all.length) { setMsg('vroLoadMsg', 'Nothing to load.', 'err'); return; }
    if (all.length === 1) { doLoad(); return; }
    var where = whereFrom();
    if (all.length > MANY_SERIES && !window.confirm(all.length + ' series in ' + where +
      ' — the table will be ' + all.length + ' columns wide. Load them all? ' +
      '("Only …" loads the one in the picker instead.)')) return;

    var pick = chosenSeries(), pickName = pick ? pick.name : null;
    var mode = series.mode, dir = $('vroDir').value;
    var keep = session.filter(function (e) { return e.series.length; });
    var taken = keep.map(function (e) { return e.series.id; });

    // Where each series sat on the file's shared axis becomes its lag, so a
    // dated set arrives already lined up — year for year, as it was written.
    // The lags are relative to the earliest of them, and to whatever is already
    // on the table, since offsets() only ever reads them as differences.
    var minLead = all.reduce(function (m, o) { return Math.min(m, o.lead || 0); }, Infinity);
    var base = keep.reduce(function (m, e) { return Math.min(m, e.lag || 0); }, 0);

    var added = all.map(function (o) {
      var sr = RD.createMeasureSeries({ id: freeName(o.name, taken), mode: mode, direction: dir });
      taken.push(sr.id);
      sr.loadWidthsMm(o.widths);
      return { series: sr, origin: o.origin, lag: base + ((o.lead || 0) - minLead) };
    });

    session = keep.concat(added);
    rawMicrons = [];              // nothing here came off the wire; no replay
    // The picker names the series the foot switch carries on with. It is
    // matched by NAME, not by identity: the group was read again to load it.
    var at = 0;
    all.forEach(function (o, i) { if (o.name === pickName) at = i; });
    activate(keep.length + at);
    showLoadPanel(false);

    var rings = added.reduce(function (n, e) { return n + e.series.length; }, 0);
    finishLoad('Loaded ' + added.length + ' series (' + rings + ' rings) from ' + where +
      '. Measuring "' + series.id + '" — click a name above to switch. ');
  }

  function whereFrom() {
    if ($('vroLoadFrom').value === 'file') return 'the file';
    var o = (window.AppUI.loadableSeries() || [])[Number($('vroLoadSeries').value)];
    return o && o.source === 'chron' ? 'chronology ' + o.chron : 'the pool';
  }

  // The stage is wherever it was left and the loaded widths say nothing about
  // it, so the reference is meaningless until it is re-established. Auto-zero
  // does that here and after every ring; a cumulative readout needs the
  // operator to put the stage on the last measured boundary and zero there.
  function finishLoad(head) {
    if (!reading) {
      setMsg('measureMsg', head + 'Edit them below, or connect to carry on measuring.', 'ok');
    } else if (autoZero || series.mode === V.INCREMENTAL) {
      zeroTheVro();
      setMsg('measureMsg', head + 'The VRO is zeroed — the next press adds ring ' +
        (series.length + 1) + '.', 'ok');
    } else {
      setMsg('measureMsg', head + 'Drive the stage to the last measured boundary and press ' +
        '"Zero the VRO" before measuring on.', 'warn');
    }
    render();
  }

  // The provenance line, and the button that writes an amended series back over
  // the one it came from. Only a pool series can be updated in place: a file on
  // the operator's disk is not ours to rewrite, and a chronology member belongs
  // to a built chronology rather than to the pool.
  function syncOrigin() {
    var line = $('vroOrigin'), btn = $('vroUpdatePool');
    if (!origin) {
      line.textContent = '';
      btn.style.display = 'none';
      return;
    }
    line.textContent = origin.source === 'pool'
      ? 'linked to "' + origin.name + '" in the pool'
      : 'loaded from ' + (origin.source === 'file' ? 'a file' : 'chronology ' + origin.chron) +
        ' as "' + origin.name + '"';
    btn.style.display = origin.source === 'pool' ? '' : 'none';
    btn.textContent = 'Update "' + origin.name + '" in the pool';
  }

  function updatePool() {
    if (!origin || origin.source !== 'pool') return;
    var frame = frameOrWarn();
    if (!frame) return;
    var res = window.AppUI.updateMeasuredSeries(frame, origin.name);
    setOrigin(res.added ? null : { name: res.id, source: 'pool' });
    setMsg('measureMsg', res.message, 'ok');
    render();
  }

  // ---- export + handoff ----------------------------------------------------
  // A name typed but not yet committed (no blur, no Enter) is still the name the
  // operator means, so take it before anything is written out under the old one.
  function commitName() { series.id = $('vroId').value.trim() || series.id; }

  function negativeRings(sers) {
    return sers.reduce(function (n, sr) {
      return n + sr.state().rings.filter(function (r) { return r.width < 0; }).length;
    }, 0);
  }
  function negativesOk(sers) {
    var neg = negativeRings(sers);
    return !neg || window.confirm(neg + ' ring(s) have negative widths, which are not ' +
      'valid ring widths. Continue anyway?');
  }

  // The ACTIVE series alone — what "update in the pool" writes back over the one
  // series it was loaded from.
  function frameOrWarn() {
    commitName();
    if (!series.length) { setMsg('measureMsg', 'No rings measured yet.', 'err'); return null; }
    if (!negativesOk([series])) return null;
    return series.toFrame();
  }

  // The whole session as one undated Frame: ring index, then a column per series
  // that has rings, bottom-padded to the longest. This is exactly the shape a
  // multi-series .rwl holds and the shape the pool takes, so saving and
  // crossdating see the same table the operator does.
  function sessionFrame(entries) {
    entries = entries || measured();
    if (!entries.length) return null;
    var n = entries.reduce(function (m, e) { return Math.max(m, e.series.length); }, 0);
    var ring = []; for (var i = 0; i < n; i++) ring.push(i + 1);
    var names = ['ring'], cols = [ring], used = [];
    entries.forEach(function (e) {
      // Two columns with one name break every by-name lookup downstream, so a
      // duplicate is broken here even though the UI discourages one.
      var id = e.series.id, base = id, k = 1;
      while (used.indexOf(id) >= 0) id = base + '_' + (++k);
      used.push(id);
      var w = e.series.orderedWidthsMm();
      while (w.length < n) w.push(null);
      names.push(id); cols.push(w);
    });
    return { names: names, cols: cols };
  }

  function sessionOrWarn() {
    commitName();
    var frame = sessionFrame();
    if (!frame) { setMsg('measureMsg', 'No rings measured yet.', 'err'); return null; }
    if (!negativesOk(measured().map(function (e) { return e.series; }))) return null;
    return frame;
  }

  // A Tucson id is letters and digits in a fixed column field, so the name in the
  // file is not always the name on screen — which is how a series named CMP519B
  // comes back off the disk called CMP519. NOAA's format description gives the
  // core id columns 1-6 and the decade columns 9-12, and 6 is therefore the only
  // id length that is safe everywhere; dplR reads up to 8 and writes them under
  // long.names, but warns that other software may not. So the wider id is the
  // operator's call, made in front of them with the id they will get spelled
  // out — never a silent widening, and never a silent truncation either.
  var TUCSON_SHORT = 6, TUCSON_LONG = 8;

  function rwlIdFor(name, long) {
    return RD.fixNames([name], long ? TUCSON_LONG : TUCSON_SHORT)[0] || 'NEW1';
  }

  // What a .rwl would call each series in this session, and what that costs.
  // With several series the id field stops being cosmetic: CMP519B and CMP519B2
  // both cut to CMP519, and one file cannot hold two series under one id — so a
  // collision is reported as the blocker it is, not as a rename.
  function rwlIdCheck(long) {
    var names = measured().map(function (e) { return e.series.id; });
    // A name typed into the box but not yet committed still belongs to the
    // active series; preview it under the name the operator can see.
    var typed = ($('vroId').value || '').trim();
    if (typed && session[active].series.length) {
      var at = measured().indexOf(session[active]);
      if (at >= 0) names[at] = typed;
    }
    if (!names.length && typed) names = [typed];
    var ids = names.map(function (n) { return rwlIdFor(n, long); });
    var changed = [], dup = [];
    ids.forEach(function (id, i) {
      if (id !== names[i]) changed.push(names[i] + ' \u2192 ' + id);
      if (ids.indexOf(id) !== i && dup.indexOf(id) < 0) dup.push(id);
    });
    return { names: names, ids: ids, changed: changed, dup: dup };
  }

  // The preview appears only when .rwl cannot carry the names as they stand; a
  // name that survives verbatim needs no explaining.
  function syncRwlId() {
    var long = $('vroLongId').checked;
    var chk = rwlIdCheck(long);
    if (!chk.changed.length && !chk.dup.length) { $('vroRwlIdWrap').style.display = 'none'; return; }
    $('vroRwlIdWrap').style.display = '';
    var el = $('vroRwlNote');
    if (chk.dup.length) {
      el.className = 'msg err';
      el.textContent = 'Two series would be written as "' + chk.dup[0] + '" — one .rwl cannot ' +
        'hold both. Tick the 8-character id, or rename one.';
      return;
    }
    el.className = 'hint';
    el.textContent = '.rwl will name ' + (chk.ids.length > 1 ? 'them ' : 'it ') +
      chk.changed.join(', ') + '; .csv keeps the names as typed.';
  }

  // One file for the whole session: every series measured in this sitting goes
  // into it as its own column, which is what a .rwl is for and why re-measuring
  // a radius does not mean a second file.
  function save(kind) {
    var frame = sessionOrWarn();
    if (!frame) return;
    var n = frame.names.length - 1;
    var held = n > 1 ? ' (' + n + ' series)' : '';
    var d, note = '';
    if (kind === 'rwl') {
      var long = $('vroLongId').checked;
      var chk = rwlIdCheck(long);
      if (chk.dup.length) {
        setMsg('measureMsg', 'Not saved: two series would be written under the id "' +
          chk.dup[0] + '", and one .rwl cannot hold both. Tick "' + TUCSON_LONG +
          '-character .rwl id", or rename one of them.', 'err');
        return;
      }
      d = {
        filename: chk.ids[0] + '.rwl', mime: 'text/plain',
        content: RD.writeRwl(frame, { precision: 0.001, longNames: long }),
      };
      if (chk.changed.length) {
        note = ' Written as ' + chk.changed.join(', ') + ' — ' + (long
          ? 'a Tucson id is at most ' + TUCSON_LONG + ' letters and digits.'
          : 'the standard Tucson id is ' + TUCSON_SHORT + ' letters and digits; tick ' +
            '"' + TUCSON_LONG + '-character .rwl id" to keep more of the name.') +
          ' Save .csv to keep the names exactly.';
      }
    } else {
      d = { filename: frame.names[1] + '.csv', mime: 'text/csv', content: RD.writeCsv(frame) };
    }
    window.AppUI.triggerDownload(d);
    setMsg('measureMsg', 'Saved ' + d.filename + held + '.' + note, note ? 'warn' : 'ok');
  }

  // The point of measuring inside RingdateR: the finished series goes straight
  // into the undated pool, so it can be crossdated while the core is still on
  // the stage.
  // Put the sitting into the pool. Series already linked to a pool entry — one
  // loaded from it, or one put there by an earlier click — are written back over
  // themselves rather than copied, so pressing this twice cannot litter the pool
  // with near-identical duplicates of work in progress. What it did is spelled
  // out, because "added" and "overwrote" are not the same thing to be quiet about.
  function addToPool() {
    if (!sessionOrWarn()) return;
    var linked = [], fresh = [];
    measured().forEach(function (e) {
      (e.origin && e.origin.source === 'pool' ? linked : fresh).push(e);
    });

    var updated = [];
    linked.forEach(function (e) {
      var res = window.AppUI.updateMeasuredSeries(e.series.toFrame(), e.origin.name);
      e.origin = { name: res.id, source: 'pool' };
      updated.push(res.id);
    });

    var added = [];
    if (fresh.length) {
      var res = window.AppUI.addMeasuredSeries(sessionFrame(fresh), series.id);
      added = res.ids;
      // Each is now a series OF the pool, so further rings and edits go back to
      // it instead of arriving as yet another copy.
      fresh.forEach(function (e, i) { e.origin = { name: res.ids[i], source: 'pool' }; });
    }
    origin = session[active].origin;

    var parts = [];
    if (added.length) parts.push('Added ' + quoteList(added));
    if (updated.length) parts.push((added.length ? 'updated ' : 'Updated ') + quoteList(updated) +
      ' in place');
    setMsg('measureMsg', parts.join(', ') + '. Crossdating on the Explore tab.', 'ok');
    render();

    // ... and crossdate it, which is the other half of the button. The series
    // to open the plots on is the one being measured (the pool name it was
    // just written under); with nothing active, the first one added.
    var feature = (origin && origin.source === 'pool' && origin.name) ||
      added[0] || updated[0] || null;
    window.AppUI.crossdateSeries(feature);
  }

  function quoteList(ids) {
    return ids.map(function (i) { return '"' + i + '"'; }).join(', ');
  }

  // ---- rendering -----------------------------------------------------------
  function render() {
    var st = series.state();
    $('vroLast').textContent = st.rings.length
      ? (st.rings[st.rings.length - 1].width / 1000).toFixed(3) + ' mm'
      : '—';
    $('vroSummary').textContent = (session.length > 1 ? series.id + ' · ' : '') + series.summary();
    $('vroUndo').disabled = !st.canUndo;
    $('vroDiscard').disabled = session.length === 1 && !st.rings.length;
    $('measureControls').style.display = (reading || ringTotal()) ? '' : 'none';
    syncOrigin();
    syncRwlId();
    renderSeriesList();
    renderLag();
    renderTable();
    renderTrace();
  }

  // The session, one chip per series: which exist, how long each is, and which
  // one the foot switch is currently adding to. Clicking one goes back to it.
  // With a single series there is nothing to choose between, so it stays hidden
  // until a second one exists.
  // The alignment control belongs to the session, not to a series: it only
  // means anything once there is a second series to line the first up against.
  function renderLag() {
    var row = $('vroLagRow');
    if (!row) return;
    if (session.length < 2) { row.style.display = 'none'; return; }
    row.style.display = '';
    var box = $('vroLag');
    var lim = lagLimit();
    box.min = -lim; box.max = lim;      // the arrows stop where the overlap does
    // Never fight the operator's own typing: a box being edited is left alone,
    // or a paint arriving mid-edit reformats the "-" they just typed into "0"
    // as they reach for the digit. It is squared up again on the way out.
    if (box !== document.activeElement) box.value = String(session[active].lag || 0);
    $('vroLagWho').textContent = series.id;
    var off = offsets();
    $('vroLagNote').textContent = off.every(function (o) { return !o; })
      ? 'lined up ring for ring'
      : session.map(function (e, i) {
        return e.series.id + (off[i] ? ' from row ' + (off[i] + 1) : ' from row 1');
      }).join(' · ');
  }

  function renderSeriesList() {
    var wrap = $('vroSeriesList');
    if (session.length < 2) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
    wrap.style.display = '';
    wrap.innerHTML = '<span class="hint">Measuring:</span> ' + session.map(function (e, i) {
      return '<button class="chip' + (i === active ? ' active' : '') + '" data-i="' + i + '"' +
        ' title="' + escA(e.series.summary()) + '">' + esc(e.series.id) +
        ' <span class="n">' + e.series.length + '</span></button>';
    }).join('');
  }

  // One column of widths per series, side by side on a shared ring index — the
  // layout of the .rwl they will be saved into, and the one that lets a second
  // measurement of a radius be read against the first ring by ring. What used to
  // be the Position and Note columns now rides on the width cell itself: absent
  // and backwards rings keep their colour, and the note is the cell's tooltip.
  function renderTable() {
    tintTable();
    var cols = session.map(function (e) { return e.series.state().rings; });
    var off = offsets();
    var n = rowCount();
    var selRow = rowOf(selected);

    $('vroTable').querySelector('thead').innerHTML = '<tr><th>Ring</th>' +
      session.map(function (e, i) {
        // A series that does not start on row 1 says so in its own heading —
        // the rows are the aligned index, not that series' ring numbers.
        return '<th' + (i === active ? ' class="col-active"' : '') +
          ' title="' + escA(e.series.summary()) +
          (off[i] ? ' · starts at row ' + (off[i] + 1) : '') + '">' + esc(e.series.id) +
          (i === active ? ' <span class="pen" aria-label="being measured">✎</span>' : '') +
          (off[i] ? ' <span class="lagmark">+' + off[i] + '</span>' : '') +
          '</th>';
      }).join('') + '</tr>';

    var rows = [];
    for (var r = 0; r < n; r++) {
      var cells = '';
      for (var c = 0; c < cols.length; c++) {
        var ring = cols[c][r - off[c]];
        var cls = c === active ? 'col-active' : '';
        if (!ring) { cells += '<td data-s="' + c + '" class="' + cls + ' pad"></td>'; continue; }
        if (ring.width < 0) cls += ' bad';
        else if (ring.width === 0) cls += ' absent';
        cells += '<td data-s="' + c + '"' + (cls ? ' class="' + cls.trim() + '"' : '') +
          (ring.note ? ' title="' + escA(ring.note) + '"' : '') + '>' +
          (ring.width / 1000).toFixed(3) + '</td>';
      }
      rows.push('<tr data-i="' + r + '"' + (r === selRow ? ' class="sel"' : '') + '>' +
        '<td>' + (r + 1) + '</td>' + cells + '</tr>');
    }
    $('vroTable').querySelector('tbody').innerHTML = rows.join('') ||
      '<tr><td colspan="' + (session.length + 1) + '" class="hint">No rings yet.</td></tr>';

    // Hold the ring being worked on in view. That is always the selected row —
    // a ring that has just arrived off the wire is also the selected ring — so
    // one rule covers measuring and every other repaint (a click, an edit, a
    // delete, an insert in the middle). The row is followed, NOT the foot of
    // the table: a second series measured beside a longer first one is adding
    // rings a long way above the last row, and jumping to the bottom hides the
    // very ring just taken. Nothing already on screen moves, so a repaint never
    // scrolls the row out from under the operator; an APPEND additionally keeps
    // a row of clearance ahead so the next ring lands on screen too.
    var wrap = $('vroTableWrap');
    var appended = series.length > shownCount && selected === series.length - 1;
    // (both are ring counts of the active series; the row it landed on is
    // wherever that series' alignment puts it)
    shownCount = series.length;
    var sel = wrap.querySelector('tr.sel');
    // The active column, so a session wide enough to scroll sideways keeps the
    // widths being written in view too, not just the ring number.
    var cell = sel && (sel.querySelector('td[data-s="' + active + '"]') || sel);
    // While measuring, leave a row of clearance below so the next ring lands on
    // screen rather than beyond the edge; a repaint moves the least it can.
    reveal(wrap, cell, appended ? (sel ? sel.offsetHeight : 0) : 0);
  }

  // Bring a cell fully inside a scrolling table, allowing for the header that
  // sits sticky over the top of it — scrollIntoView tucks a row up underneath
  // that header, out of sight. Moves only the axis that needs moving, and only
  // as far as it must, so anything already in view stays where the operator
  // left it. `margin` is extra clearance beyond the edge being scrolled to.
  function reveal(wrap, cell, margin) {
    if (!wrap || !cell || !cell.getBoundingClientRect) return;
    var w = wrap.getBoundingClientRect(), c = cell.getBoundingClientRect();
    var head = wrap.querySelector('thead');
    var headH = head ? head.getBoundingClientRect().height : 0;
    var m = margin || 0;
    // Rounded: the offsets come out of getBoundingClientRect as fractions, and a
    // fractional scroll leaves the sticky header half a pixel off the rows it is
    // supposed to cover, so the row beneath it shows through as a sliver.
    var above = c.top - (w.top + headH), below = c.bottom - w.bottom;
    if (above < 0) wrap.scrollTop = Math.round(wrap.scrollTop + above - m);
    else if (below > 0) wrap.scrollTop = Math.round(wrap.scrollTop + below + m);
    var left = c.left - w.left, right = c.right - w.right;
    if (left < 0) wrap.scrollLeft = Math.round(wrap.scrollLeft + left);
    else if (right > 0) wrap.scrollLeft = Math.round(wrap.scrollLeft + right);
  }

  // The row under the pointer, the selected row and the column being measured
  // are all tinted with the ACTIVE series' own trace colour — the same colour
  // its line, its legend entry and the cursor are drawn in. In a table holding
  // one column per series, the highlight then says WHICH series a click would
  // edit, rather than merely which row it would land on.
  // The tints are blended to OPAQUE colours rather than left as rgba: the ring
  // table's header is sticky, and a header the rows can be read through is worse
  // than no tint at all. `over` is what each one sits on — white for the body
  // rows, the header's own grey for the header.
  function tint(hex, a, over) {
    var n = parseInt(hex.slice(1), 16), b = parseInt((over || '#ffffff').slice(1), 16);
    function mix(sh) {
      return Math.round(((n >> sh) & 255) * a + ((b >> sh) & 255) * (1 - a));
    }
    return 'rgb(' + mix(16) + ',' + mix(8) + ',' + mix(0) + ')';
  }
  function tintTable() {
    var c = traceColor(active), t = $('vroTable');
    t.style.setProperty('--vro-line', c);
    // The name box belongs to the series it names, so it takes the colour too.
    var name = $('vroNameRow');
    if (name) name.style.setProperty('--vro-line', c);
    t.style.setProperty('--vro-hov', tint(c, 0.13));
    t.style.setProperty('--vro-sel', tint(c, 0.22));
    t.style.setProperty('--vro-sel-col', tint(c, 0.32));
    t.style.setProperty('--vro-col', tint(c, 0.07));
    t.style.setProperty('--vro-col-head', tint(c, 0.16, '#eef2f4'));
  }

  // A live acquisition trace, not an analysis plot: the session's series on one
  // shared ring axis, redrawn on every press, so it is drawn inline rather than
  // through the viz layer (linePlot is a two-series crossdating overlay and needs
  // a year axis). Every series is drawn — a second measurement of a radius is
  // only worth anything against the first — with the active one picked out by
  // weight and by its ring markers, and the mean line belonging to it alone.
  var TRACE_COLORS = ['#2b6cb0', '#c05621', '#2f855a', '#6b46c1', '#b83280', '#4a5568'];
  function traceColor(i) { return TRACE_COLORS[i % TRACE_COLORS.length]; }

  function renderTrace() {
    var el = $('vroTrace');
    var w = el.clientWidth || 600, h = 150, padL = 34, padB = 16, padT = 8;
    var all = session.map(function (e) { return e.series.widthsMm(); });
    var off = offsets();
    var n = all.reduce(function (m, v, i) { return Math.max(m, v.length + off[i]); }, 0);
    if (!n) {
      el.innerHTML = '<p class="hint">The ring-width trace appears here.</p>';
      traceGeom = null;
      return;
    }

    var top = all.reduce(function (m, v) {
      return v.length ? Math.max(m, Math.max.apply(null, v)) : m;
    }, 0.1) * 1.1;
    function px(i) { return n === 1 ? (padL + w) / 2 : padL + (w - padL - 4) * i / (n - 1); }
    function py(v) { return padT + (h - padT - padB) * (1 - v / top); }
    function line(vals, i) {
      if (!vals.length) return '';
      var pts = vals.map(function (v, k) { return px(k + off[i]).toFixed(1) + ',' + py(v).toFixed(1); }).join(' ');
      return '<polyline points="' + pts + '" fill="none" stroke="' + traceColor(i) +
        '" stroke-width="' + (i === active ? 1.6 : 1) + '"' +
        (i === active ? '' : ' opacity="0.55"') + '/>';
    }

    var vals = all[active];
    var dots = vals.map(function (v, i) {
      return '<circle class="ring-dot" cx="' + px(i + off[active]).toFixed(1) + '" cy="' + py(v).toFixed(1) +
        '" r="2" fill="' + (v <= 0 ? '#c53030' : traceColor(active)) + '"/>';
    }).join('');
    // The active series' widths by ROW, which is what the cursor reads: the
    // rows either side of a lagged series have no width of its to show.
    var rowVals = [];
    for (var rv = 0; rv < n; rv++) rowVals.push(vals[rv - off[active]]);
    var mean = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : 0;
    var meanLine = vals.length
      ? '<line x1="' + padL + '" y1="' + py(mean).toFixed(1) + '" x2="' + w + '" y2="' +
        py(mean).toFixed(1) + '" stroke="#e0a0a0" stroke-dasharray="3 3"/>'
      : '';

    // A legend only earns its space once there is more than one line to tell apart.
    var legend = '';
    if (session.length > 1) {
      var x = padL + 26;          // clear of the "N mm" axis label at the top left
      legend = session.map(function (e, i) {
        var t = '<text x="' + x.toFixed(0) + '" y="' + (padT + 8) + '" font-size="9" fill="' +
          traceColor(i) + '"' + (i === active ? ' font-weight="bold"' : ' opacity="0.7"') + '>' +
          esc(e.series.id) + '</text>';
        x += String(e.series.id).length * 5.6 + 12;
        return t;
      }).join('');
    }

    // Until a series is lagged the shared index IS everybody's ring numbering;
    // after one it is nobody's, so the axis says what it is actually counting.
    // Either way the cursor reads out the active series' own rings — see paintCursor.
    var unit = off.every(function (o) { return !o; }) ? 'ring ' : 'row ';

    el.innerHTML =
      '<svg width="100%" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" ' +
      'aria-label="Ring width trace, ' + session.length + ' series, ' + n + ' rings">' +
      meanLine +
      session.map(function (e, i) { return i === active ? '' : line(all[i], i); }).join('') +
      line(vals, active) + dots + legend +
      '<text x="2" y="' + (padT + 8) + '" font-size="9" fill="#666">' + top.toFixed(2) + ' mm</text>' +
      '<text x="2" y="' + (h - padB + 6) + '" font-size="9" fill="#666">0</text>' +
      '<text x="' + padL + '" y="' + (h - 2) + '" font-size="9" fill="#666">' + unit + '1</text>' +
      '<text x="' + w + '" y="' + (h - 2) + '" font-size="9" fill="#666" text-anchor="end">' + unit + n + '</text>' +
      // Last, so it draws over the lines and the legend rather than under them.
      cursorMarkup(padT, h - padB) +
      '</svg>';

    // What the pointer maths and the cursor need, kept from the paint that drew
    // the axes they belong to — a stale mapping would put the cursor on the
    // wrong ring rather than fail visibly.
    traceGeom = { n: n, w: w, h: h, padL: padL, padT: padT, padB: padB, px: px, py: py, vals: rowVals,
      off: off[active], len: vals.length };
    paintCursor();
  }

  // ---- the cursor ----------------------------------------------------------
  // One ring index, shown in both views at once: a vertical line on the trace
  // and a lit row in the table. Hovering either view moves it; clicking either
  // one selects that ring. The line is drawn into the trace's SVG once and then
  // MOVED by attribute, so following the pointer never costs a repaint.
  function cursorMarkup(top, bottom) {
    return '<g id="vroCursor" display="none" pointer-events="none">' +
      '<line class="cur-line" x1="0" y1="' + top + '" x2="0" y2="' + bottom + '"/>' +
      '<circle class="cur-dot" cx="-9" cy="-9" r="3.2"/>' +
      '<rect class="cur-chip" x="0" y="' + (top - 1) + '" rx="2" height="12" width="0" display="none"/>' +
      '<text class="cur-text" x="0" y="' + (top + 8) + '" font-size="9" display="none"></text>' +
      '</g>';
  }

  // The row the cursor stands on: what the pointer is over, or the row the
  // selected ring of the active series sits on once its lag is taken into account.
  function cursorRing() { return hoverRing != null ? hoverRing : rowOf(selected); }

  function paintCursor() {
    var r = cursorRing();

    // The table half of the cursor. Marked with a class rather than left to
    // :hover, so a ring picked out on the PLOT lights its row too — and so the
    // highlight survives a repaint arriving under the pointer.
    var tbl = $('vroTable');
    var lit = tbl.querySelector('tr.hov');
    if (lit) lit.classList.remove('hov');
    if (hoverRing != null) {
      var tr = tbl.querySelector('tr[data-i="' + hoverRing + '"]');
      if (tr) tr.classList.add('hov');
    }

    var g = document.getElementById('vroCursor');
    if (!g || !traceGeom) return;
    if (r == null || r < 0 || r >= traceGeom.n) { g.setAttribute('display', 'none'); return; }
    g.removeAttribute('display');

    var c = traceColor(active), x = traceGeom.px(r);
    var line = g.querySelector('.cur-line');
    line.setAttribute('x1', x.toFixed(1));
    line.setAttribute('x2', x.toFixed(1));
    line.setAttribute('stroke', c);

    // The dot sits on the ACTIVE series' width — the one a click would edit.
    // A series shorter than the trace simply has none at this ring.
    var v = traceGeom.vals[r];
    var dot = g.querySelector('.cur-dot');
    if (v == null) { dot.setAttribute('display', 'none'); }
    else {
      dot.removeAttribute('display');
      dot.setAttribute('cx', x.toFixed(1));
      dot.setAttribute('cy', traceGeom.py(v).toFixed(1));
      dot.setAttribute('fill', v <= 0 ? '#c53030' : c);
    }

    // The label is a hover affordance: it answers "which ring is this?" for a
    // pointer, and would otherwise sit permanently over the legend it covers.
    var chip = g.querySelector('.cur-chip'), text = g.querySelector('.cur-text');
    if (hoverRing == null) {
      chip.setAttribute('display', 'none');
      text.setAttribute('display', 'none');
      return;
    }
    // The ring number belongs to the ACTIVE series — the one whose width the dot
    // and the mm reading come from — not to the shared row index. They are the
    // same number until a lag is set; after one, reading out the row would name a
    // ring of whichever series happens to start at row 1. Beyond the active
    // series' own rings the count is bracketed and dimmed, as the crossdating
    // cursor brackets a year outside a series' span; the row is named alongside
    // it while a lag is on, since the table beside the trace is numbered by row.
    var ring = r - traceGeom.off + 1;
    var out = ring < 1 || ring > traceGeom.len;
    var label = (out ? '(ring ' + ring + ')' : 'ring ' + ring) +
      (traceGeom.off ? ' · row ' + (r + 1) : '') +
      (v == null ? '' : ' · ' + v.toFixed(3) + ' mm');
    var wide = label.length * 5.0 + 10;
    var lx = x + 4 + wide > traceGeom.w ? x - 4 - wide : x + 4;   // flip at the edge
    chip.removeAttribute('display');
    chip.setAttribute('x', lx.toFixed(1));
    chip.setAttribute('width', wide.toFixed(1));
    chip.setAttribute('stroke', c);
    text.removeAttribute('display');
    text.setAttribute('x', (lx + 5).toFixed(1));
    text.setAttribute('fill', c);
    text.setAttribute('opacity', out ? '0.65' : '1');
    text.textContent = label;
  }

  // Which ring a pointer at clientX is over. The SVG is drawn in its own
  // coordinates and stretched to the box, so the x has to come back through
  // that scale before it means anything in ring numbers.
  function ringAtX(clientX) {
    var svg = $('vroTrace').querySelector('svg');
    if (!svg || !traceGeom || !traceGeom.n) return null;
    var box = svg.getBoundingClientRect();
    if (!box.width) return null;
    var g = traceGeom;
    if (g.n === 1) return 0;
    var x = (clientX - box.left) * (g.w / box.width);
    var i = Math.round((x - g.padL) * (g.n - 1) / (g.w - g.padL - 4));
    return Math.max(0, Math.min(g.n - 1, i));
  }

  // Move the cursor from one view or the other. `from` is remembered so that
  // leaving the table does not cancel a hover that belongs to the plot.
  function setHover(ring, from) {
    if (ring === hoverRing && (ring == null || from === hoverFrom)) return;
    hoverRing = ring;
    hoverFrom = ring == null ? null : from;
    paintCursor();
  }

  // Sound controls reflect the stored preference, and every change previews
  // itself — setting a level you cannot hear is the whole difficulty otherwise.
  function wireSound() {
    var A = window.MeasureAudio;
    var box = $('vroSound'), vol = $('vroVolume');
    if (!A) { box.disabled = true; vol.disabled = true; box.checked = false; return; }

    box.checked = A.enabled();
    vol.value = Math.round(A.volume() * 100);

    box.addEventListener('change', function () {
      if (A.setEnabled(box.checked)) A.preview(A.RING);
    });
    vol.addEventListener('input', function () { A.setVolume(vol.value / 100); });
    vol.addEventListener('change', function () { if (A.enabled()) A.preview(A.RING); });

    // Audition every marker in order, so the hierarchy can be heard and the level
    // set without measuring a thousand rings to reach the last one. Each waits
    // for the one before to finish — the markers differ in how many notes they
    // count out, so a fixed spacing would run them into each other.
    $('vroTestTones').addEventListener('click', function () {
      var at = 0;
      A.markers().forEach(function (kind) {
        setTimeout(function () { A.preview(kind); }, at);
        at += Math.round(A.lengthOf(kind) * 1000) + 340;   // a beat between them
      });
      setMsg('measureMsg', 'Ring, tenth, fiftieth, hundredth, thousandth.', '');
    });
  }

  // ---- wiring --------------------------------------------------------------
  function init() {
    if (!$('view-measure')) return;

    if (!supported()) {
      $('measureUnsupported').style.display = '';
      $('measureMain').style.display = 'none';
      return;
    }

    // The Connect click is the user gesture browsers require before any audio
    // can play, so the sound context is opened on the way past.
    $('vroConnect').addEventListener('click', function () {
      if (window.MeasureAudio) window.MeasureAudio.unlock();
      connect();
    });
    wireSound();
    $('vroZero').addEventListener('click', Actions.zero);
    $('vroRequest').addEventListener('click', Actions.request);
    $('vroAutoZero').addEventListener('change', function () {
      applyAutoZero($('vroAutoZero').checked);
    });
    $('vroAbsent').addEventListener('click', Actions.absent);
    $('vroUndo').addEventListener('click', Actions.undo);
    $('vroEdit').addEventListener('click', Actions.edit);
    $('vroInsert').addEventListener('click', Actions.insert);
    $('vroDelete').addEventListener('click', Actions.remove);
    $('vroNew').addEventListener('click', Actions.newSeries);
    $('vroDiscard').addEventListener('click', Actions.discard);
    // Aligning is a thing done by eye, against the plot and the table: it has to
    // answer the arrows on the box (and a typed digit) at once, not on blur.
    $('vroLag').addEventListener('input', function () { setLag($('vroLag').value); });
    // Half-typed input ("-", "", "9999") is squared up once the box is left.
    // Written back here rather than left to renderLag, which holds off while the
    // box has focus — during a blur it may still be the focused element.
    $('vroLag').addEventListener('blur', function () {
      setLag($('vroLag').value);
      $('vroLag').value = String(session[active].lag || 0);
    });
    $('vroLagReset').addEventListener('click', function () {
      session.forEach(function (e) { e.lag = 0; });
      render();
    });

    $('vroSeriesList').addEventListener('click', function (ev) {
      var b = ev.target.closest('.chip[data-i]');
      if (b) activate(Number(b.getAttribute('data-i')));
    });
    $('vroLoadOpen').addEventListener('click', function () { showLoadPanel(!loadPanelOpen()); });
    $('vroLoadFrom').addEventListener('change', function () {
      $('vroLoadFileWrap').style.display = $('vroLoadFrom').value === 'file' ? '' : 'none';
      setMsg('vroLoadMsg', '', '');
      fillLoadSeries();
    });
    $('vroLoadFile').addEventListener('change', onLoadFile);
    $('vroLoadSeries').addEventListener('change', syncLoadButtons);
    $('vroLoadGo').addEventListener('click', doLoadAll);
    $('vroLoadOne').addEventListener('click', doLoad);
    $('vroUpdatePool').addEventListener('click', updatePool);
    $('vroSaveRwl').addEventListener('click', function () { save('rwl'); });
    $('vroSaveCsv').addEventListener('click', function () { save('csv'); });
    $('vroAddPool').addEventListener('click', addToPool);

    $('vroId').addEventListener('change', function () {
      series.id = $('vroId').value.trim() || 'NEW1';
      render();                      // the name shows in the chips, header and legend
    });
    $('vroId').addEventListener('input', syncRwlId);
    $('vroLongId').addEventListener('change', syncRwlId);
    $('vroDir').addEventListener('change', function () { series.direction = $('vroDir').value; render(); });
    $('vroMode').addEventListener('change', function () { modeLocked = true; applyMode($('vroMode').value); });

    // Hovering a row moves the cursor on the trace above, so a row can be found
    // on the plot — and a bump in the trace found in the table — without
    // counting rings across the two.
    $('vroTable').addEventListener('mouseover', function (ev) {
      var tr = ev.target.closest && ev.target.closest('tr[data-i]');
      setHover(tr ? Number(tr.getAttribute('data-i')) : null, 'table');
    });
    $('vroTableWrap').addEventListener('mouseleave', function () {
      if (hoverFrom === 'table') setHover(null, 'table');
    });

    // The same tie, read the other way: the trace is a picture of the table, so
    // a ring picked out on it lights its row, and a click selects it.
    $('vroTrace').addEventListener('mousemove', function (ev) {
      setHover(ringAtX(ev.clientX), 'plot');
    });
    $('vroTrace').addEventListener('mouseleave', function () {
      if (hoverFrom === 'plot') setHover(null, 'plot');
    });
    $('vroTrace').addEventListener('click', function (ev) {
      var r = ringAtX(ev.clientX);
      // The trace runs to the longest series in the session; the active one may
      // be shorter, and only its own rings can be selected for editing.
      if (r == null || !series.length) return;
      selected = ringOf(r);
      render();
    });

    $('vroTable').addEventListener('click', function (ev) {
      var tr = ev.target.closest('tr[data-i]');
      if (!tr) return;
      var row = Number(tr.getAttribute('data-i'));
      // Clicking inside another series' column moves the work there — that is
      // how a ring is corrected in the series it belongs to, and how measuring
      // resumes on a radius that was left half-done. The row is read back into a
      // ring AFTER that, since it is the series taking over whose lag decides
      // which of its rings that row holds.
      var td = ev.target.closest('td[data-s]');
      if (td) {
        var si = Number(td.getAttribute('data-s'));
        if (si !== active) activate(si);
      }
      selected = series.length ? ringOf(row) : null;
      render();
    });

    // Shortcuts, live only on this view and never while typing in a field.
    document.addEventListener('keydown', function (ev) {
      if (!$('view-measure').classList.contains('active')) return;
      var t = ev.target.tagName;
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
      if (ev.key === 'Backspace') { ev.preventDefault(); Actions.undo(); }
      else if (ev.key === '0') { ev.preventDefault(); Actions.absent(); }
      else if (ev.key === 'Delete') { ev.preventDefault(); Actions.remove(); }
      else if (ev.key === 'e' || ev.key === 'E') { ev.preventDefault(); Actions.edit(); }
    });

    // Chrome fires these when the cable is physically plugged or pulled.
    navigator.serial.addEventListener('disconnect', function (ev) {
      if (port && ev.target === port) {
        // Tear the port down properly; a yanked cable still leaves an open
        // SerialPort object behind, which blocks the next Connect.
        releasePort().then(function () {
          port = null;
          setConnected(false, 'cable disconnected');
          setMsg('measureMsg', 'The VRO was unplugged. Your measured rings are safe.', 'err');
        });
      }
    });

    // Release the port when the page goes away. Chrome usually reclaims it on
    // tab close, but a same-tab reload can leave a locked reader behind, and the
    // reloaded page then cannot open its own port.
    window.addEventListener('pagehide', function () {
      if (isOpen(port)) { try { releasePort(); } catch (e) { /* best effort */ } }
    });

    setConnected(false);
    applyAutoZero(true, true);   // Tellervo's behaviour is the default
    restorePort();
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Published for the guided tour and the tests. The session accessors are
  // read-only views: the view owns its state.
  window.MeasureUI = Object.assign({}, Actions, {
    session: function () {
      return session.map(function (e, i) {
        return { id: e.series.id, rings: e.series.length, active: i === active,
          lag: e.lag || 0, row: offsets()[i] };
      });
    },
    activate: activate,
    sessionFrame: sessionFrame,
  });
})();
