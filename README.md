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
- **Automatic crossdating** in pairwise or chronology mode, with a filterable results
  table (suggested lags, R, p, overlap).
- **Interactive plots**: a zoom/pan line overlay, a running-correlation heatmap centred
  on the best lag, and a lead–lag bar chart.
- **Build chronology** — an iterative, manual master-building workflow: crossdate one
  series at a time against the growing chronology, review the plots, and **approve /
  skip / flag "needs review"** with notes. Includes an **auto-build** option (editable
  afterwards), **calendar dating** by pinning a known sample's ring to a year, and
  **session save / restore** (portable file + browser autosave) so you can leave and
  come back.
- **Export** the chronology (CSV / RWL), download plots (SVG), and generate a run report —
  from the **Export** menu in the header, scoped to whichever workspace you're in.

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
web/    the browser app (index.html, app.js, appCore.js, styles, bundle)
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
