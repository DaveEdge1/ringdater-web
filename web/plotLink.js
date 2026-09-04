'use strict';
// plotLink.js — linked year-hover across plots. Panels whose builder declares
// linkAxis:'year' carry an invisible <rect class="rd-hot" data-xmin data-xmax>
// over their plot area (see src/viz/render.js). Hovering any linked plot maps
// the cursor to a (rounded) year and draws a shared cursor line + year label in
// EVERY linked panel whose x-domain contains that year — so a year on the line
// plot lights up the matching year on each skeleton-plot row, and vice versa.
//
// A comparison panel draws its second series shifted by the crossdate lag, so
// the one cursor stands on a DIFFERENT position in each series — which is what
// the plot is being read for. Such a panel declares its series (spec.linkSeries
// -> data-series on the hotzone) and the cursor labels both, each in the colour
// that series carries in the legend: a calendar year for a dated series, a ring
// count for an undated one, which has no years to name.
//
// Delegated listeners survive innerHTML re-renders (PlotZoom re-rendering the
// line plot on zoom just refreshes the hotzone attributes). Re-calling
// linkYearHover with an overlapping set updates each container's link group.
// Browser-only; exposes window.PlotLink.linkYearHover(containers).
(function () {
  var NS = 'http://www.w3.org/2000/svg';

  function clearCursors(containers) {
    containers.forEach(function (c) {
      c.querySelectorAll('.rd-cursor').forEach(function (n) { n.remove(); });
    });
  }

  // What the hovered x is in each plotted series' own numbering. A comparison
  // plot draws the second series shifted by the crossdate lag, so one cursor
  // stands on two different positions — the pairing the plot exists to be read
  // for. The panel declares them (see spec.linkSeries in src/viz/render.js); a
  // panel that does not falls back to the one year of its own axis.
  //
  // A DATED series is labelled with its calendar year. An UNDATED one has no
  // year to give — it is the series being dated — so its label is a ring count
  // from its own first ring, written "ring 12" so a small number is never read
  // as a year.
  function seriesRows(hot, year) {
    var raw = hot.getAttribute('data-series');
    if (!raw) return [];
    var list;
    try { list = JSON.parse(raw); } catch (e) { return []; }
    if (!Array.isArray(list) || !list.length) return [];
    return list.map(function (s) {
      var v = year + (+s.offset || 0);
      // Outside a series' own data the position is an extrapolation of where it
      // WOULD fall, not a ring it has: shown, but visibly not a reading.
      var out = !!(s.span && (v < s.span[0] || v > s.span[1]));
      var pre = s.unit === 'ring' ? 'ring ' : '';
      return {
        label: s.label == null ? '' : String(s.label),
        color: s.color || '#333',
        pre: out ? '(' + pre : pre,
        num: String(v),
        post: out ? ')' : '',
        dim: out,
      };
    });
  }

  var FS = 10, LH = 12, PAD = 4;
  // Rough advance width at font-size 10 sans-serif — enough to size the backing
  // box and decide which side of the line it fits on.
  function textWidth(row) {
    return (row.label ? row.label.length + 1 : 0) * 5.4 +
      (row.pre.length + row.post.length) * 5.4 + row.num.length * 6.1;
  }

  function drawCursor(svg, hot, year) {
    var xmin = +hot.getAttribute('data-xmin'), xmax = +hot.getAttribute('data-xmax');
    var x = +hot.getAttribute('x'), w = +hot.getAttribute('width');
    var y = +hot.getAttribute('y'), h = +hot.getAttribute('height');
    if (!(xmax > xmin) || !(w > 0)) return;
    var px = x + (year - xmin) / (xmax - xmin) * w;
    var g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'rd-cursor');
    g.setAttribute('pointer-events', 'none');
    var ln = document.createElementNS(NS, 'line');
    ln.setAttribute('x1', px); ln.setAttribute('x2', px);
    ln.setAttribute('y1', y); ln.setAttribute('y2', y + h);
    ln.setAttribute('stroke', '#f39c12'); ln.setAttribute('stroke-width', '1.2');
    g.appendChild(ln);

    var rows = seriesRows(hot, year);
    if (!rows.length) {
      var t = document.createElementNS(NS, 'text');
      // keep the label inside the panel: flip to the left of the line near the right edge
      var flip1 = px > x + w - 40;
      t.setAttribute('x', flip1 ? px - 4 : px + 4);
      t.setAttribute('y', y + 11);
      t.setAttribute('font-size', String(FS)); t.setAttribute('font-family', 'sans-serif');
      t.setAttribute('fill', '#b06f00');
      if (flip1) t.setAttribute('text-anchor', 'end');
      t.textContent = String(year);
      g.appendChild(t);
      svg.appendChild(g);
      return;
    }

    // One line per series, in its own colour, on a plate that keeps them
    // readable over the lines and marks they are standing on.
    var wide = rows.reduce(function (m, r) { return Math.max(m, textWidth(r)); }, 0);
    var bw = wide + PAD * 2, bh = rows.length * LH + PAD;
    var flip = px + 6 + bw > x + w;
    var bx = flip ? px - 6 - bw : px + 6;
    if (bx < x) bx = x;                       // a panel narrower than the plate
    var by = y + 2;
    var plate = document.createElementNS(NS, 'rect');
    plate.setAttribute('x', bx.toFixed(1)); plate.setAttribute('y', by.toFixed(1));
    plate.setAttribute('width', bw.toFixed(1)); plate.setAttribute('height', bh.toFixed(1));
    plate.setAttribute('rx', '2');
    plate.setAttribute('fill', '#ffffff'); plate.setAttribute('fill-opacity', '0.82');
    plate.setAttribute('stroke', '#f39c12'); plate.setAttribute('stroke-width', '0.6');
    plate.setAttribute('stroke-opacity', '0.5');
    g.appendChild(plate);
    rows.forEach(function (r, i) {
      var tx = document.createElementNS(NS, 'text');
      tx.setAttribute('x', (bx + PAD).toFixed(1));
      tx.setAttribute('y', (by + PAD + LH * i + FS - 1).toFixed(1));
      tx.setAttribute('font-size', String(FS)); tx.setAttribute('font-family', 'sans-serif');
      tx.setAttribute('fill', r.color);
      if (r.dim) tx.setAttribute('opacity', '0.45');
      // plain: the series name and any "ring"/bracket wrapping; bold: the number
      var plain = r.label ? r.label + ' ' + r.pre : r.pre;
      if (plain) {
        var lab = document.createElementNS(NS, 'tspan');
        lab.textContent = plain;
        tx.appendChild(lab);
      }
      var num = document.createElementNS(NS, 'tspan');
      num.setAttribute('font-weight', 'bold');
      num.textContent = r.num;
      tx.appendChild(num);
      if (r.post) {
        var tail = document.createElementNS(NS, 'tspan');
        tail.textContent = r.post;
        tx.appendChild(tail);
      }
      g.appendChild(tx);
    });
    svg.appendChild(g);
  }

  function showYear(containers, year) {
    clearCursors(containers);
    if (year == null) return;
    containers.forEach(function (c) {
      c.querySelectorAll('svg').forEach(function (svg) {
        svg.querySelectorAll('rect.rd-hot[data-axis="year"]').forEach(function (hot) {
          var xmin = +hot.getAttribute('data-xmin'), xmax = +hot.getAttribute('data-xmax');
          if (year >= xmin && year <= xmax) drawCursor(svg, hot, year);
        });
      });
    });
  }

  // Link a set of plot containers. Containers may be re-rendered freely; the
  // listeners are on the containers themselves.
  function linkYearHover(containers) {
    containers = (containers || []).filter(Boolean);
    containers.forEach(function (c) { c.__rdLinkGroup = containers; });
    containers.forEach(function (c) {
      if (c.__rdYearLinked) return;
      c.__rdYearLinked = true;
      c.addEventListener('mousemove', function (evt) {
        var t = evt.target;
        var hot = t && t.getAttribute && t.classList && t.classList.contains('rd-hot') ? t : null;
        if (!hot || hot.getAttribute('data-axis') !== 'year') { showYear(c.__rdLinkGroup, null); return; }
        var r = hot.getBoundingClientRect();
        if (!(r.width > 0)) return;
        var xmin = +hot.getAttribute('data-xmin'), xmax = +hot.getAttribute('data-xmax');
        var year = Math.round(xmin + (evt.clientX - r.left) / r.width * (xmax - xmin));
        showYear(c.__rdLinkGroup, year);
      });
      c.addEventListener('mouseleave', function () { showYear(c.__rdLinkGroup, null); });
    });
  }

  window.PlotLink = { linkYearHover: linkYearHover };
})();
