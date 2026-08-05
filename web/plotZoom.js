'use strict';
// plotZoom.js — DATA-DOMAIN zoom/pan for a single-panel plot spec (used for the
// line plot / crossdate overlay). Unlike scaling the SVG image, this changes the
// plotted x/y domains and RE-RENDERS, so axes stay crisp and ticks regenerate for
// the visible range. Scroll = zoom toward cursor, drag = pan, double-click = reset.
// Browser-only; exposes window.PlotZoom.attachDataZoom(container, spec, renderSvg).
(function () {
  // Plot-area margins — must match M in src/viz/render.js.
  var M = { top: 34, right: 20, bottom: 40, left: 64 };

  var active = null;     // drag context (module singleton; only one plot drags at a time)
  var rafPending = false;

  // ---- nearest-line hover tooltip (opt-in via opts.hoverLines) --------------
  // A shared, body-level tooltip. Lines are 0.5px wide, so a native <title> is
  // impossible to hover; instead we find the line closest to the cursor's y at
  // the cursor's x and name it when within a few pixels.
  var tip = null;
  function ensureTip() {
    if (tip) return;
    tip = document.createElement('div');
    tip.className = 'plot-hover-tip';
    tip.style.cssText = 'position:fixed;z-index:1000;pointer-events:none;display:none;white-space:nowrap;' +
      'background:#222d32;color:#fff;font:12px sans-serif;padding:2px 7px;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.3)';
    document.body.appendChild(tip);
  }
  function showTip(cx, cy, text) { ensureTip(); tip.textContent = text; tip.style.left = (cx + 12) + 'px'; tip.style.top = (cy + 12) + 'px'; tip.style.display = 'block'; }
  function hideTip() { if (tip) tip.style.display = 'none'; }

  // y of a complete-case line {x[],y[]} (x ascending) at query x, else null.
  function lineYAt(line, qx) {
    var x = line.x, y = line.y, n = x.length;
    if (n === 0 || qx < x[0] || qx > x[n - 1]) return null;
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (x[mid] <= qx) lo = mid; else hi = mid; }
    var x0 = x[lo], x1 = x[hi];
    return x1 === x0 ? y[lo] : y[lo] + (y[hi] - y[lo]) * (qx - x0) / (x1 - x0);
  }

  function niceStep(span, target) {
    if (!(span > 0)) return 1;
    var raw = span / (target || 6);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1;
    return step * mag;
  }
  function niceTicks(min, max, target) {
    if (!(max > min)) return [min];
    var step = niceStep(max - min, target);
    var out = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
      out.push(Math.round(v / step) * step);   // snap to step to kill fp drift
    }
    return out;
  }

  // Clone the spec with overridden domains; regenerate ticks when zoomed, but keep
  // the original (R-exact) breaks at the home view so the initial plot is unchanged.
  function withView(spec, xd, yd, home) {
    var s = Object.assign({}, spec);
    s.scales = {
      x: Object.assign({}, spec.scales.x, {
        domain: xd.slice(),
        breaks: home && spec.scales.x.breaks ? spec.scales.x.breaks : niceTicks(xd[0], xd[1], 8)
      }),
      y: Object.assign({}, spec.scales.y, {
        domain: yd.slice(),
        breaks: home && spec.scales.y.breaks ? spec.scales.y.breaks : niceTicks(yd[0], yd[1], 6)
      })
    };
    return s;
  }

  function attachDataZoom(container, spec, renderSvg, opts) {
    var hoverLines = (opts && opts.hoverLines) || null;   // [{ name, x, y }] for the hover tooltip
    // Only single-panel specs with numeric scales are data-zoomable; anything else
    // renders statically.
    if (!spec || !spec.scales || spec.panels) { container.innerHTML = renderSvg ? renderSvg(spec) : ''; return; }
    var W = spec.width, H = spec.height;
    var box = { left: M.left, right: W - M.right, top: M.top, bottom: H - M.bottom };
    var xHome = spec.scales.x.domain.slice(), yHome = spec.scales.y.domain.slice();
    var xd = xHome.slice(), yd = yHome.slice();

    function isHome() { return xd[0] === xHome[0] && xd[1] === xHome[1] && yd[0] === yHome[0] && yd[1] === yHome[1]; }

    // client px -> data coords using the on-screen SVG rect + viewBox (0 0 W H).
    function toData(svg, cx, cy) {
      var r = svg.getBoundingClientRect();
      var vx = (cx - r.left) / r.width * W, vy = (cy - r.top) / r.height * H;
      var fx = (vx - box.left) / (box.right - box.left);
      var fy = (vy - box.top) / (box.bottom - box.top);
      return {
        x: xd[0] + fx * (xd[1] - xd[0]),
        y: yd[1] - fy * (yd[1] - yd[0]),         // svg y is top-down; data y is bottom-up
        inside: fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1, rect: r
      };
    }

    function scheduleDraw() {
      if (rafPending) return;
      rafPending = true;
      (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () { rafPending = false; draw(); });
    }

    function draw() {
      hideTip();
      container.innerHTML = renderSvg(withView(spec, xd, yd, isHome()));
      var svg = container.querySelector('svg');
      if (!svg) return;
      svg.style.cursor = active ? 'grabbing' : 'grab';
      svg.style.touchAction = 'none';

      // Nearest-line hover: name the series closest to the cursor (within ~6px).
      if (hoverLines) {
        svg.addEventListener('mousemove', function (e) {
          if (active) { hideTip(); return; }
          var d = toData(svg, e.clientX, e.clientY);
          if (!d.inside) { hideTip(); return; }
          var pxH = (box.bottom - box.top) / H * d.rect.height;   // plot-area height in client px
          var tol = 6 * (yd[1] - yd[0]) / pxH;                    // 6px in data-y units
          var best = null, bestDist = Infinity;
          for (var i = 0; i < hoverLines.length; i++) {
            var ly = lineYAt(hoverLines[i], d.x);
            if (ly == null) continue;
            var dist = Math.abs(ly - d.y);
            if (dist < bestDist) { bestDist = dist; best = hoverLines[i]; }
          }
          if (best && bestDist <= tol) showTip(e.clientX, e.clientY, best.name);
          else hideTip();
        });
        svg.addEventListener('mouseleave', hideTip);
      }

      svg.addEventListener('wheel', function (e) {
        var d = toData(svg, e.clientX, e.clientY);
        if (!d.inside) return;
        e.preventDefault();
        // Independent axes: plain wheel zooms X (time) only — so zooming into a
        // period keeps the full width range in view; Shift zooms Y (width) only;
        // Ctrl/Cmd zooms both. (Shift+wheel may arrive as deltaX in some browsers.)
        var delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        var f = delta < 0 ? 0.85 : 1 / 0.85;      // scroll up = zoom in
        var both = e.ctrlKey || e.metaKey;
        if (both || !e.shiftKey) xd = [d.x - (d.x - xd[0]) * f, d.x + (xd[1] - d.x) * f];
        if (both || e.shiftKey) yd = [d.y - (d.y - yd[0]) * f, d.y + (yd[1] - d.y) * f];
        draw();
      }, { passive: false });

      svg.addEventListener('mousedown', function (e) {
        var d = toData(svg, e.clientX, e.clientY);
        if (!d.inside) return;
        e.preventDefault();
        var r = d.rect;
        var pxW = (box.right - box.left) / W * r.width;    // plot-area width in client px
        var pxH = (box.bottom - box.top) / H * r.height;
        active = {
          startClientX: e.clientX, startClientY: e.clientY,
          startXd: xd.slice(), startYd: yd.slice(),
          dataPerPxX: (xd[1] - xd[0]) / pxW,
          dataPerPxY: (yd[1] - yd[0]) / pxH,
          apply: function (nx, ny) { xd = nx; yd = ny; scheduleDraw(); }
        };
        svg.style.cursor = 'grabbing';
      });

      svg.addEventListener('dblclick', function (e) { e.preventDefault(); xd = xHome.slice(); yd = yHome.slice(); draw(); });
    }

    draw();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('mousemove', function (e) {
      if (!active) return;
      var dx = (e.clientX - active.startClientX) * active.dataPerPxX;
      var dy = (e.clientY - active.startClientY) * active.dataPerPxY;
      active.apply(
        [active.startXd[0] - dx, active.startXd[1] - dx],   // drag right -> earlier x
        [active.startYd[0] + dy, active.startYd[1] + dy]    // drag down  -> higher y stays under cursor
      );
    });
    document.addEventListener('mouseup', function () { active = null; });
  }

  var API = { attachDataZoom: attachDataZoom, niceTicks: niceTicks };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else window.PlotZoom = API;
})();
