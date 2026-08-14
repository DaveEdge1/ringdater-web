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
- Explore: segment placement diagnosis — checkboxes on segment rows of the
  results table select several placements of one series against one reference
  (checking one auto-selects its siblings; Uncheck all clears the selection);
  Diagnose tabulates, per segment,
  the date each placement implies for ring 1 of the source series (best and
  2nd/3rd-best lags), the offset from the previous segment (the raw
  missing/false-ring count between neighbours), r/p/overlap, and the
  whole-series placement as a context row — plus a ring-vs-dated-position
  placement plot with the whole-series line as reference. Numbers only, no
  thresholds or verdicts. New `AppCore.diagnoseSegments`.
- Explore plots: "Review full series at this lag" — while a plotted series is
  a segment, one click swaps in its complete series at the offset-corrected
  lag, reproducing the segment's alignment over the whole series. New
  `AppCore.fullSeriesLag`.
- The frontend test suite no longer reads local sample-data files (ut585/);
  chronology-mode and composite tests build synthetic dated chronologies from
  the bundled example data.
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
- Home: "Load all series from a folder…" on the undated slot — a directory
  picker (recursive) that loads every readable data file it finds, names the
  pool after the folder, and reports how many non-data files were ignored.
- Explore: the 2nd- and 3rd-best lags in the results table are selectable —
  clicking a cell in the Sec/Third column groups plots the pair at that
  alternate lag (tooltip + hover affordance on those cells); clicking anywhere
  else in the row keeps the best lag. `AppUI.selectPair` takes an optional lag.
  Hovering previews the pick: on top of the green row highlight, the four
  cells of the lag group a click would select (best, 2nd or 3rd — including
  the fallback to best when an alternate lag is blank) light up in blue.
- Explore, chronology mode: **segment-consensus lag ranking**. Every
  chronology-mode run now also runs the sliding-window segmentation in the
  background (using the Segments length/keep settings; segLen 60 / keep 5 by
  default), projects each kept segment's best-3 placements onto the
  whole-series lag each implies, and clusters them by chained ±5-lag agreement
  — two or more independently well-dated segments (corrected p ≤ 0.05)
  agreeing on a placement is very unlikely by chance, and catches series whose
  missing/false rings dilute the full-series correlation at every lag. A
  STRONG consensus (≥3 segments, or ≥2 with min p ≤ 1E-6) that disagrees with
  the engine's best lag is promoted to 1st in the results (whole-series stats
  shown at that lag; the engine ranking shifts down) and the series joins the
  aligned output — and the report/exports — at the consensus lag, kept through
  the r/p filters the diluted whole-series stats would fail. A consensus
  matching the engine's lag is marked as confirmation; a 2-segment tentative
  one is flagged without re-ranking. Badges on the First-lag cells carry the
  evidence (segment count, min p) in their tooltips. The engine's own
  `crossDatRes` is never mutated — promotion happens on an app-layer copy, so
  the R-parity contract stands. New `AppCore.consensusFromRows`,
  `AppCore.statsAtLag`, `AppCore.CONSENSUS` (thresholds), a `consensus` option
  on `AppCore.refilter`, and a `consensus` block on mode-2 result bundles.

- Explore, missing / false ring test: iterative correction. A fruitful pass
  offers "Apply best edit & test again" (or apply the reviewed edit) and
  "Auto-iterate until clean" — each pass applies the correction to the raw
  series and re-tests it hunting the NEXT missing / false ring (ring numbers
  then refer to the corrected series; capped at 8 corrections). The applied
  corrections are summarised above the results, and the corrected series can
  be downloaded as .rwl at any point — both the cumulative iterated series and
  any single reviewed edit (relative ring axis 1..n). New runner API:
  `corrected(exp)`, `correctedDownload(exp)`, and a `seriesValues` option on
  `AppCore.ringTest` to test in-memory (already-corrected) values.
- Explore: a run-analysis progress overlay — the run is now a stepwise
  `AppCore.analysisRunner` (one engine workflow / runningLeadLag grid / segment
  crossdate per step, all four run shapes) driven through a timeout loop, so a
  centered floating card with a progress bar and step label ("Scanning
  segments of cmp504 (7/14)") paints over a dimmed page while long runs grind
  instead of freezing the UI. `runAnalysis` and `slidingSegmentAnalysis` are
  unchanged synchronous wrappers around it.

### Changed (UI layout)
- Explore rail: the Detrending and Segments sections moved into a collapsed
  "Additional settings" section (same controls and defaults; the guided tour
  opens it when it reaches the detrending step), leaving Data, Analysis mode,
  Lead/lag, Diagnostics and Run in the main rail. A new "Segment consensus"
  block there holds its own consensus segment length (years, default 60,
  forced odd) for the background pass of plain chronology runs; with the
  Segments tool enabled, consensus reads that run's segments and the tool's
  own length applies. New read-only `AppUI.result()` exposes the current run
  bundle for headless testing.

### Changed
- Explore, chronology mode: the displayed best-lag ranking is no longer always
  the engine's full-series p-value order — a strong segment consensus
  out-ranks it (see Added). Pairwise mode is unchanged.
- p-value display: Bonferroni-corrected p-values ≥ 1 now display as "1"
  (raw values are preserved in frames and CSV exports).

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
