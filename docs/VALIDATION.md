# ringdater-js

A clean, dependency-free JavaScript port of the numeric core **and analysis
layer** that [dplR](https://github.com/OpenDendro/dplR) / RingdateR rely on for
crossdating. Every function is validated against the original R via `tools/*.R`
(R is the oracle: it sources ringdater's actual functions and dplR). Run all
suites with `npm test` (needs the userspace R/Node env; see WORKPLAN.md §2).

## Status: Phases 1–5 + 7 COMPLETE (Phase 6 frontend in progress)

`npm test` = 25 suites green. `src/index.js` exports 63 functions + the `Frame`
data-shape contract. The full headless pipeline (load → detrend → crossdate →
filter → align → chronology stats → downloads/report) runs in JS and is
validated end-to-end against R.

- **Phase 1** analysis layer · **Phase 2** IO/parsers · **Phase 3** orchestration
  engine (`pairwiseWorkflow`/`chronologyWorkflow`, both ≤1e-6 vs R) · **Phase 4**
  visualization (utils + 6 SVG plot builders) · **Phase 5** downloads + HTML
  report · **Phase 7** chrono_checker second app + `dplR::chron`.
- **Phase 6** main web frontend — in progress (functional build, not R-parity).

See the per-layer parity tables below and `WORKPLAN.md` for the full plan.

## dplR numeric core

| Function | Original | Parity vs R | Notes |
|----------|----------|-------------|-------|
| `caps(y, nyrs, f)` | dplR `caps`/`ffcsaps` (Fortran) | **bit-exact (0.0)** | Cook/Holmes cubic smoothing spline; deterministic banded solve. |
| `detrendSpline(y, nyrs, f)` | dplR `detrend.series(method="Spline")` | **bit-exact (0.0)** | Includes dplR's undocumented zero→0.001 replacement. |
| `whitenSeries(y)` | ringdater `whitenSeries` (base `ar`) | **bit-exact (~1e-15)** | AR(1) Yule-Walker prewhitening. |
| `modNegExp(y)` | dplR `detrend.series(method="ModNegExp")` | **~1e-5 when nls converges** | Line/mean fallback matched. |
| `modHugershoff(y)` | dplR `detrend.series(method="ModHugershoff")` | **~1e-5 when nls converges** | See parity boundary below. |
| `supsmu(y)` / `friedman(y)` | dplR `detrend.series(method="Friedman")` (`stats::supsmu`, Fortran) | **bit-close (~1e-9)** | Full cross-validated variable-span super smoother; includes zero→0.001 preprocessing. |
| `rwiStatsRunning` / `rBarEps` | dplR `rwi.stats.running` | **matches R's 3-dp-rounded output (~5e-4)** | Underlying calc is ~1 ULP vs *unrounded* R, but `R_bar_EPS` rounds to 3 decimals, so that's the asserted parity. Pearson + running-window regime. |
| `corrRwlSeg` | dplR `corr.rwl.seg` | **bit-close (~1e-16); flags exact** | Segment-correlation crossdate flags (`prob_check`). Spearman, biweight master, full AR-order prewhitening. |

**Parity boundary — iterative fits.** The deterministic kernels (spline, AR)
reproduce R bit-for-bit. The nonlinear least-squares fits (`modNegExp`,
`modHugershoff`) match R closely *when both converge*, but R's `nls` is fragile:
it aborts on "iterations exceeded 50" or "infinity produced" and falls back to a
linear/mean curve. Our Gauss-Newton solver is more robust and sometimes converges
where R bailed, producing a different (arguably better) curve. These rare cases
are surfaced as `PATH-DIFF` in the test, not hidden. Exact parity here would
require reproducing R's `nls` iteration path and its failure modes verbatim.

## Phase 1 — analysis layer (ringdater's own crossdating logic)

All validated against R (sourcing the actual ringdater functions).

| Function(s) | Original | Parity vs R |
|---|---|---|
| `Frame` + `combNA` (`analysis/comb.js`) | ringdater data.frame idiom + `comb.NA` | **exact** — the shared ragged-table contract |
| `pearsonCorTest` (`stats/cortest.js`) | base `cor.test` (pearson) | **~1e-14** (r/t/p) |
| `normalise` | ringdater `normalise` (all 7 detrend methods + AR/log) | **~1e-14** deterministic methods; nls methods within tol (documented PATH-DIFFs) |
| `detcurves` | ringdater `detcurves` | **bit-close**; nls PATH-DIFFs on methods 4/6 |
| `rollcor`, `autoCorrel` | ringdater `rollcor`, `auto_correl` | **~1e-15** |
| `leadLag` | ringdater `lead_lag_analysis` (**the crossdating engine**) | `crossDatRes` **exact**, `masterLeadLag` **~1e-12** |
| `runningLeadLag`, `heatmapAnalysis` | ringdater `running_lead_lag`, `heatmap_analysis` | **~1e-15** |
| `filterCrossdates` | ringdater `filter_crossdates` | **exact** |
| `alignSeries`, `alignToChron`, `ontoAlignDated` | ringdater `align_*` | **bit-exact (0.0)** |
| `correlReplace`, `removeSeries` | ringdater `correl_replace`, `remove_series` | **~1e-13 / exact** |
| `probCheck`, `rBarEps` | ringdater `prob_check`, `R_bar_EPS` | **flags exact / rounded-value exact** |
| `nameCheck`, `loadedDataCheck`, `pairwiseDataCheck` | ringdater validators | **exact** (incl. `make.names`/`make.unique` edge cases) |
| `RingdateR_error_message` | ringdater error placeholder | **exact** messages |

## Phase 2 — IO (parsers, loaders, writers) COMPLETE

All validated against R (dplR loaders / `read.rwl`/`write.rwl`; `.pos`/`.lps`/RM
against ringdater's own R loaders on synthesized fixtures).

| Function(s) | Original | Parity |
|---|---|---|
| `parseDelimited` (CSV/TXT), `readXlsx` | `read.csv`/`readxl` + ringdater loaders | **exact** (XLSX byte-identical; Node `zlib` inflate, browser needs pako/SheetJS) |
| `loadUndated`/`loadChron`/`loadDataTabs`/`ldUndatedChron` | ringdater loaders (extension dispatch) | **exact** (12/12) |
| `readRWL`, `writeRwl` | dplR `read.rwl`/`write.rwl` (Tucson) + ringdater wrapper | **exact** read; **byte-exact** write; header-fallback matched |
| `loadPos` | ringdater `load_pos` (`.pos` geometry) | **bit-exact** (5 fixtures); `distGap` bug reproduced |
| `loadLps` | ringdater `load_lps` (`.lps` XML) | **bit-exact** (6 fixtures) |
| `loadRingMeasurer`, `combineRMFiles` | ringdater Ring Measurer | **exact** (11/11) |
| `writeCsv` | download handler | CSV serialization |

## Phase 4 (partial) — viz utilities COMPLETE

`xScaleBar`/`yScaleBar` **exact** (464 cases), `colPal` ramps **exact**, `rDateRTheme` config mapped.

## Phase 3 — orchestration engine COMPLETE

`pairwiseWorkflow` / `chronologyWorkflow` (pure headless pipelines) + `createStore`
+ `engineActions` mirror RingServer's reactive graph. End-to-end vs R: detrended
frame ~1e-15, `cross_dat_res` ~1e-11, filtered/flags/selections **exact**, aligned
chronology ~1e-15, Rbar/EPS exact.

## Phase 5 — downloads + report COMPLETE

`buildDownloads(results,{date})` → `{filename,mime,content}` for every CSV/RWL/SVG
artifact (CSV byte-equal to `writeCsv`, RWL round-trips); `renderReport(state)` →
self-contained HTML run-log. Plots emit SVG (browser rasterizes to PNG via canvas).

## Phase 7 — chrono_checker COMPLETE

`chronoCheck({frame,selected,lag,splinewindow})` (the Quick Chronology Checker) +
`chron()` (dplR chronology: `std` ~1e-15, `samp.depth` exact). The `chronoCheck`
engine remains exported and validated; its standalone `web/chrono_checker.html`
page was retired in the V0.2 UX pass — its "one sample vs. a chronology" function
is now a subset of the main app's Explore workspace (chronology mode).

## Phase 6 — main frontend (in progress)
Functional web app wiring the engine, plots, and downloads. Not R-parity (it
replaces the Shiny UI).
- **Phase 5** — Downloads & HTML report.
- **Phase 6** — Frontend shell. **Phase 7** — chrono_checker second app + `dplR::chron`.
- Detrending modes ringdater doesn't use (`Mean`, `Ar`, `AgeDepSpline`) — trivial extensions.

## Layout
```
src/   spline.js  prewhiten.js  ar.js  nls.js  curvefit.js  supsmu.js
       rwi_stats.js  corr_rwl_seg.js  index.js
test/  run.js (spline+prewhiten+curvefit+friedman)  rwi_test.js  corr_test.js  *_gt.json
tools/ ground_truth.R  rwi_ground_truth.R  corr_ground_truth.R  rsrc/ (deparsed R + Fortran)
```

## Run tests
```
node test/run.js
```
Regenerate ground truth (needs R + dplR): `Rscript tools/ground_truth.R`.
