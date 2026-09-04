/* ============================================================================
 * measure-audio.js — audible feedback for the Measure view.
 *
 * The markers are the pencil dots dendrochronologists already put on a core —
 * one at each decade, two at each fifty, three at each century, four at each
 * thousand — sounded rather than drawn, so the operator can keep count without
 * looking up from the microscope:
 *
 *   every ring     one woodblock hit
 *   every 10th     a marimba note instead
 *   every 50th     that note twice
 *   every 100th    three times
 *   every 1000th   four times
 *
 * A MARKER MUST NEVER SOUND LIKE A RING. The decade was once the woodblock hit
 * twice (Tellervo's cue), and at the pedal it was heard as a slipped second
 * press of the foot switch — the one reading a marker must never suggest. So
 * every marker is the pitched note, which no press ever makes, and they are
 * told apart from each other by how many times it repeats, exactly as the dots
 * go on the core. The woodblock is then unambiguous — it means one ring, and
 * nothing else, however many notes are counted out beside it.
 *
 * Woodblock is a triangle transient plus a short filtered noise crack — dry and
 * brief (~50 ms), so it stays legible over a fan or dust extractor and does not
 * smear into the next ring at measuring speed. Marimba is a soft-mallet sine
 * with a quiet upper partial, longer but low enough not to mask the next ring.
 *
 * Browsers refuse to start audio without a user gesture, so the context is
 * created lazily by unlock(), which the Connect button calls. Preference and
 * volume persist in localStorage.
 * ==========================================================================*/
