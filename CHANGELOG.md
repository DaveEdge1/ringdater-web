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
- **The composite target is measured before it is used.** Combining targets is the one
  place the app BUILDS a target rather than reading one, and so the one place it can be
  wrong without looking wrong: the mean of two uncorrelated targets is a smooth, plausible
  series made mostly of the noise they do not share, and the mean of two that are offset
  carries a dating error into every date taken from it — behind a tidy-looking series that
  gives no sign of it. Nothing stopped either combination, and nothing said so.

  A **Composite target** card now scores every ticked pair over the years it shares, as
  dated and at every lag within ±10 years: shared years, r and p as dated, the best lag and
  the r there, and a verdict — *agree* (r ≥ 0.35), *weak*, *no agreement* (r < 0.15),
  *opposed* (r ≤ −0.15, an index and its inverse?), *possible dating offset* (it agrees
  better at a lag, by ≥ 0.05 and reaching r ≥ 0.35), or *too little overlap* (< 30 years).
  An offset outranks a healthy correlation at lag 0, because that is precisely the case
  that looks fine and is not. Above the table: the mean inter-target correlation and the
  **EPS** it implies (n·r̄/(1+(n−1)·r̄), against the conventional 0.85), the years every
  member covers, and a sentence saying whether to go ahead. Below it: the members plotted
  together with their mean through them, zoomable.

  The same verdict rides beside **Compare against** and in the run message, so a composite
  that should not have been averaged cannot be used silently. It warns rather than blocks —
  untick the odd one out, or fix its dating, and run again. New `AppCore.compositeCheck`,
  `AppCore.compositePlot`, `AppCore.COMPOSITE_CHECK` (the thresholds, all stated in the UI).
