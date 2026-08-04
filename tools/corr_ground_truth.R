#!/usr/bin/env Rscript
# Ground truth for corr.rwl.seg JS port.
# Regime = exactly how ringdater::prob_check calls it:
#   method=spearman (match.arg first), prewhiten=TRUE, biweight=TRUE,
#   bin.floor=10, pcrit=0.05, floor.plus1=FALSE, master=NULL, n=NULL.
# Data: dplR ca533 (contiguous years). One series is reversed over its
# measured span to guarantee a non-empty flag set.
# Writes ringdater-js/test/corr_gt.json with a hand-rolled JSON serializer
# (no extra packages); numbers via format(x, digits=17), NA -> null.

suppressMessages(library(dplR))
data(ca533)

here <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js"
out <- file.path(here, "test", "corr_gt.json")

seg.length <- 20
bin.floor  <- 10
pcrit      <- 0.05

# --- build input rwl (contiguous), reverse series 1 to force miscrossdating ---
rwl <- ca533
i <- 1
v <- rwl[[i]]; g <- !is.na(v); v[g] <- rev(v[g]); rwl[[i]] <- v

cnames <- names(rwl)
years  <- as.numeric(rownames(rwl))

res <- corr.rwl.seg(rwl, seg.length = seg.length, bin.floor = bin.floor,
                    n = NULL, prewhiten = TRUE, pcrit = pcrit, biweight = TRUE,
                    method = c("spearman", "pearson", "kendall"),
                    make.plot = FALSE, floor.plus1 = FALSE, master = NULL)

bins      <- res$bins
bin.names <- paste0(bins[, 1], ".", bins[, 2])
nbins     <- nrow(bins)

# ---------- minimal JSON helpers ----------
num <- function(x) {
  if (length(x) != 1) stop("num scalar")
  if (is.na(x)) return("null")
  trimws(format(x, digits = 17, scientific = FALSE))
}
jstr  <- function(s) paste0('"', gsub('"', '\\\\"', s), '"')
jnums <- function(v) paste0("[", paste(vapply(v, num, ""), collapse = ","), "]")

# matrix (nseries x nbins) -> object id -> array
mat.obj <- function(m) {
  parts <- vapply(seq_len(nrow(m)), function(r)
    paste0(jstr(cnames[r]), ":", jnums(m[r, ])), "")
  paste0("{", paste(parts, collapse = ","), "}")
}

# ---------- input series ----------
series.parts <- vapply(cnames, function(cn)
  paste0(jstr(cn), ":", jnums(rwl[[cn]])), "")
series.obj <- paste0("{", paste(series.parts, collapse = ","), "}")

# ---------- overall (rho, p-val) ----------
overall.parts <- vapply(seq_len(nrow(res$overall)), function(r)
  paste0(jstr(cnames[r]), ":", jnums(res$overall[r, ])), "")
overall.obj <- paste0("{", paste(overall.parts, collapse = ","), "}")

# ---------- flags ----------
if (length(res$flags) > 0) {
  fparts <- vapply(seq_along(res$flags), function(k)
    paste0(jstr(names(res$flags)[k]), ":", jstr(unname(res$flags[k]))), "")
  flags.obj <- paste0("{", paste(fparts, collapse = ","), "}")
} else flags.obj <- "{}"

# ---------- bins ----------
bins.arr <- paste0("[",
  paste(vapply(seq_len(nbins), function(r)
    paste0("[", num(bins[r, 1]), ",", num(bins[r, 2]), "]"), ""),
    collapse = ","), "]")

json <- paste0("{\n",
  '"seg_length":', seg.length, ',\n',
  '"seg_lag":', res$seg.lag, ',\n',
  '"bin_floor":', bin.floor, ',\n',
  '"pcrit":', num(pcrit), ',\n',
  '"years":', jnums(years), ',\n',
  '"cnames":[', paste(vapply(cnames, jstr, ""), collapse = ","), '],\n',
  '"series":', series.obj, ',\n',
  '"bins":', bins.arr, ',\n',
  '"bin_names":[', paste(vapply(bin.names, jstr, ""), collapse = ","), '],\n',
  '"spearman_rho":', mat.obj(res$spearman.rho), ',\n',
  '"p_val":', mat.obj(res$p.val), ',\n',
  '"overall":', overall.obj, ',\n',
  '"avg_seg_rho":', jnums(res$avg.seg.rho), ',\n',
  '"flags":', flags.obj, "\n}\n")

writeLines(json, out)
cat("wrote", out, "\n")
cat("nseries:", length(cnames), "nbins:", nbins, "nflags:", length(res$flags), "\n")
