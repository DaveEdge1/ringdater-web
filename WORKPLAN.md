# RingdateR → JavaScript — Comprehensive Work Plan

**Audience:** Opus agents executing the port. Every task below is written to be
picked up independently. Read sections 0–4 **and the revisions block below** once
before starting any task; they contain the environment, conventions, and
hard-won gotchas that will otherwise cost you hours.

---

## STATUS: ALL PHASES COMPLETE ✅

Phases 1–7 are built, integrated, and validated. `npm test` = 26 suites green;
`src/index.js` exports 63 functions + the Frame contract; the browser app runs
end-to-end (`node web/serve.js`). See `README.md` for the per-layer parity
tables. The sections below are the original plan, retained for reference.

- **Phase 1** analysis layer — R-parity (bit-exact/bit-close; nls PATH-DIFFs documented)
- **Phase 2** IO/parsers — R-parity (RWL/.pos/.lps/CSV/XLSX/RingMeasurer)
- **Phase 3** engine — end-to-end vs R ≤1e-6
- **Phase 4** viz — utils R-exact; 6 SVG plot builders (data validated vs R)
- **Phase 5** downloads + HTML report
- **Phase 6** main web frontend (`web/index.html`)
- **Phase 7** chrono_checker second app + `dplR::chron`

---

## Revisions after independent review — READ FIRST

An independent review (which ran the test suite and audited the R server)
corrected the following. These override anything later in the document.

**Product decisions:**
- **D1 — Tucson/RWL scope: RESOLVED → INCLUDE.** `readRWL_functions.R` and the RWL
  download delegate to `dplR::read.rwl` / `dplR::write.rwl` (unported). Ported as
  first-class task **T2.7** (see below). Scope: **Tucson decadal `.rwl` read + write
  first** (the standard interchange format); `.crn`/`.rwm`/TRIDAS `.xml`/Heidelberg
  `.fh` are stretch extensions, not MVP. T2.2 becomes the ringdater *wrapper*
  (`readRWL`/`readWOheader`/`locateID` header-inference fallback) that sits on top
  of T2.7.
- **D2 — `chrono_checker_app.R` (second Shiny app, 167 lines): RESOLVED → INCLUDE
  in a later phase (Phase 7).** A small standalone "Quick Chronology Checker":
  CSV-only, load a chronology → pick one sample → spline-detrend → apply a manual
  lag → view a combined line/heatmap/bar plot of how it fits the mean of the other
  samples. It **reuses functions already in scope** (`normalise`, `lead_lag_analysis`,
  `heatmap_analysis`, `line_plot`, `lead_lag_bar`) plus `dplR::chron`, so it is
  mostly a thin UI once the engine + viz exist. Scheduled **after** the main app
  (Phase 6) as **T7.1** so it can lean on finished pieces. Adds `dplR::chron()` as a
  small dependency task (**T7.0**, not in DONE).

**Corrected parity claims (the code is fine; the labels were overstated):**
- `rwiStatsRunning`/`rBarEps`: the committed test compares against R's
  **3-decimal-rounded** output (`R_bar_EPS` passes `round.decimals=3`), so parity
  is **~5e-4, and the JS must replicate that rounding**. The "~1 ULP" figure was
  measured against *unrounded* R and is not what the shipped test asserts. Spline
  (`0.0`), whiten (`~2.7e-15`), Friedman (`~1e-9`), and `corrRwlSeg` (`~1e-16`,
  flags exact) claims all verified and stand.
- The `nls` PATH-DIFF is **not rare**: 1 of 6 ModNegExp/ModHugershoff cases on
  plain ca533 diverges (~17%). `normalise` applies the chosen method to every
  series, so with method 4/6 this propagates downstream. Treat as a first-class
  acceptance issue, not an edge case.

