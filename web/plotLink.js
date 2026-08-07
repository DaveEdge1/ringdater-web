'use strict';
// plotLink.js — linked year-hover across plots. Panels whose builder declares
// linkAxis:'year' carry an invisible <rect class="rd-hot" data-xmin data-xmax>
// over their plot area (see src/viz/render.js). Hovering any linked plot maps
// the cursor to a (rounded) year and draws a shared cursor line + year label in
// EVERY linked panel whose x-domain contains that year — so a year on the line
// plot lights up the matching year on each skeleton-plot row, and vice versa.
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
    var t = document.createElementNS(NS, 'text');
    // keep the label inside the panel: flip to the left of the line near the right edge
    var flip = px > x + w - 40;
    t.setAttribute('x', flip ? px - 4 : px + 4);
    t.setAttribute('y', y + 11);
    t.setAttribute('font-size', '10'); t.setAttribute('font-family', 'sans-serif');
    t.setAttribute('fill', '#b06f00');
    if (flip) t.setAttribute('text-anchor', 'end');
    t.textContent = String(year);
    g.appendChild(t);
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
