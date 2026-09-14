# RingdateR Web

A browser-based port of **[RingdateR](https://github.com/ringdater/ringdater_pkg)** —
statistical and visual **crossdating** of annually-resolved growth series (tree rings,
and mollusc / fish / coral increments). It runs entirely in your browser: no server,
no install, and your data never leaves your machine.

- **Live app:** https://daveedge1.github.io/ringdater-web/
- **Library on npm:** [`ringdater-js`](https://www.npmjs.com/package/ringdater-js)
- **Original R package (RingdateR):** https://github.com/ringdater/ringdater_pkg
- **Underlying dendro algorithms (dplR):** https://github.com/OpenDendro/dplR

This repository is both the **web app** (`web/`) and the **`ringdater-js` library** (`src/`)
it runs on. The library is published to npm and can be used on its own — see
[Use as a library](#use-as-a-library-ringdater-js) below.

## Use as a library (`ringdater-js`)

The numeric core and crossdating analysis are published as a standalone,
**zero-dependency** npm package. It works in Node and in the browser (via any bundler),
and ships both CommonJS and ESM entry points.

```bash
npm install ringdater-js
```

```js
// ESM
import { caps, leadLag, normalise } from 'ringdater-js';
// or the whole namespace:
import RD from 'ringdater-js';

// CommonJS
const { caps, leadLag } = require('ringdater-js');
```

Loaders take file *descriptors* (`{ name, text, buffer }`), not disk paths, so the same
code runs in Node and in the browser. `~79` functions are exported — the dplR numeric
core (spline/`caps` detrending, AR(1) prewhitening, `supsmu`/Friedman, Rbar/EPS,
`corr.rwl.seg`), the crossdating analysis (lead–lag, running correlation, heatmap,
alignment), IO parsers/writers (CSV, RWL/Tucson, `.crn`, `.pos`, `.lps`, TRiDaS,
Ring Measurer), SVG plot builders, and the headless orchestration engine
(`pairwiseWorkflow`, `chronologyWorkflow`, `createBuilder`). See
[`src/index.js`](src/index.js) for the full export list and
[Validation](#validation) for R-parity.

> Note: `.xlsx` reading uses Node's `zlib`. In a browser bundle that import needs an
> inflate shim; CSV / TXT / RWL / `.crn` / `.pos` / `.lps` / TRiDaS / Ring Measurer
> have no such requirement.

## About

RingdateR Web is a clean, **dependency-free JavaScript** reimplementation of the
RingdateR R/Shiny application by David Reynolds, David Edge, and Bryan Black. The
numeric core — detrending, AR prewhitening, lead–lag crossdating, Rbar/EPS, segment
correlation, and RWL / `.pos` / `.lps` parsing — is ported from the original R package
and from `dplR`, and **validated against R** (R is the oracle for every function's
test — see [Validation](#validation)).

## Features

- **Load** undated series (`.csv`, `.txt`, `.rwl`/Tucson, `.pos`, `.lps`, Ring Measurer)
  and, optionally, a dated chronology.
- **Detrend**: spline, modified negative exponential, Friedman super-smoother, modified
  Hugershoff, z-score, first-difference — plus AR(1) prewhitening and log transform.
  Series that are **already indices** are detected and carried through un-detrended: a
  ring width cannot be negative, a file whose series all average 1.0 is in index units,
  and a `.crn` is standardised by definition. So a chronology of indices can be read
  straight against raw measurements without being detrended twice. They are still put on
  the same scale as the detrended series, so a mean chronology is not dominated by
  whichever of its members happened to be detrended. The detection can be turned off.
- **Targets you choose the treatment for, and can average.** What you crossdate against
  is not always a tree-ring chronology — a PDSI grid point, a precipitation or
  temperature reconstruction is increasingly what people have — and those have no growth
  trend to remove. Each loaded target therefore carries **its own detrending method**,
  asked for when the file lands and recommended with a reason ("averages 18.3, which a
  ring-width series does not"; "goes negative, so it is already an index"). Load several
  and tick which ones go into the **composite**: their mean becomes the target, each put
  on the common z-score scale first so a reconstruction in millimetres cannot outweigh an
  index. See [Targets](#targets-what-you-crossdate-against) below.
- **Automatic crossdating** in pairwise or chronology mode, with a filterable results
  table (suggested lags, R, p, overlap).
- **Segment consensus** on every run: each series is segmented in the background and its
  windows dated independently, against the mean chronology in chronology mode and against
  the **target series** in pairwise mode. Two or more segments agreeing on a placement
  out-rank a whole-series best lag that a missing or false ring has diluted — promoted to
  1st in the table, badged, with the evidence in the tooltip, and kept through the r/p
  filter that would otherwise have dropped the very series it rescued.
- **Interactive plots**: a zoom/pan line overlay, a running-correlation heatmap centred
  on the best lag, and a lead–lag bar chart. Hovering the line plot or the skeleton plot
  draws one cursor across both, labelled with **where it falls in each series** — each in
  the colour that series is drawn in. A dated series is named by its calendar year; an
  undated one, having none, is counted in **rings from its own first ring** (`ring 111`),
  the same number the measuring table shows.
- **Build chronology** — an iterative, manual master-building workflow: crossdate one
  series at a time against the growing chronology, review the plots, and **approve /
  skip / flag "needs review"** with notes. Includes an **auto-build** option (editable
  afterwards), **calendar dating** by pinning a known sample's ring to a year, and
  **session save / restore** (portable file + browser autosave) so you can leave and
  come back.
- **Measure** ring widths directly from a **Velmex VRO** measuring stage over the
  [Web Serial API](https://developer.chrome.com/docs/capabilities/serial) — no driver,
  no install, no file round-trip. Widths land in the undated pool ready to crossdate, so
  a false or missing ring can be caught while the core is still under the microscope.
  Handles both readout configurations (absolute position or self-zeroing), detecting
  which from the first few presses; supports locally absent rings, undo, and editing.
  **Existing series can be loaded back onto the table** — a whole file at once, or the
  whole pool, side by side — to correct a ring or finish a core that was put down
  half-measured, then written straight back over the series they came from.
  The sitting is **auto-saved in the browser** after every ring, so a closed tab or a
  refresh does not cost you the core. See [Measuring](#measuring-velmex-vro) below.
- **Export** the chronology (CSV / RWL), download plots (SVG), and generate a run report —
  from the **Export** menu in the header, scoped to whichever workspace you're in. The
  chronology comes out in **ring widths** — crossdating runs on detrended indices, but the
  chronology you take away, and everything a `.rwl` means, is measurements — re-valued from
  the raw series at the placement the crossdate found. The detrended frame keeps a CSV of
  its own beside it, labelled as such. Every file's **name is editable in place**: type over
  it before pressing Download; the extension is held outside the box so it cannot be lost.

The app opens on a **Home** page with four tasks — **Explore** (crossdate series against each
other or a chronology), **Build** (start a new chronology from an anchor series), **Extend**
(grow a loaded dated chronology), and **Learn** (an interactive, hands-on guided tour that
drives the real app with the bundled example data). Work happens in two workspaces reached from
the sidebar: **Explore** (settings rail + results table + linked plots on one screen) and
**Build** (the chronology builder).

## Run locally

It's a static site — no build step is needed to use the committed bundle:

```bash
# just open it
open web/index.html
# …or serve it
node web/serve.js      # then visit http://localhost:8080
```

After changing anything under `src/`, rebuild the browser bundle (and, if you changed
the exported surface in `src/index.js`, regenerate the ESM facade):

```bash
node tools/bundle.js    # regenerates web/ringdater.bundle.js (zero npm deps)
node tools/gen-esm.js   # regenerates src/index.mjs from src/index.js's exports
```

Node is only needed for the bundler and the tests; the app itself has **no runtime
dependencies**. (`.xlsx` upload in the browser needs a small inflate shim — CSV / TXT /
RWL / `.pos` / `.lps` / Ring Measurer are fully supported out of the box.)

## Targets: what you crossdate against

In chronology mode the undated pool is dated against a **target**. A target is any dated
series: a tree-ring chronology (`.crn`, `.rwl`, a set of indices), or a climate
reconstruction — a NADA PDSI grid point, a precipitation or temperature series from NOAA
Paleo. Load as many as you like; each keeps its own card under **Data**.

**Each target says how it should be detrended.** This is not a detail. A raw tree-ring
chronology has a growth trend that must come off. A reconstruction does not — fitting a
curve to one removes the low-frequency climate signal it was loaded for, and for anything
that crosses zero (PDSI, any anomaly series) the usual detrendings are **ratios**, so
dividing by a curve that passes through zero returns noise. Measured on two real files —
a Utah precipitation reconstruction against the NADA PDSI at 41.8N 111.2W, 2,006 shared
years — the two correlate at **r = 0.58** rescaled and **r = 0.02** if both are splined.

So the method is a property of the target, chosen on its card, not inherited from the
pool:

- **Rescale only — z-score, no curve fitted** — for a reconstruction, or a series that is
  already an index. Nothing is removed; it is only put on the common scale.
- **Spline / ModNegExp / Friedman / ModHugershoff / first difference** — for a raw
  tree-ring chronology, exactly as for the pool.
- **Same as the undated pool** — the default for an ordinary chronology loaded beside raw
  series.

The app recommends one and says why, but never decides: the numbers can only ever rule
*out* ring widths (a negative value, a mean no ring width can have), never rule them in.
Every method offered ends in z-scores + 1, so targets always plot and average on one
scale.

**Averaging targets.** Tick **Include in the composite target** on two or more, and
*Composite — mean of N ticked targets* appears in **Compare against**. Each member is
detrended its own way first, then they are merged on the union of their years and
averaged — so a 2,000-year precipitation reconstruction and a PDSI grid point become one
target, and years covered by only one of them still contribute. Untick a target to hold
it out without unloading it.

**The composite is measured before it is used.** Averaging is not free: two targets that
share no signal do not reinforce each other, they cancel, and the mean comes out a smooth
plausible series made mostly of the noise they do not have in common. Worse, two that
agree better a few years apart are two of which one is **dated wrong** — and a composite
hides that behind a tidy mean, then carries the error into every date taken from it.

So the **Composite target** card scores every ticked pair over the years it shares, as
dated and at every lag within ±10 years, and says what it found:

| Verdict | What it means |
| --- | --- |
| **agree** | r ≥ 0.35 at lag 0 — average them |
| **weak** | 0.15 ≤ r < 0.35 — the mean will be flatter than its members |
| **no agreement** | r < 0.15 — the mean is mostly noise |
| **opposed** | r ≤ −0.15 — check you have not loaded an index and its inverse |
| **possible dating offset** | they agree better at a lag (by ≥ 0.05, reaching r ≥ 0.35) — one of them is dated wrong |
| **too little overlap** | fewer than 30 shared years: nothing can be said either way |

Above the table: the **mean inter-target correlation** and the **EPS** it implies
(`n·r̄ / (1 + (n−1)·r̄)`, the standard measure of whether a mean is worth more than its
members — 0.85 is the usual threshold), the years every member covers, and a plain
sentence saying whether to go ahead. Below it, the members are plotted together with
their mean through them, zoomable, because that is the picture the numbers only assert.
The verdict is repeated in one line beside **Compare against** and in the run message, so
a composite that should not have been averaged cannot be used without saying so — but it
is a warning, not a veto: untick the odd one out, or fix its dating, and run again.

## Measuring (Velmex VRO)

The **Measure** tab talks to a Velmex VRO encoder readout on a serial port and records
ring widths straight into the undated pool.

**Requirements.** A Chromium browser (Chrome/Edge/Opera 89+; Firefox 151+ also works) and
a **secure context** — the GitHub Pages site, or `http://localhost` when running locally.
On a `file://` page `navigator.serial` does not exist and the tab explains this instead of
offering a dead button. Port permission is granted once per origin and remembered.

**Protocol.** Fixed at the VRO's own settings, so a stage already measuring in Tellervo
needs no reconfiguration: **9600 baud, 8N1, no flow control, CR-terminated**, ASCII decimal
millimetres. These were read from Tellervo's `VRODevice` driver, which is also where the
unit guards come from: a frame ending in `in` (inches) or `ct` (raw encoder counts) means
the readout is misconfigured, and acquisition stops rather than record mis-scaled widths.

**Auto-zero (default on).** After each recorded ring the VRO is sent `C` — the same
clear command Tellervo's `zeroMeasurement()` sends — so the readout shows the ring you
are currently measuring rather than distance from the pith, and nothing accumulates.
`S` (request a reading without the foot switch) is wired to the **Request reading**
button, which is also the quickest way to prove the outbound serial path works before
putting a real core on the stage. Both commands were recovered from the bytecode of
Tellervo's `VRODevice`.

**Readout modes.** With auto-zero on, each frame *is* a ring width, so the mode is pinned
to *incremental* and there is nothing to infer. Turn auto-zero off and the VRO keeps
counting: frames are absolute positions and widths are differences between presses
(*cumulative*). The readout does not announce which regime it is in, so with auto-zero off
the tab infers it from the first few presses — ring widths essentially never rise
monotonically, so a rising run means absolute position — shows its reasoning, and lets you
override. Changing the mode re-derives every ring from the raw frames rather than leaving
earlier rings computed the old way; where that correspondence has been broken (absent
rings, inserts, deletes, or toggling auto-zero mid-core) the change applies going forward
only and says so.

**Workflow.** Connect (the VRO is zeroed automatically), then press the foot switch at
each ring boundary. `0` marks a locally absent ring, `Backspace` undoes, `E` edits the
selected ring, `Del` deletes it. Then **Add to pool & crossdate**, or save `.rwl` / `.csv`.

**Nothing is lost to a closed tab.** Until a sitting is saved to a file or added to the
pool, the measurements exist only in this view — so the whole sitting is written to the
browser's local storage after every ring and read back when you return: every series, its
widths (as the integer microns they were measured in, not rounded millimetres), its notes,
its alignment, and which series the foot switch was feeding. Come back and the view says
what it picked up, with **start fresh** beside it if you would rather begin again. It is a
crash net, not a filing system: one sitting is remembered, overwritten as you measure, and
cleared when the last ring is discarded — saving to `.rwl` and adding to the pool are still
how measurements leave this view. Nothing leaves your machine; it is the same local storage
the volume setting uses. The undo history is not carried across a reload — `Backspace`
starts from the restored state.

**Several series in one sitting.** A radius is routinely measured twice to check it, and a
specimen's radii belong together in one file — so **New series** parks the series you are
on and starts another *beside* it rather than discarding it. Every series measured in the
sitting keeps its own column in the ring table, on the same ring axis, so a second
measurement can be read against the first ring by ring; all of them are drawn on the trace,
with the one being measured picked out. Click a name in the **Measuring:** row, or any cell
in another series' column, to go back to it — the foot switch then continues *that* series.
**Discard series** throws away only the one you are on. Saving writes them all into one
`.rwl` (or `.csv`), which is what a multi-series Tucson file is; **Add to pool & crossdate**
puts the whole sitting in the pool, writing back over any series already linked to a pool
entry rather than adding a copy, so pressing it twice changes nothing the second time.

It then does the second half of its name: it opens the **Explore** tab, runs the crossdate
with the settings already in the rail there, and puts the plots on the series you were
measuring against its best match — no second button, no re-choosing the pair. Measuring and
crossdating are one act; stopping at the pool would leave you on a settings page. If the run
cannot start — chronology mode with no chronology loaded, or a first series with nothing yet
to date it against — the Explore tab says so beside the control that fixes it.

One caveat comes with the format rather than the app: two series whose names collapse to the
same Tucson id — `CMP519B` and `CMP519B2` both cut to `CMP519` — cannot share one `.rwl`, so
saving is refused until you tick the 8-character id or rename one. See the next paragraph.

**Amending existing series.** Measuring a core is rarely one sitting, and crossdating
regularly sends you back to a series to insert a missing ring. **Load an existing series…**
puts them back on the table: the series already loaded (the pool, or one chronology's
members), or a `.csv` / `.txt` / `.rwl` / `.pos` / `.lps` / TRiDaS file — a file opened here
is *not* merged into the pool, so you never end up editing one copy while analysing another.

A file comes in **whole**. Its series were measured together and are only readable against
each other, so **Load all N series** brings every one of them onto the table side by side, in
the order and the alignment the file stored them in — a dated set arrives year for year,
because where a series sat on the file's shared axis becomes its alignment lag. **Carry on
with** says which of them the foot switch continues, and **Only "name"** takes just that one
if a single series is really all you want. Series measured in this sitting are kept beside
the loaded ones, and a name already on the table is not reused: a second `sample_b` comes in
as `sample_b_2`, since two columns with one name cannot both be saved.

Their widths become the rings in the table, ready to edit, and the next press of the foot
switch adds to the end of whichever series you are measuring; a bark-to-pith core is flipped back into measurement order first, so
the stage continues at the right end. Nothing changes until you save: a series loaded from
the pool then offers **Update "name" in the pool**, which replaces that column in place —
keeping its position, carrying its metadata across a rename — while **Add to pool** still
puts a uniquely named copy beside the original. Loaded widths say nothing about where the
stage now sits, so with auto-zero on the VRO is re-zeroed on load; with it off, drive to the
last measured boundary and press **Zero the VRO** before measuring on. **Update "name" in the
pool** stays on the Measure view; **Add to pool & crossdate** takes you to the results.

**Series names and the .rwl id field.** A Tucson `.rwl` line spends its first
twelve columns on the series id and the decade, and NOAA's format description gives
the core id **columns 1-6** with the decade in **9-12** — so six alphanumeric
characters is the only id length that is safe in every program that reads the
format. Saving `CMP519B` therefore writes `CMP519`, and the series comes back under
that name the next time it is loaded. RingdateR does not do this behind your back:
as soon as the name in the **Series name** box cannot go into a `.rwl` as it stands,
the save row spells out what the file will be called, and offers an **8-character
.rwl id** — dplR's `long.names` layout, which spends the two slack columns on the id
(seven if any year needs five columns, i.e. BC dates). dplR's `read.tucson` reads
those ids, but dplR's own documentation warns that *"long IDs may cause
incompatibility with other software"*, so it stays your choice rather than the
default. `.csv` has no such limit and keeps the name exactly.

**Sound.** The pencil dots already put on a core — one at each decade, two at each fifty,
three at each century, four at each thousand — sounded rather than drawn, so you can keep
count without looking up from the microscope:

| Ring | Sound |
|---|---|
| every ring | one woodblock tick |
| every 10th | a marimba note instead |
| every 50th | that note twice |
| every 100th | three times |
| every 1000th | four times |

A marker must never sound like a ring. The decade was originally the woodblock tick
doubled (Tellervo's cue), which at the pedal was heard as a slipped second press of the
foot switch — so every marker is now the pitched note, which no press makes, and they are
told apart from each other by how many times it repeats, exactly as the dots go on the
core. A ring lands on several intervals at once — 1000 is a decade, a fifty and a century
too — and the strongest it reaches is the one that sounds; otherwise the stronger marker
would never be heard. **Test tones** plays every marker in order, each given room to finish
before the next starts, so you can set the level without measuring a thousand rings to
reach the last one. Absent rings sound and count toward the markers, so the tally never
drifts from the ring numbers. Toggle and volume persist
between sessions; audio starts on the Connect click, the gesture browsers require before
any sound can play.

**The trace and the ring table are one view.** A ring is a row in the table and a point
on the trace above it, tied together by a cursor: hover a row and a vertical line marks that
ring on the trace; hover the trace and the row it belongs to lights up, with a click
selecting it for the ring buttons. With nothing hovered the cursor rests on the selected
ring — which, while the pedal is running, is the ring just measured. The table's hover,
selection and measured column are tinted with the **active series' own trace colour**, so in
a table holding one column per series the highlight says which series a click would edit,
not merely which row. The cursor's label reads out the ring number of that same series —
the one whose width it also quotes — so under a lag it names the ring being measured rather
than the row, giving the row alongside it and bracketing a count that falls outside the
series altogether.

**Aligning two measurements.** A radius measured twice only reads against the first once
a missed or extra ring is allowed for, so each series carries a **lag** in rings, stepped on
a number box with its own arrows (or typed, or nudged with the arrow keys). The table and
the trace follow every step as it is made: the series slides down the shared ring index,
its column heading says which row its rings now start on, and the rows it does not reach
are struck through as gaps. A negative lag slides the *other* series down instead, so no
ring is ever pushed off the top, and **Reset** puts everything back on ring 1. This is an
alignment of the view and nothing else — no width is changed, and what a save or an add to
the pool writes is exactly what was measured. Crossdating still works out its own lags.

Series arrive **undated** and indexed by ring number — crossdating is what assigns calendar
years. A core measured bark-to-pith is reversed to oldest-first on the way out, since every
downstream routine assumes a series runs oldest to youngest.

The protocol and series logic live in `src/measure/` and are covered by
`test/measure_test.js` with no hardware attached; `web/measure.js` is the browser-only
transport and UI.

Format references: [NOAA tree-ring data description](https://www.ncei.noaa.gov/pub/data/paleo/treering/treeinfo.txt)
(column layout and end-of-record markers), [dplR `write.tucson`](https://search.r-project.org/CRAN/refmans/dplR/html/write.tucson.html)
(`long.names`) and [dplR `read.tucson`](https://search.r-project.org/CRAN/refmans/dplR/html/read.tucson.html)
(id widths, `long`).

## Validation

Every ported function is checked against R — `dplR` and the *actual* ringdater R
functions — as the oracle. Run the suite:

```bash
npm test
```

Parity highlights (full per-function tables in [`docs/VALIDATION.md`](docs/VALIDATION.md);
the complete R→JS port plan is in [`WORKPLAN.md`](WORKPLAN.md)):

| Area | vs R |
|---|---|
| Spline / `caps` detrending, AR(1) prewhitening, alignment | **bit-exact** |
| Friedman `supsmu`, Rbar/EPS, `corr.rwl.seg`, RWL read/write | **bit-close** (≤~1e-9) |
| Lead–lag crossdating engine, `cor.test` p-values | **≤~1e-11** |
| `ModNegExp` / `ModHugershoff` (nonlinear fits) | matches when R's `nls` converges (divergences documented) |

## Versioning & releases

The library (`src/`) and the web app (`web/`) share one semantic version, with
`package.json` as the single source of truth — stamped into `src/version.js`
(`RD.VERSION`), the app's header badge, and cache-busting `?v=` query strings on
every asset in `web/index.html`. `test/version_test.js` fails the suite if any
copy drifts; changes are documented in [`CHANGELOG.md`](CHANGELOG.md).

To release:

```bash
npm version patch|minor|major   # bump -> stamp -> rebuild esm+bundle -> test -> commit + vX.Y.Z tag
git push --follow-tags
```

(Add the release's notes to `CHANGELOG.md` first — the version test checks the
new version has an entry.)

## Repository layout

```
src/    the ringdater-js npm package (numeric core + analysis + engine, no deps)
        index.js  = CommonJS entry;  index.mjs = generated ESM facade
        measure/  = Velmex VRO protocol + ring-width series state machine
web/    the browser app (index.html, app.js, appCore.js, measure*.js, styles, bundle)
test/   R-oracle validation suites (+ fixtures)
tools/  the bundler, the ESM-facade generator, and the R ground-truth generators
docs/   VALIDATION.md (per-function parity tables)
WORKPLAN.md   the full R→JS port plan
```

Only `src/` (plus `README.md` and `LICENSE`) is published to npm — controlled by the
`files` allowlist in `package.json`. `test/`, `tools/`, `web/`, and `docs/` stay in the
repo but never ship in the package tarball.

## Deployment

Pushing to `main` builds the bundle and publishes `web/` to **GitHub Pages** via
[`.github/workflows/pages.yml`](.github/workflows/pages.yml). Enable it once under
**Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Citation

If you use RingdateR (this web port or the R package) for scientific work, please
cite the original publication:

> Reynolds, D.J., Edge, D.C. and Black, B.A., 2021. RingdateR: A Statistical and
> Graphical Tool for Crossdating. *Dendrochronologia*, 65, 125797.
> https://doi.org/10.1016/j.dendro.2020.125797

A machine-readable citation is provided in [`CITATION.cff`](CITATION.cff) (GitHub
renders a "Cite this repository" button from it).

## Credits & license

A port of **RingdateR** (David Reynolds, David Edge, Bryan Black —
https://github.com/ringdater/ringdater_pkg), which builds on **dplR** (OpenDendro).

Released under the [MIT License](LICENSE); the original RingdateR is likewise MIT-licensed.