- **Targets carry their own detrending, and several can be averaged into one.** What you
  crossdate against is not always a tree-ring chronology: a NADA PDSI grid point, a
  precipitation or temperature reconstruction is increasingly what people bring. Those have
  no growth trend to remove, and treating them like measurements is not a small error —
  fitting a curve to a reconstruction strips the low-frequency climate signal it was loaded
  for, and because spline/negexp/Hugershoff detrending is a **ratio**, a series that crosses
  zero is divided by a curve passing through zero and comes back as noise. On two real
  files (a Utah precipitation reconstruction and the NADA PDSI at 41.8N 111.2W, 2,006
  shared years) the pair correlates at **r = 0.58** rescaled and **r = 0.02** splined.

  So the method is now a property of each target rather than the pool's applied to
  everything. Every loaded target gets a card under **Data** — in the rail and in the Home
  setup step, wherever the file was chosen — carrying its span, a **detrending method**, and
  a tick for the composite. The app recommends a method and says why ("averages 18.3 — a
  ring-width series does not"; "looks like it is already an index (negative values)") but
  never decides: the numbers can only rule ring widths OUT, never in. "Raw" is deliberately
  not offered — every method on the list ends in z-scores + 1, so targets always plot and
  average on one scale.

  **Composite targets**: tick two or more and *Composite — mean of N ticked targets* appears
  in Compare against. Each member is detrended its own way, then they are merged on the
  union of their years and averaged, so a 2,000-year precipitation reconstruction and a
  PDSI grid point become a single target and years only one of them covers still count.
  The run message and the rail name what was used. New `AppCore.recommendTarget`,
  `AppCore.targetDetrend`, `AppCore.TARGET_METHODS`; `compositeChron` now honours each
  target's method. This replaces the "Detrend the chronology too" tick, which said the same
  thing for one chronology in a coarser way.
- **Files whose table does not start on line 1 now load.** NOAA / PReSto exports put
  provenance prose above the header — a dozen lines of "Dataset name:", "Notes:", `---` —
  and `read.csv` took the first of them as the header, leaving one nonsense column and no
  data. The csv loaders now find where the table actually starts: the first line that
  splits into the same number of fields as the numeric rows under it. A file whose table
  starts on line 1 is returned untouched, so this can only rescue a file that would
  otherwise have failed. New `stripPreamble` in src/io/loaders.js.
- **Measurements are auto-saved as you make them.** The Measure view was the one place in
  the app where the data existed nowhere else: a core arrives press by press, and until it
  was saved to a file or added to the pool, a closed tab was a re-measured core — hours at
  the stage, with the wood possibly already back in its box. The whole sitting is now
  mirrored into the browser's local storage after every change and restored on the way back
  in: every series, its widths as the integer microns they were measured in, its per-ring
  notes (locally absent, edited, backwards), its alignment lag, and which series the foot
  switch was feeding. The view says what it picked up and offers **start fresh** beside it.

  It is a crash net, not a filing system: one slot, overwritten as you go, cleared when the
  last ring goes — saving `.rwl`/`.csv` and adding to the pool are still how measurements
  leave the view. A tab only touches the slot once it owns rings (measured, loaded, or
  restored from the slot), so opening a second tab of the app cannot wipe the sitting in the
  first. A closing tab flushes past the 400 ms debounce rather than losing the last ring. If
  storage is full or blocked the view says so instead of failing quietly, since the whole
  point is that the operator can trust it. The undo history is deliberately not persisted:
  it records an editing sitting rather than the wood. New `restoreMeasureSeries(state)` in
  src/measure/series.js (and on `RD`), with `createMeasureSeries` now accepting
  `rings`/`reference`/`lastPosition` so a saved state comes back exactly as it was.

### Changed
- **The heatmap can show every lag it scanned, not a band around the match.** The
  running-correlation heatmap has always been drawn as a ±20-lag window centred on the
  plotted lag — the right size to sit under the line and skeleton plots, but it makes a
  scan of ±260 look like a scan of ±20, and the question a heatmap answers is precisely
  *where else* the two series correlate. Selecting **Running-correlation heatmap** on its
  own now offers **Full lag range**, which opens the lag axis to every lag that pair’s
  crossdate scanned (the lead-lag bar’s own x range) and draws it taller so the rows stay
  readable. The message under the plot names the range either way, so the band no longer
  reads as the whole picture: "lag axis −27 … +13 · a band around the plotted lag, out of
  −260 … +260 scanned". The axis reports what actually correlated — lags far enough out
  leave fewer overlapping rings than the correlation window needs and drop away. The
  option is offered only for the heatmap alone, since the combined view has no room for
  it. New `heatmapFull` / `heatmapSize` options on `AppCore.buildPlots`, a `heatmapSpan`
  and `scannedSpan` on its result, and `AppCore.scannedLagSpan(result, s1, s2)`.
- **The app shell no longer scrolls away.** The header and the view rail (Home /
  Measure / Explore / Build) are pinned to the top and left of the viewport, and the
  Explore settings rail pins directly under the header. A results page runs to several
  screens — table, four plots, diagnostics, the ring test — and reaching another view,
  the loaded-data status or Clear / Export meant scrolling back to the top first. The
  view rail is sized to the viewport and scrolls inside itself on a short window, and
  both sit below the guided tour's dimmer so the tour can still spotlight them.
  Anything scrolled to (`scrollIntoView`, `#anchors`) clears the pinned header.

### Fixed
- **An `.rwl` with a word after the last measurement on a row no longer fails to load.**
  ITRDB files are in circulation that write an annotation past the tenth value of every
  full decade row — `id020.rwl` (Craters of the Moon) ends 2,050 of its rows with `gap` —
  and the reader treated any unparseable value column as fatal: "failed to read rwl file",
  no line, no reason, 56 series over 1,786 years refused. R reads those files (as.numeric
  turns the word into NA and keeps the row), so we do too: text AFTER the last measurement
  on a line is an annotation and is ignored. Junk BETWEEN measurements still stops the
  read, because skipping it would silently drop ring widths — but it now says which value
  and which year it choked on instead of the blanket message, so the next malformed file
  can actually be found and fixed.
- **The measurement trace named the wrong series' ring under a lag.** The cursor quotes a
  ring number beside the width it reads off the series being measured, but the number was
  the shared row index — which is the ring numbering of whichever series starts at row 1,
  not of the active one. A series lagged by two rings therefore had every ring on the trace
  named two too high, against a table whose own heading said it started at row 3. The label
  now counts in the active series' own rings, names the row alongside it while a lag is on
  (the table beside the trace is numbered by row), and brackets and dims a count that falls
  outside the series, as the crossdating cursor does with a year outside a series' span.
  The trace axis says `row` rather than `ring` once anything is lagged, since at that point
  the shared index is nobody's ring numbering.
- **`readRWL` read BC years as AD.** A year that needs five columns (any year
  before 1 CE, written with its minus sign) starts at column 8 rather than 9,
  taking a column from the id field — the case dplR's `read.tucson` covers with
  its `long` argument. The reader always took the year from columns 9-12, so the
  sign was dropped and `-1002` came back as `1002`, silently turning a BC series
  into an AD one; a file written by our own `writeRwl` did not survive the round
  trip. The five-column year is now detected from the '-' in column 8, which a
  Tucson id (letters and digits only) cannot otherwise contain.
- **The chronology exports were detrended indices.** Crossdating runs on detrended series,
  so the aligned frame the exports were written from held indices — and they were handed
  out as the chronology, including as a Tucson `.rwl`, whose values are thousandths of a
  millimetre and would have been read as 1 mm rings. Both export paths (an analysis run,
  and the Build tab's chronology) now write **ring widths** by default: `rawAligned()`
  (src/analysis/align.js) re-values an aligned frame from the raw measurements behind it,
  keeping the placement crossdating gave each series and growing the axis when a raw series
  outruns its detrended column (first differences lose the last ring). The detrended frame
  keeps its own CSV in both panels, and a column with no raw source — a mean chronology, a
  composite chronology's already-detrended members — is left as it is and named in the
  panel rather than quietly mixing indices in among widths. Run results carry `chronRaw`
  so the raw chronology is available to write from.

### Added
- **Missing / false ring test: any ring you name can be tested on its own.** The sweep
  ranks its own experiments and shows the top 20, which answers "where does the data
  think a ring is wrong" but not "is the ring I am looking at wrong" — and a
  dendrochronologist at the scope usually has a specific suspect: a locally absent ring,
  a frost band, a lobe they scored as two. **Test one ring of your own** takes the kind
  of error (missing ring — split ring *i*; false ring — merge rings *i* and *i*+1) and
  the ring number, and reports that one edit: lag, r, p, overlap, T and ΔT against the
  unedited baseline, plus whether it bears fruit — scored by exactly the code the sweep
  scores its own experiments with, so a hand-named edit and a ranked one are directly
  comparable. The corrected series is reviewed below it with the same four plots, can be
  downloaded as .rwl, and can be applied and iterated on like a fruitful one (a user who
  has SEEN the ring does not need the statistics to agree before correcting it).

  No sweep is needed: naming a ring builds the baseline alone, so the answer comes back
  in well under a second instead of after ~2n full crossdates. When a sweep has already
  run on the same series, reference and settings, the ranking stays on screen and the
  named edit is read beside it. A ring outside the series is refused with a message that
  says how many rings it has (a merge stops one ring short of the end, having nothing to
  merge with) rather than silently scoring nonsense. New runner API: `scoreEdit(exp)`
  returning one ranked row, and `maxRing(type)`; `review()`, `corrected()` and
  `correctedDownload()` now validate the ring they are handed.
- **Series that are already detrended are no longer detrended a second time.** Fitting a
  curve to a curve-free series and dividing through it only adds noise, and a second
  z-scoring flattens what the first one left — so a chronology of indices read against raw
  measurements was crossdated on a worse signal than the data actually carried. Every run
  now looks first (`detectDetrended`, src/detrend/detect.js) and carries the series it
  recognises through un-detrended, saying in the rail and in the run message what it found
  and why. The rules are deliberately one-sided, because the two mistakes are not equal:
  missing an index costs a little signal, while mistaking ring widths for an index leaves a
  growth trend in place and can cost the DATE. So a column is only flagged on evidence a
  width series cannot produce — a **negative value** (nothing can be narrower than nothing;
  this is what our own output shows, since every method but "none" ends in z-scores + 1),
  **mean 1 and SD 1** to within a per cent, a **file** whose columns mostly average 1.0
  (one series averaging 1 mm is ordinary; a whole file agreeing on it is not), or a **.crn**
  file, which holds standardised indices by definition. One index column among raw ones,
  with no provenance, is left alone — it is indistinguishable from a 1 mm series.

  A skipped column has no trend removed from it but does take the final z-score + 1 the
  other columns take, so a frame never comes out as a mixture of scales: a mean chronology
  is a plain row-wise mean of its members, and averaging a z+1 member (SD 1) with an
  untouched ratio index (SD ~0.25) would let the detrended one drown out the rest.
  `normalise()` takes the list as `skip`; runs on raw measurements are bit-for-bit
  unchanged, and `autoSkip: false` turns the detection off.
- **Finer detrending control: the chronology can be excluded.** "Detrend the chronology
  too" (chronology mode, Additional settings) clears to leave the chronology exactly as
  loaded while the undated pool is still detrended — the ordinary shape of a `.crn` read
  against raw cores, and a decision rather than an inference. `chronologyWorkflow` takes
  `detrendChron` for the chronology alone, defaulting to `detrend` as before.
- **Segment consensus now runs in pairwise mode too, against the target series.** It was a
  chronology-mode feature because it needs a master to date segments against; pairwise mode
  has one already — the run TARGET, which the filter, the alignment and the table are all
  organised around. Segments of every other series are read against it, and only against it:
  one grid per series rather than one per pair, and a consensus about a series nobody is
  dating against would say nothing. The target is never evidence about itself. Both pairwise
  branches carry the pass (the Segments tool cannot reuse its own rows — those crossdate each
  segment AS the master, so they hold (segment, series) placements — so it takes the same
  segments-vs-target leadLag the background pass does).

  The one thing mode 2 never had to handle: pairwise rows list a pair in column order, so for
  a series that comes BEFORE the target the row reads (series, target) and every consensus lag
  has to be written into it negated — otherwise a promoted series is dated the wrong way round.
  Consensus lags are held in (target, series) orientation throughout; `applyConsensus` and
  `keepConsensusRows` flip per row, and the results badge quotes whichever way its row reads.
- **Downloads can be named.** Every row in the Export panel shows its file name in an
  editable box (extension held outside it, so it cannot be lost); type over the generated
  name and press Download or Enter. `AppCore.downloadName()` strips what a file system will
  not take and falls back to the generated name rather than saving a bare extension. The
  rows also say what each file IS — "aligned chronology — ring widths" against "aligned
  chronology — detrended indices" — instead of the internal key.
- **"Add to pool & crossdate" now crossdates.** It put the sitting in the pool and left the
  operator on the Measure view, one tab and one button short of the answer they measured for.
  It now hands over: the Explore tab opens, the analysis runs with the settings already in
  its rail, and the plots open on the series that was being measured, paired with its best
  match (its own row in the results table is selected too, when the filter lets that row
  through). A series too short to correlate — every r NA — is still plotted against the run's
  master rather than dropped for somebody else's pair, since that is the series most in need
  of a look. Two guards came with it: a second run cannot start while one is running (it says
  so instead of racing the first), and pairwise mode with a single undated series now explains
  that it has nothing to date against, where the engine used to throw an internal error.
  `AppUI.crossdateSeries(name)` is the hand-over; results rows carry `data-s1`/`data-s2` so a
  pair's row can be found by name.
- **An undated series is counted in rings, not misnamed a year.** The comparison
  frame's axis belongs to the CHRONOLOGY — `comb.NA` puts a pool series' ring 1 on
  the frame's first row — so labelling an undated series with an axis value told the
  user a year that series does not have (reported on the Explore page's detrended
  time series plot: the chronology's dating was right, the undated one's was not).
  The cursor now labels a dated series with its calendar year and an undated one with
  its ring count from its own first ring (`sample_a ring 111`), counted from where the
  plot header's "First ring" places it — the same number the Measure table shows. Builders
  say which is which via `opts.ringSeries`; `ownAxis` (src/viz/render.js) turns that
  into the `spec.linkSeries` mapping, so the browser side stays one addition. Applies
  to the line plot and the skeleton plot wherever they are drawn — Explore, the
  chronology builder's review, and the missing/false-ring test, whose synthetic 1..n
  axis never carried years for either side.
- **The linked year cursor names both series' years.** The line plot and the skeleton
  plot draw two series on one axis with the second shifted by the crossdate lag, so the
  cursor standing on 1930 of the master stands on 1923 of the sample — and reading that
  pairing off is what crossdating IS. The cursor now labels both, each in the colour its
  series carries in the legend (black/red on the line plot, blue/red on the skeleton
  rows), on every linked panel at once. A year outside a series' own rings is bracketed
  and dimmed, since there it is where a ring WOULD fall rather than one the series has.
  Builders declare the mapping as `spec.linkSeries` — `[{ label, color, offset, span,
  unit }]`, own value = x + offset — which `toSVG` carries on the hotzone as
  `data-series`; a panel that declares none still shows the plain year it always did.
- **Measure view** — acquire ring widths from a Velmex VRO measuring stage over the
  Web Serial API and push them straight into the undated pool, so a core can be
  crossdated while it is still on the stage. Requires a Chromium browser (or Firefox
  151+) and a secure context (https / localhost); on `file://` the view explains why
  serial is unavailable instead of offering a dead button.
  - `src/measure/vro.js` — the wire protocol, read from Tellervo's `VRODevice`:
    9600 8N1, CR-terminated, ASCII millimetres scaled to integer microns. Guards on
    the readout's `in` (inches) and `ct` (raw counts) suffixes stop acquisition rather
    than record mis-scaled widths. Chunk-safe framing; a leading minus sign is kept
    (Tellervo's `[\d.]+` drops it, turning backwards stage travel into a positive width).
  - `src/measure/series.js` — the ring-width state machine: cumulative vs incremental
    readouts, zero-at-inner-edge, locally absent rings (0), undo, edit/insert/delete,
    and `toFrame()` onto the shared undated Frame (indexed by `ring`, not year).
    Bark-to-pith cores are reversed to oldest-first on export.
  - **Load existing series to amend or edit** — a core put down half-measured, or a
    series crossdating showed to be missing a ring, goes back on the table instead of being
    re-measured. Sources are anything already loaded (undated pool or chronology member) and
    any measurement file (`.csv` / `.txt` / `.rwl` / `.pos` / `.lps` / TRiDaS); a file opened
    here is deliberately NOT merged into the pool, so there is never a stale copy being
    analysed beside the one being edited. A file arrives WHOLE: its series were measured
    together and are only readable against each other, so every one of them comes onto the
    table side by side rather than one at a time, keeping the file's own alignment (a
    series' leading pad on the shared axis becomes its alignment lag, so a dated set lines
    up year for year). The picker chooses which of them the foot switch carries on with;
    "Only …" still takes a single series. Series measured in the sitting are kept beside
    the loaded ones, and a name already on the table is uniquified rather than duplicated.
    `AppUI.seriesGroup()` is the pool-side half of this — a whole group of series, trimmed,
    each with the lead it carried. `series.loadWidthsMm()` is the exact inverse of
    `toFrame()` — oldest-first in, oldest-first out — and flips a bark-to-pith core back into
    measurement order so the next press extends the correct end. New
    `AppUI.loadableSeries()` / `seriesWidths()` / `seriesGroup()` / `readSeriesFile()` are the Measure view's
    whole read path into the pool, and `AppUI.updateMeasuredSeries()` writes an amended
    series back over its own column in place — keeping its position in the pool, carrying
    metadata across a rename, and re-padding the ring axis when the length changed — rather
    than leaving a near-duplicate beside it. With auto-zero on the VRO is re-zeroed on load;
    with it off the view says to re-establish the reference before measuring on, since the
    loaded widths carry no stage position.
    The ring table holds the **row** being worked on in view — the selected row, which
    is also where a ring just off the wire lands — rather than the foot of the table:
    a second series measured beside a longer first one adds its rings a long way above
    the last row, and scrolling to the bottom hid the very ring just taken. Nothing
    already on screen moves, so a click, an edit, a delete or an insert never scrolls
    the row out from under the operator; a row that has scrolled off is brought just
    into view (clear of the sticky header, which `scrollIntoView` tucks it under), and
    an append keeps a row of clearance ahead so the next ring lands on screen too.
  - **The series can be aligned against each other by hand.** Each carries a lag in
    rings, stepped on a number box (arrows, typing and the arrow keys all count), and
    the ring table and the trace follow every step: the series slides down the shared
    index, its column heading says which row its rings start on, and rows it does not
    reach are struck through as gaps. Lags are normalised for display, so a negative
    lag slides the other series down rather than pushing rings off the top of the
    table, and *Reset* puts every series back on ring 1. It aligns the VIEW only —
    `sessionFrame()`, and so every save and the pool, carry exactly what was measured.
  - **The ring table draws its own cell borders.** Chrome paints a row that has
    scrolled under a sticky header *through* it when the table's borders are
    collapsed; the ring table now uses separate borders with one hairline per cell,
    and `reveal()` rounds its scroll offsets, so the header covers what is behind it.
  - **The trace and the ring table are one view, tied by a cursor.** A vertical line
    on the trace marks the ring the table is pointing at — hovered, or selected, or
    just measured — and hovering the trace lights the row that ring belongs to, with
    a click selecting it. The line is drawn into the trace's SVG once and moved by
    attribute, so following the pointer costs no repaint. The table's hover, selection
    and measured column are tinted with the **active series' trace colour** (opaque
    blends, since the table's header is sticky and rows scroll under it), so a table
    holding one column per series says which series a click would edit.
  - **The series name has its own row** at the head of the Measure view instead of a
    slot in the settings strip: it is set once per core and is the name the ring
    table's column, the trace legend, the pool entry and the `.rwl` id all inherit.
    It carries the active series' colour on its edge, like the column and the line.
  - **The markers are the pencil dots, counted out on one pitched note.** The decade
    was the woodblock tick doubled, which at the pedal was heard as a slipped second
    press of the foot switch — the one thing a marker must never suggest. Every marker
    is now the marimba note no press makes, and they are told apart by how many times
    it repeats: one at a decade, **two at a fifty, three at a hundred, four at a
    thousand**, exactly as the dots go on the core. The per-marker voices are exposed
    as `MeasureAudio.voicesFor()`, the whole ladder as `MeasureAudio.markers()`.
  - **A sitting at the stage is several series, not one.** *New series* used to offer to
    discard what was on the table; it now parks it and starts another beside it, which is
    how a radius is re-measured to check it and how one `.rwl` comes to hold a specimen's
    radii. The view holds a **session**: every series keeps its own width column in the ring
    table on a shared ring axis, all of them are drawn on the trace with the active one
    picked out, and clicking a name — or any cell in another column — moves the foot switch
    to that series. *Discard series* is the separate, deliberate way to lose one. Saving
    writes the whole session into one multi-series `.rwl` / `.csv`, and *Add to pool &
    crossdate* takes the whole sitting, updating series already linked to a pool entry
    instead of copying them, so a second click adds nothing. Two names that collapse to one
    Tucson id are refused rather than silently written over each other.
    `AppUI.addMeasuredSeries()` now accepts a multi-series frame and returns
    `{ id, ids, message }`.
  - **The ring table lost its Position and Note columns.** Position was a cumulative-mode
    diagnostic already visible in the raw-frame monitor, and both columns cost the width the
    per-series columns now use. Nothing is hidden: an absent or backwards ring still shows in
    its own colour, and the note it carried is the cell's tooltip.
  - **The .rwl series id is no longer changed silently.** A Tucson id field holds
    six alphanumeric characters in the standard layout (NOAA's format description
    gives the core id columns 1-6 and the decade columns 9-12), so a core measured
    as `CMP519B` was written — and reloaded — as `CMP519`. The Measure view now
    shows what the file will call the series as soon as the name cannot be carried
    verbatim, and offers an **8-character .rwl id**: `writeRwl` gained dplR's
    `longNames` option, which spends the two slack columns on the id (seven
    characters once any year needs five, matching `write.tucson`'s rule that the
    narrower limit applies to every id in the file). It is opt-in, since dplR warns
    that long ids may not be readable by other software, and `.csv` still keeps any
    name exactly. `fixNames` is exported so a UI can show the id a file will carry
    rather than re-deriving the rule.
  - **Auto-zero after each ring** (default on), matching Tellervo: the `C` (clear) and
    `S` (send) commands were recovered from `VRODevice` bytecode and are written as
    `"C\r"` / `"S\r"`. The readout then shows the ring being measured instead of
    distance from the pith, and frames are widths rather than accumulating positions,
    so the mode is pinned to incremental while it is on. A near-zero frame arriving
    within 400 ms of a clear is treated as the readout's acknowledgement and ignored,
    so it cannot interleave a spurious 0 mm ring between real ones.
  - With auto-zero off, readout mode is **detected from the first few presses** rather
    than assumed, and changing it re-derives every ring from the raw frames — except
    where that correspondence is broken (absent rings, inserts, deletes, a mid-core
    auto-zero toggle), in which case the new regime applies going forward only.
  - `web/measure.js` — browser-only transport and UI (port permission, read loop, live
    trace, ring table). New `AppUI.addMeasuredSeries()` merges a measured series into
    the pool through the same path a loaded file takes, with name de-duplication.
  - `web/measure-audio.js` — audible ring feedback: the pencil dots put on a core
    (one per decade, two per fifty, three per century, four per thousand) sounded
    rather than drawn. A short woodblock tick (triangle transient plus filtered
    noise crack, ~50 ms) per ring, and a **marimba note repeated once per dot** at
    each marker — a voice no press makes, so a marker can never be mistaken for a
    slipped press. `markerFor()` tests the intervals strongest first, without which
    ring 100 would sound as a fifty and ring 1000 as a hundred. **Test tones**
    auditions every marker in order, spaced by `lengthOf()` so a four-note thousand
    is not talked over. Absent rings sound and count toward the markers so the tally
    cannot drift from the ring numbers. Toggle and volume persist in `localStorage`;
    the AudioContext is opened by the Connect click, the gesture browsers require
    before playing audio.
  - Serial commands are **queued, never concurrent**. A writer locks
    `port.writable`, so a second `getWriter()` while one is in flight throws; that
    throw previously escaped into the connect error path and nulled the port
    reference while the port was still open, after which nothing could close it.
  - The port is now released on **every** teardown path — explicit disconnect, read
    error, cable unplug, and page unload — instead of only the first. A read error
    used to stop the read loop while leaving the port open, so the next Connect
    failed with `The port is already open`, wrongly blaming Tellervo. An already-open
    port is now adopted rather than reopened, and close failures are surfaced instead
    of silently swallowed.
  - `test/measure_test.js` — 47 checks, no hardware: framing, parsing, unit guards,
    command bytes, mode detection, both acquisition modes, editing/undo, the Frame
    contract, and a full synthetic session round-tripped through the R-validated
    `writeRwl`/`readRWL`.
  - `test/measure_ui_test.js` — drives the real `web/measure.js` in headless Chrome
    against a mock `SerialPort` to cover the port lifecycle, which no logic-only test
    can reach: open/close accounting, the zero command on connect and after each ring,
    recovery from a simulated cable fault, reconnect, and the audio cue firing once per
    ring with the doubling on the tenth. Skips cleanly (exit 0) where no Chrome/Edge is
    installed.

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