**Corrected acceptance bar (replaces §8's blanket "≤1e-6"):** make it
**method-conditional** — Spline/Friedman/z-score/none/first-difference → ≤1e-6;
ModNegExp/ModHugershoff → tolerance + documented PATH-DIFF. Compare the Rbar/EPS
table against R's **rounded** output. The E2E harness drives the **exported R
functions via `Rscript`** (the roxygen examples give the exact pipeline), NOT the
interactive Shiny app, which can't run headlessly.

**Must decide before Wave A — the shared ragged-table contract.** `comb.NA` (T1.1)
produces ragged, unequal-length column tables, and `master_lead_lag` /
`cross_dat_res` (`lead_lag_analysis_function.R:193,205-222`) are ragged tables,
**not** clean `{years, series}` grids. `normalise`(T1.3), `lead_lag_analysis`(T1.5),
and `align_series`(T1.8) all consume/produce these. Pick ONE representation for
ragged tables up front (documented in `src/analysis/comb.js`) or parallel agents
will each invent an incompatible one and collide at integration. **`comb.NA`(T1.1)
is a hard prerequisite of T1.3/T1.5/T1.8, not a peer.**

**Added tasks (were omitted):**
- **T1.12 `RingdateR_error_message`** — the most-invoked ringdater function in the
  server (13 calls; `RingdateR_error_message_function.R`). Renders error text in
  place of a plot/output when data is missing. In JS: an error-display contract
  every output path checks. Effort 0.5d.
- **T2.7 (FIRM per D1)** — port `dplR::read.rwl` + `write.rwl`, **Tucson decadal
  format first** (fixed-width, header + decadal rows; writer must detect
  units/precision: mm / 0.01 / 0.001, matching `write.rwl`). Validate against
  `dplR::read.rwl`/`write.rwl` round-trips on `ca533`. Other formats are stretch.
  Effort 4–6d. T2.2 (the ringdater fallback wrapper) depends on this.
- **T7.0 / T7.1 (FIRM per D2, Phase 7 — after Phase 6)** — port `dplR::chron`
  (chronology mean/robust mean, ~1d) then the chrono_checker "Quick Chronology
  Checker" second app: CSV load, sample-select summary table, spline detrend,
  manual-lag combined line/heatmap/bar plot, plot download. Reuses the engine and
  viz from Phases 1–4; mostly UI. Effort 3–4d total.

**Test coverage requirement (all tasks):** ground truth must include, beyond
`ca533`, at least one second dataset and explicit edge cases: zero-variance/all-equal
series (`cor.test`→NaN, reachable once overlap ≥ `N_limit=5`), NA-heavy/short series
at the `N_limit` boundary, negative values + the `logT` branch
(`normalise_function.R:78-83`), and the first-difference trailing-NA quirk (`:66-72`).
Note: `co021` was named in §3 but never actually used — use it or another real rwl.

**Effort re-estimate:** T3.2 (3,084-line reactive server → state machine) is the
true schedule risk, not T1.5 — budget **8–10d, not 4d** (68 observers with Shiny's
invalidation/laziness/ordering semantics). Under D1(a), Phase 2 grows by 4–6d. The
overall total is optimistic; see revised summary note in §11.

---

## 0. Goal & scope

Reimplement the RingdateR crossdating application as a dependency-free
JavaScript library so it runs in the browser (or Node) with no R server.

**Already done** (see `README.md`): the dplR numeric core — 10 functions,
validated bit-for-bit or to a stated tolerance against R. Do **not** re-port these:

| Module | Provides | Parity |
|---|---|---|
| `src/spline.js` | `caps`, `detrendSpline` | bit-exact |
| `src/prewhiten.js` | `whitenSeries` (AR1), `scale`, `arYW1` | bit-exact |
| `src/ar.js` | full `ar()` Yule-Walker + AIC order selection | bit-exact |
| `src/nls.js` | `gaussNewton` generic NLS | — |
| `src/curvefit.js` | `modNegExp`, `modHugershoff` | ~1e-5 (tolerance) |
| `src/supsmu.js` | `supsmu`, `friedman` | bit-close ~1e-9 |
| `src/rwi_stats.js` | `rwiStatsRunning`, `rBarEps` | bit-close ~1 ULP |
| `src/corr_rwl_seg.js` | `corrRwlSeg` (+ `tbrm`, `prho`, `pt`/`pnorm` helpers) | bit-close ~1e-16, flags exact |

**This plan covers the remainder**: ringdater's own analysis functions, the
file parsers (up/download), the orchestration/state engine (the "server"),
visualization, and the frontend.

**Strategic note (decide before Phase 6):** if the only goal is "RingdateR on a
website," a `shinylive`/`webR` build could run the *existing* Shiny app
client-side in days. This full rewrite only wins if you want a lightweight,
R-free, more-interactive product. Spend one day confirming `dplR` compiles to
WASM before committing to Phases 4–6.

---

## 1. Repository map

- Original R package: `../ringdater_pkg/` (relative to `ringdater-js/`).
  - `R/*_function.R` — one function per file; **read the source for the task you own**.
  - `R/RingServer_function.R` (3,084 lines) — the Shiny server (state graph + outputs + 16 downloads).
  - `R/ui_function.R` (416 lines) — the dashboard UI.
  - `inst/report.Rmd`, `inst/chron_report.Rmd` — downloadable HTML reports.
- JS library under construction: `ringdater-js/` (this directory).
- Deparsed R + Fortran reference source: `ringdater-js/tools/rsrc/`.

---

## 2. Environment & tooling — CRITICAL, read first

There is **no sudo, no system R, no system Node**. A userspace toolchain was
bootstrapped with micromamba. Use it for everything.

```bash
# From the scratchpad root. cwd resets between shell calls, so do this every time.
cd <scratchpad-root>                 # the dir containing ringdater-js/, ringdater_pkg/, env/, mamba/, bin/
export MAMBA_ROOT_PREFIX=$PWD/mamba
RUN="./bin/micromamba run -p $PWD/env"

$RUN Rscript path/to/script.R        # R 4.5 with dplR 1.7.9 installed
$RUN Rscript -e 'suppressMessages(library(dplR)); ...'
$RUN node path/to/file.js            # Node v26
```

Gotchas:
- **cwd resets between Bash calls** — always re-`cd` + `export`, and use
  **absolute paths inside R/JS scripts** (relative paths resolve unpredictably).
- Files written by an R script land in the *process* cwd; write to absolute paths.
- If the env is missing (fresh machine), recreate it:
  `./bin/micromamba create -y -p ./env -c conda-forge r-base r-dplr nodejs`
  (micromamba binary bootstrap: download from `https://micro.mamba.pm/api/micromamba/linux-64/latest`, `tar -xj bin/micromamba`).

---

## 3. Conventions — MUST follow

**R is the oracle.** No function is "done" until a JS test matches R-generated
ground truth. The methodology, reused from the completed core:

1. Write `tools/<name>_ground_truth.R` that `source()`s the *actual ringdater
   function* (from `../ringdater_pkg/R/...`) and/or calls dplR, runs it on real
   data (`data(ca533)` — a real bristlecone rwl; also `co021`), and emits JSON
   with `format(x, digits=17)` for every number (write a tiny JSON serializer in
   R — do **not** add R packages).
2. Write the JS module in `src/`.
3. Write `test/<name>_test.js` that loads the JSON, runs the JS, prints a
   per-case table of max-abs-diff, and exits non-zero on failure.
4. Iterate against R until parity. Add the test to the `npm test` chain in
   `package.json`.

**Data shapes** (keep consistent across the library):
- A single series: a plain `number[]`; missing values are `null`/`NaN`.
- A multi-series ring-width table (`rwl`): `{ years: number[], series: { [id]: (number|null)[] } }`,
  every series array aligned to `years` (contiguous, step 1). This is what
  `rwiStatsRunning`/`corrRwlSeg` already expect — reuse it.
- ringdater's R passes "data.frames" whose **first column is years/increment
  number** and remaining columns are series. When porting, translate that to the
  `rwl` shape above; don't emulate R data.frames.

**Code style:** CommonJS (`'use strict'`, `require`/`module.exports`), small pure
helpers, 1-based index emulation only when mirroring Fortran (see `spline.js`,
`supsmu.js`). Comment only what the code can't show. Match `src/prewhiten.js`.

**Parity philosophy:** deterministic algorithms (linear algebra, recurrences,
correlations, sorting) → aim **bit-exact/bit-close** (≤1e-9). Iterative
optimizers (`nls`) → tolerance parity when they converge; document divergences
rather than hiding them (see the `PATH-DIFF` mechanism in `test/run.js`).

---

## 4. Known gotchas (discovered — do not rediscover)

1. **Zero replacement.** `dplR::detrend.series` silently replaces zeros in the
   series with **0.001** before Spline *and* Friedman fitting (and reports
   `n.zeros = 0` afterward). Both `detrendSpline` and `friedman` already do this;
   `normalise` must feed the same preprocessed series. Missed → ~1e-4 error only
   near zeros.
2. **`nls` fragility.** R's `nls` (default Gauss-Newton, maxiter 50) aborts on
   "iterations exceeded" or "infinity produced" and `detrend.series` falls back
   to a linear/mean curve. A robust JS solver converges where R bailed → a
   *different* curve. This is the one real parity boundary; surface it, don't fight it.
3. **`ar()` order selection.** `corr.rwl.seg`/`rwi.stats.running` prewhiten with
   full `ar()` + AIC order choice, **not** AR(1). Use `src/ar.js`, not `whitenSeries`.
4. **`match.arg` picks the first.** `corr.rwl.seg(method=c("spearman","pearson","kendall"))`
   uses **spearman**. When ringdater passes a vector of choices, R takes `[1]`.
5. **Fortran/literal constants matter.** Bit-exact ports copy the exact literal
   constants (e.g. `pi = 3.1415926535897935`, spans `0.05/0.2/0.5`, `eps=1e-3`).
6. **Bonferroni-style correction.** `lead_lag_analysis` multiplies the cor.test
   p-value by the number of lags tested (`p_val * correction`). Preserve it.
7. **Ground-truth precision.** Always `format(x, digits=17)`; anything less and
   "bit-exact" claims are untestable.

---

## 5. Target module layout (extends current `ringdater-js/src/`)

```
src/
  spline.js prewhiten.js ar.js nls.js curvefit.js supsmu.js   [DONE]
  rwi_stats.js corr_rwl_seg.js                                 [DONE]
  detrend/    normalise.js  detcurves.js
  analysis/   comb.js  autoCorrel.js  rollcor.js  leadLag.js
              runningLeadLag.js  heatmap.js  filterCrossdates.js
              align.js  correlReplace.js  removeSeries.js
  stats/      probCheck.js  rBarEps.js        (wrap DONE modules)
  io/         csv.js  xlsx.js  rwl.js  pos.js  lps.js  ringMeasurer.js  load.js
  viz/        chartUtils.js  linePlot.js  datedLinePlot.js  allSeries.js
              heatmapPlot.js  detrendPlot.js  leadLagBar.js
  engine/     store.js  actions.js  workflows.js
  index.js
```

---

## 6. The state model (the "server")

`RingServer_function.R` is mostly Shiny plumbing over 13 reactive state
containers and a graph of `observeEvent`/`observe` transforms. Port it as a plain
store (`engine/store.js`) with explicit actions (`engine/actions.js`). State:

```
raw:       undated, chrono                     loaded series (rwl shape)
detrended: detrended_undated, chron_detrended  after normalise
combined:  chron_n_undated                     chronology mean + undated, joined on year
analysis:  master_lead_lag, pairwise_res        crossdate results
aligned:   quick_chron_aligned, final_chron_aligned, chron_aligned_undet
meta:      error_log, loading, chron_loading    upload staging + messages
```

Transform chain (two modes: **pairwise** and **chronology**):
`load → validate/clean → normalise → leadLag → filterCrossdates → align → chronology stats`.

Downloads (16 handlers): CSV (raw, detrended, results, aligned chronology), RWL,
PNG plots, HTML report.

---

## 7. Work breakdown

Each task: **Source** (R file to read) · **Depends** · **Spec** · **Validate** ·
**Effort** · **Gotchas**. Effort assumes one agent; "d" = ideal engineer-days.

### Phase 1 — Analysis core (ringdater's own functions)

> All pure transforms. Parity target bit-close unless noted. Validate each by
> `source()`ing the R function and diffing on `ca533`-derived inputs.

**T1.1 `comb.js` — dataframe join helpers.** Source: `R/comb_NA_function.R`
(`comb.NA`, `vertLen`). Spec: combine vectors/tables of unequal length by
NA-padding to the max length; used pervasively downstream. Represent as
column-wise arrays. Validate: replicate `comb.NA` on a few ragged inputs. Effort: 0.5d.

**T1.2 `rollcor.js` + `autoCorrel.js`.** Source: `R/rollcor_function.R`,
`R/auto_correl_function.R`. Spec: `rollcor(x,y,width)` = running Pearson r over a
sliding odd window; `auto_correl` = lag 0–10 autocorrelation table. Validate vs R.
Effort: 0.5d.

**T1.3 `normalise.js` — the detrending dispatcher.** Source:
`R/normalise_function.R` (read carefully). Spec: for each series apply
`detrending_select` ∈ {1 none, 2 z-score, 3 Spline, 4 ModNegExp, 5 Friedman,
6 ModHugershoff, 7 first-difference}; then optional AR prewhiten (`whitenSeries`),
optional log transform (`A + (|min|+1)*7/6` then `log`), and for methods >1 a
final `scale(A)+1`. Reuse `detrendSpline`/`curvefit`/`friedman`/`whitenSeries`.
Validate: `source()` ringdater `normalise` + deps, diff full output for every
method on `undated`-style data. **Gotchas:** zero→0.001 (via detrendSpline/friedman
already); the ratio detrending (`y/curve`) vs z-score branches; NA handling in
first-difference. Effort: 1.5d.

**T1.4 `detcurves.js`.** Source: `R/detcurves_function.R`. Spec: returns the
fitted detrending *curves* (for plotting), parallel to `normalise`. Reuse the
`.curve` outputs already returned by the fitters. Validate vs R. Effort: 0.5d.

**T1.5 `leadLag.js` — the crossdating engine (CORE).** Source:
`R/lead_lag_analysis_function.R` (247 lines, nested loops). Spec: for every pair
of series (pairwise mode) or each series vs a master (chronology mode), slide one
series across lags `[neg_lag, pos_lag]` (or the full overlap when `complete`),
compute Pearson `cor.test` (r, t, p) on the overlap, apply `p_val * correction`
(number of lags), and emit two tables: `cross_dat_res` (best-3 matches per
series) and `master_lead_lag` (full lag×pair r/p grid). Needs a Pearson
`cor.test`: r, `t = r*sqrt((n-2)/(1-r^2))`, two-sided p via `pt` (already in
`corr_rwl_seg.js` — reuse or extract to a shared `stats/tdist.js`). Validate:
`source()` ringdater `lead_lag_analysis` on a small multi-series set, diff both
tables (r/p to ~1e-10, and the best-match ordering exactly). **Gotchas:** the
`N_limit=5` minimum overlap; the `correction` multiplier; ordering ties; the
table column layout. Effort: 3d. **Highest-value task.**

**T1.6 `runningLeadLag.js` + `heatmap.js`.** Source:
`R/running_lead_lag_function.R`, `R/heatmap_analysis_function.R`. Spec:
per-lag running correlation (uses `rollcor` + a `rollmean` of years) producing
the year×lag×r long table that drives the heatmaps. Validate vs R. **Gotcha:**
window must be odd (auto +1); `zoo::rollmean` semantics. Effort: 1.5d.

**T1.7 `filterCrossdates.js`.** Source: `R/filter_crossdates_function.R`. Spec:
filter the `cross_dat_res` table by r/p/overlap thresholds against a target
series. Pure. Validate vs R. Effort: 0.5d.

**T1.8 `align.js` — `align_series`, `align_to_chron`, `onto_align_dated`.**
Source: `R/align_series_function.R`, `R/align_to_chron_function.R`,
`R/onto_align_dated_function.R`. Spec: given filtered crossdates + a target,
shift each series by its best lag and join into an aligned chronology on a common
year axis. Validate vs R on a known crossdating set. **Gotcha:** year-offset
bookkeeping and the `comb.NA` joins. Effort: 2d.

**T1.9 `correlReplace.js` + `removeSeries.js`.** Source:
`R/correl_replace_function.R`, `R/remove_series_function.R`. Spec: small table
edits (replace a series' correlation row; drop a series). Validate vs R. Effort: 0.5d.

**T1.10 `probCheck.js` + `rBarEps.js` (wrappers).** Source:
`R/prob_check_function.R`, `R/R_bar_EPS_function.R`. Spec: thin adapters mapping
ringdater's call into the already-ported `corrRwlSeg`/`rwiStatsRunning` and
reshaping outputs (flagged intervals; the `mid.year/n.trees/n/rbar/eps` table).
Validate vs R end-to-end. Effort: 0.5d.

**T1.11 Validation/cleaning: `nameCheck`, `loadedDataCheck`, `pairwiseDataCheck`.**
Source: `R/name_check_function.R`, `R/loaded_data_check_function.R`,
`R/pairwise_data_check_function.R`. Spec: dedupe/sanitize series names, validate
column structure, check sufficiency for pairwise analysis; produce the
`error_log` messages. Validate vs R. Effort: 1d.

*Phase 1 total ≈ 12–13d. T1.1–T1.4, T1.7, T1.9–T1.11 are independent and
parallelizable; T1.5 gates T1.6/T1.7/T1.8.*

### Phase 2 — IO / parsers (independent of Phase 1)

**T2.1 `csv.js` / `xlsx.js`.** Source: `R/load_undated_function.R`,
`R/load_chron_function.R`, `R/load_data_tabs_function.R`. Spec: parse CSV/TXT
(delimiter + header sniffing) and XLSX (use SheetJS) into the `rwl` shape.
Validate: compare parsed values to R's `read.csv`/`readxl` on the same files.
Effort: 1.5d.

**T2.2 `rwl.js` — Tucson read + write.** Source: `R/readRWL_functions.R`
(`readRWL`, `readWOheader`, `locateID`). Spec: parse fixed-width Tucson `.rwl`
(header + decadal rows), including the fallback that infers sample-ID length by
statistical mode; and write Tucson. Validate against `dplR::read.rwl` /
`write.rwl`. **Gotcha:** the stateful header-inference fallback. Effort: 3d.

**T2.3 `pos.js` — Image-Pro `.pos`.** Source: `R/load_pos_function.R`. Spec:
stateful coordinate parser — walk measurement points, track gap/lateral-jump
markers, compute Euclidean ring widths, subtract gaps, reverse order. Validate vs
R on sample `.pos` files (generate/borrow fixtures). **Gotcha:** the undefined
`distGap`-on-first-use bug in R — decide to fix, and document. Hardest parser.
Effort: 2.5d.

**T2.4 `lps.js` — Image-Pro `.lps` (XML).** Source: `R/load_lps_function.R`.
Spec: nested XML traversal (`fast-xml-parser` or DOMParser), sort per-line
positions, diff to ring widths. Validate vs R. Effort: 1d.

**T2.5 `ringMeasurer.js` + combine.** Source: `R/load_ring_measurer_fun.R`,
`R/combine_RM_files_function.R`. Spec: detect Ring Measurer CSV columns, reshape
`abs_distance` into series, average replicate series, batch-combine files.
Validate vs R. Effort: 1.5d.

**T2.6 `load.js` — dispatcher + writers.** Source: `R/load_undated_function.R`,
`R/ld_undated_chron_function.R`, `R/align_undaed_load_function.R`. Spec:
extension-based dispatch to the readers above; CSV/RWL writers for downloads.
**Gotcha:** R keys on the last 3 chars (`.xlsx`→`lsx`) and has a dead `pos`
branch. Effort: 1d.

*Phase 2 total ≈ 10–11d. All tasks independent except T2.6 depends on the readers.*

### Phase 3 — Engine / orchestration (needs Phases 1–2)

**T3.1 `store.js`.** Framework-agnostic state container matching section 6; plain
object + subscribe, no React/Shiny assumptions. Effort: 1d.

**T3.2 `actions.js` + `workflows.js`.** Port the `observeEvent`/`observe` graph in
`RingServer_function.R` as explicit actions (load, validate, detrend, analyze,
filter, align, stats) and the two workflow orchestrations (pairwise, chronology).
Read the server to recover the dependency order; ignore all Shiny UI wiring.
Validate: end-to-end (section 8). Effort: 4d.

### Phase 4 — Visualization (needs Phase 1 data shapes)

**T4.1 `chartUtils.js`.** Source: `R/col_pal_function.R`, `R/x_scale_bar_function.R`,
`R/y_scale_bar_function.R`, `R/R_dateR_theme_function.R`. Spec: the 4 heatmap
color ramps (copy exact stops), the bucketed axis-tick generators, the shared
theme. Effort: 1d.

**T4.2 Plot builders.** Source: `R/line_plot_function.R`,
`R/dated_line_plot_function.R`, `R/plot_all_series_function.R`,
`R/plotting_sing_hm_function.R`, `R/detrending_plot_function.R`,
`R/lead_lag_bar_function.R`. Spec: reimplement 6 plots with Plotly.js / Observable
Plot / D3 (all currently static ggplot). Preserve color conventions (black=series1/raw,
red=series2/mean/detrended, red/blue/green=top-3 matches). Add drag-to-lag + hover.
Effort: 6–8d.

### Phase 5 — Downloads & report (needs 1, 2, 4)

**T5.1 Downloads.** 16 handlers → client-side blobs: CSV (raw/detrended/results/
aligned), RWL (via T2.6 writer), PNG (canvas from T4). Source: search
`downloadHandler` in `RingServer_function.R`. Effort: 2d.

**T5.2 HTML report.** Source: `inst/report.Rmd`, `inst/chron_report.Rmd`. Spec:
generate the run-log HTML client-side from engine state. Effort: 1.5d.

### Phase 6 — Frontend shell (needs all)

**T6.1 UI.** Source: `R/ui_function.R`, `www/style.css`. Replace `shinydashboard`
with a modern frontend (React/Svelte/vanilla), wire controls to the engine
actions, implement file up/download UX and the tabbed pairwise/chronology flows.
Effort: 15–20d depending on polish.

---

## 8. Validation & acceptance (global)

- **Per function:** a `test/*_test.js` in the `npm test` chain, green, with the
  parity target from section 3 met and any `PATH-DIFF` documented.
- **End-to-end:** run a known dataset through **both** the R RingdateR app and the
  JS engine; diff (a) the crossdate results table, (b) the aligned chronology, (c)
  the Rbar/EPS table. Acceptance: numeric columns match to ≤1e-6, flag/selection
  sets match exactly. Build this harness in Phase 3.
- **Definition of done for the port:** the pairwise and chronology workflows
  reproduce the R app's outputs on the bundled example data, and every download
  produces a byte- or value-equivalent artifact.

---

## 9. Delegation guide (how to assign to agents)

- **Wave A (parallel now):** T1.1, T1.2, T1.3, T1.4 (analysis primitives) +
  T2.1, T2.2, T2.3, T2.4, T2.5 (all parsers). ~9 independent tasks.
- **Wave B:** T1.5 (crossdating engine — assign to a strong single agent; it
  gates much of Phase 1) alongside remaining independent Phase-1 tasks (T1.7,
  T1.9, T1.10, T1.11) and T2.6.
- **Wave C:** T1.6, T1.8 (depend on T1.5) + T4.1, T4.2 (viz, need Phase-1 shapes).
- **Wave D:** T3.1, T3.2 (engine) once 1+2 land.
- **Wave E:** T5, T6.

Each agent gets: this document, its task ID, and the instruction to follow
sections 2–4 exactly and only touch its own `src/`, `tools/`, and `test/` files
(never edit `src/index.js` or `test/run.js` — the integrator wires those). An
integrator agent updates `index.js`, the `npm test` chain, and the README after
each task passes.

---

## 10. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `nls` fallback boundary differs (T1.3/T1.5 use fits) | Med | Documented `PATH-DIFF`; matches when R converges. Acceptable for detrending. |
| `.pos`/RWL parser edge cases | Med | Validate against dplR on real fixtures; port the R quirks verbatim, then fix knowingly. |
| Pairwise O(n²) too slow for large sample sets | Med | Web Workers; the R app uses `doParallel` — mirror with a worker pool. |
| Exact `cor.test`/Spearman p at significance boundary | Low | `pt`/`prho` already validated to ~1e-16 in `corr_rwl_seg.js`; reuse. |
| dplR won't compile to WASM (kills the shinylive shortcut) | — | One-day spike before Phase 6 to keep the option open. |
| Scope creep in Phase 6 UI | High | Freeze feature parity to the current app; defer new UX. |

---

## 11. Effort summary

| Phase | Scope | Effort |
|---|---|---|
| 1 | Analysis core (ringdater's own functions) | 12–13d |
| 2 | IO / parsers | 10–11d |
| 3 | Engine / orchestration (**T3.2 re-est. 8–10d per review**) | 9–11d |
| 4 | Visualization | 7–9d |
| 5 | Downloads & report | 3.5d |
| 6 | Frontend shell | 15–20d |
| 2+ | RWL dplR port (T2.7, **firm per D1**) | 4–6d |
| 7 | chrono_checker second app + `dplR::chron` (T7.0/T7.1, **firm per D2**) | 3–4d |
| — | **Total** | **~67–83 engineer-days. RWL and chrono_checker both included. Revised up from 53–61 per review — RWL + reactive-graph were the underestimates.** |

The numeric foundation — usually the scariest part — is **already done and
bit-validated**. What remains is mostly mechanical R→JS porting (Phases 1–2,
heavily parallelizable), a small explicit state machine (Phase 3), and a
conventional frontend (Phases 4–6).
