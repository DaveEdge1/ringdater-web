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

## [Unreleased]

### Added
- Explore: sliding-window segmentation of undated series — EVERY possible
  segment (window of the chosen length, default 60 years) of each series is
  scored against the other complete series (pairwise mode) or the mean
  chronology (chronology mode) via runningLeadLag grids, and the best few
  non-overlapping windows per series (default 5, diversity-suppressed at 50%
  overlap) join the run as extra series named `series@a-b` (rings a–b).
  Segments never compare against other segments or their own source series;
  each kept segment heads its own block in the results table and is a valid
  filter target. Segments are windows of the DETRENDED whole series, so their
  scores match the selection grids. New `AppCore.slidingSegmentAnalysis`,
  `AppCore.slidingSelectPairwise`, `AppCore.slidingSelectVsReference`.
- Explore: missing / false ring test — a per-series diagnostic card that
  simulates every possible single-ring correction (each measured ring split in
  two; each neighbouring pair merged), re-detrends each edited series and
  re-runs the full lead-lag crossdate against a chosen reference (another
  complete series, a loaded chronology's mean, or the composite). Experiments
  that beat the unedited baseline (ΔT ≥ 1 with r above baseline) "bear fruit":
  they are ranked, highlighted, and summarised as a missing-/false-ring verdict
  with the implicated ring. Clicking a result row reviews that corrected
  series — the standard pair plots (zoomable line, skeleton, Student's T,
  heatmap) plus a stats line at its best lag, with a Plot-baseline button for
  side-by-side comparison against the unedited series. New `AppCore.ringTest`
  (batched stepwise runner with per-experiment `review`).
- Explore: multiple dated chronologies can be loaded (multi-select on Home, or
  Add chronology in the settings rail) and picked between via a new
  "Compare against" selector in chronology mode; each can be removed from the
  Data rail. With two or more loaded, the selector also offers the
  **chronology composite** — the mean of the detrended chronologies (each
  chronology's members are detrended with the current settings and averaged;
  the per-chronology means get equal weight). New
  `AppCore.compositeChron(chronList, detrend)` and a `chronIsDetrended` option
  on `chronologyWorkflow` that skips re-detrending such pre-detrended input.
- Public API addition: `meanChronology`.
- Explore: the crossdating results table is sortable by any column via ▲/▼
  arrows in the headers (ascending, descending, and back to the grouped
  best-3-blocks view; sorting hides the block header/separator rows and orders
  by raw values, blanks last). Row-click plotting keeps working while sorted.

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
