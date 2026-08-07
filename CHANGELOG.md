# Changelog

All notable changes to ringdater-js (the library in `src/`) and the RingdateR
web app (`web/`) are documented here. The two share one version, taken from
`package.json` (see `tools/stamp-version.js`). The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/).

Release flow: `npm version patch|minor|major` — bumps `package.json`, stamps
`src/version.js` + `web/index.html`, rebuilds the ESM index and browser bundle,
runs the full test suite, and creates the release commit + `vX.Y.Z` git tag.
Then `git push --follow-tags`.

## [0.2.0] — 2026-08-07

### Added
- RWL loading: series with no sample ID in cols 1–8 are named after their file;
  loaders guarantee unique series names and report forced renames via a
  non-enumerable `warnings` array on the returned frame (surfaced in the UI).
- Public API additions: `nameCheckUnique`, `skelGrowth`, `VERSION`.
- Linked year-hover between the line plot and skeleton plot (Explore combined
  view and Build review), via year-tagged hover zones embedded in rendered SVGs.
- Per-view image saving: SVG/PNG buttons save all plots currently shown as one
  stacked composite image.
- Plot headers: one bold line naming the pair — the chronology labelled by its
  source file ("ut585 mean_chronology vs cmp523 — lagged 511 years") — plus a
  stats line for the chosen lag (First ring, Last ring, overlap, Pearson's r,
  p-value, Student's T). Both are part of saved images.
- Each plot is titled by its type: Detrended time series, Skeleton plot,
  Student's T test, Heat map.

### Changed
- Skeleton plots are computed from raw ring widths (dplR's contract), wrapped
  into decade-aligned 120-year rows, restricted to the pair's overlap ±10%, and
  density-matched between the two series with outlier-robust rank heights.
  `skelValues` itself remains dplR-exact.
- The Explore heat map's lag axis follows the UI-chosen lag (falling back to
  the best crossdate lag at lag 0, and to the chosen lag when a far-off best
  lag leaves too little overlap).

### Fixed
- Detrended (zero-crossing) input can no longer flip the skeleton narrowness
  sign (nonpositive hanning divisors are rejected).
- A single extreme relative-growth value no longer erases a long chronology's
  skeleton marks (observed: 1 mark in 1506 years on real data).

## [0.1.0]

Initial port: dplR numeric core (spline, detrending curve fits, supsmu,
prewhitening, rwi stats, corr.rwl.seg), ringdater crossdating analysis
(lead-lag, filtering, alignment), loaders/writers (CSV/TXT/XLSX/RWL/CRN/
.pos/.lps/Ring-Measurer/TRiDaS), chronology stats, plot builders + SVG
renderer, headless workflow engine, interactive chronology builder, and the
RingdateR web app — validated against R ground truth throughout.