(function () {
  'use strict';

  var STORE_ON = 'rdw.measure.sound';
  var STORE_VOL = 'rdw.measure.sound.volume';

  // The dot intervals, weakest first. A ring lands on several of them at once —
  // 1000 is a decade, a fifty and a century too — and the strongest it reaches
  // is the one that sounds.
  var DECADE = 10;          // a marimba note every tenth ring
  var FIFTY = 50;           // that note twice every fiftieth
  var HUNDRED = 100;        // three times every hundredth
  var THOUSAND = 1000;      // four times every thousandth
  var DOUBLE_GAP = 0.085;   // seconds between two woodblock hits
  // The mallet's body runs to ~0.18 s, so a doubled note needs a wider gap than
  // the dry hit does: any closer and the two smear into one longer note rather
  // than reading as two.
  var MALLET_GAP = 0.2;
  var VOICE_LEN = 0.06;     // longest a single woodblock hit rings for
  var MALLET_LEN = 0.2;     // and a single marimba note

  var RING = 'ring', DECADE_MARK = 'decade', FIFTY_MARK = 'fifty',
    HUNDRED_MARK = 'hundred', THOUSAND_MARK = 'thousand';

  var ctx = null, master = null, noiseBuf = null;
  var enabled = read(STORE_ON, true);
  var volume = clamp(Number(read(STORE_VOL, 0.45)), 0, 1);

  function read(key, fallback) {
    try {
      var v = window.localStorage.getItem(key);
      if (v === null) return fallback;
      return v === 'true' ? true : (v === 'false' ? false : v);
    } catch (e) { return fallback; }          // private mode / storage disabled
  }
  function write(key, value) {
    try { window.localStorage.setItem(key, String(value)); } catch (e) { /* fine */ }
  }
  function clamp(n, lo, hi) {
    return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : hi;
  }

  // ---- graph ---------------------------------------------------------------
  function unlock() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    if (!ctx) {
      try { ctx = new Ctx(); } catch (e) { return false; }
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    // A context created before the gesture starts suspended; resume is cheap
    // and harmless when it is already running.
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    return true;
  }

  function noise() {
    if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
      var n = Math.floor(ctx.sampleRate * 0.05);
      noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  // One woodblock hit at time t.
  function hit(t) {
    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1200, t);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.047);
    osc.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + VOICE_LEN);

    var src = ctx.createBufferSource();
    src.buffer = noise();
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 0.8;
    var ng = ctx.createGain();
    ng.gain.setValueAtTime(0.2, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.007);
    src.connect(bp); bp.connect(ng); ng.connect(master);
    src.start(t); src.stop(t + 0.03);
  }

  // One marimba note at time t: soft-mallet sine plus a quiet upper partial.
  function mallet(t) {
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(587, t);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.42, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.176);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.2);

    var p = ctx.createOscillator();
    p.type = 'sine';
    p.frequency.setValueAtTime(2348, t);
    var pg = ctx.createGain();
    pg.gain.setValueAtTime(0.0001, t);
    pg.gain.exponentialRampToValueAtTime(0.06, t + 0.004);
    pg.gain.exponentialRampToValueAtTime(0.0001, t + 0.054);
    p.connect(pg); pg.connect(master);
    p.start(t); p.stop(t + 0.08);
  }

  // ---- public --------------------------------------------------------------

  // Which marker the n-th ring earns. Tested strongest first: a ring that is a
  // multiple of two intervals gets the stronger one, or the stronger marker
  // would never sound at all — every thousandth is also a hundredth, a fiftieth
  // and a tenth. Exposed so the behaviour is assertable without listening.
  function markerFor(n) {
    if (!Number.isFinite(n) || n <= 0) return RING;
    if (n % THOUSAND === 0) return THOUSAND_MARK;
    if (n % HUNDRED === 0) return HUNDRED_MARK;
    if (n % FIFTY === 0) return FIFTY_MARK;
    if (n % DECADE === 0) return DECADE_MARK;
    return RING;
  }

  function isDecade(n) { return markerFor(n) === DECADE_MARK; }
  function isFifty(n) { return markerFor(n) === FIFTY_MARK; }
  function isHundred(n) { return markerFor(n) === HUNDRED_MARK; }
  function isThousand(n) { return markerFor(n) === THOUSAND_MARK; }

  // What each marker is made of, as voices in order. Kept as data rather than
  // branches so the mapping can be asserted (and re-tuned) without listening.
  var VOICES = {};
  VOICES[RING] = ['hit'];
  VOICES[DECADE_MARK] = ['mallet'];
  VOICES[FIFTY_MARK] = ['mallet', 'mallet'];
  VOICES[HUNDRED_MARK] = ['mallet', 'mallet', 'mallet'];
  VOICES[THOUSAND_MARK] = ['mallet', 'mallet', 'mallet', 'mallet'];

  // How long a marker takes to sound, in seconds — the last voice's start plus
  // the tail it rings for. The controls space the auditioned markers by it, so
  // a four-note thousand is not stepped on by whatever is played next.
  function lengthOf(kind) {
    var v = voicesFor(kind), last = v.length - 1;
    var t = 0;
    for (var i = 1; i < v.length; i++) t += v[i] === 'mallet' ? MALLET_GAP : DOUBLE_GAP;
    return t + (v[last] === 'mallet' ? MALLET_LEN : VOICE_LEN);
  }

  function voicesFor(kind) { return (VOICES[kind] || VOICES[RING]).slice(); }

  // Schedule one marker's sound starting at t.
  function play(kind, t) {
    var voices = voicesFor(kind);
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      var at = t + i * (v === 'mallet' ? MALLET_GAP : DOUBLE_GAP);
      if (v === 'mallet') mallet(at); else hit(at);
    }
  }

  // ring(n) — sound the n-th recorded ring (1-based). Returns the marker played.
  function ring(n) {
    if (!enabled || !unlock()) return null;
    var kind = markerFor(n);
    play(kind, ctx.currentTime + 0.01);
    return kind;
  }

  // Play one marker on demand, ignoring the ring count — used to set the level
  // and to audition the markers from the controls.
  function preview(kind) {
    if (!unlock()) return false;
    play(kind || RING, ctx.currentTime + 0.01);
    return true;
  }

  window.MeasureAudio = {
    unlock: unlock,
    ring: ring,
    preview: preview,
    markerFor: markerFor,
    voicesFor: voicesFor,
    lengthOf: lengthOf,
    // Every marker there is, weakest first — what the controls audition.
    markers: function () { return [RING, DECADE_MARK, FIFTY_MARK, HUNDRED_MARK, THOUSAND_MARK]; },
    isDecade: isDecade,
    isFifty: isFifty,
    isHundred: isHundred,
    isThousand: isThousand,
    RING: RING, DECADE_MARK: DECADE_MARK, FIFTY_MARK: FIFTY_MARK,
    HUNDRED_MARK: HUNDRED_MARK, THOUSAND_MARK: THOUSAND_MARK,
    DECADE: DECADE, FIFTY: FIFTY, HUNDRED: HUNDRED, THOUSAND: THOUSAND,
    enabled: function () { return enabled; },
    setEnabled: function (on) {
      enabled = !!on;
      write(STORE_ON, enabled);
      if (enabled) unlock();
      return enabled;
    },
    volume: function () { return volume; },
    setVolume: function (v) {
      volume = clamp(Number(v), 0, 1);
      write(STORE_VOL, volume);
      if (master) master.gain.value = volume;
      return volume;
    },
  };
})();
