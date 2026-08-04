# Ground truth generator for ringdater::normalise (detrending dispatcher).
# Sources the ACTUAL normalise_function.R + its deps and library(dplR), runs the
# full case matrix (methods 1-7, ARmod, logT combos) on a ca533-derived
# multi-series Frame, and emits JSON with a hand-rolled serializer (digits=17).

suppressMessages(library(dplR))

RPKG <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(RPKG, "comb_NA_function.R"))
source(file.path(RPKG, "whiten_function.R"))
source(file.path(RPKG, "normalise_function.R"))

data(ca533)

outfile <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/normalise_gt.json"

# ---- minimal JSON helpers ---------------------------------------------------
jnum <- function(x) {
  if (length(x) == 0) return("null")
  vapply(x, function(v) {
    if (is.null(v) || is.na(v)) "null"
    else format(v, digits = 17, scientific = FALSE, trim = TRUE)
  }, character(1))
}
jarr <- function(x) paste0("[", paste(jnum(x), collapse = ","), "]")
jstr <- function(s) paste0("\"", s, "\"")

# Build the input data.frame: col1 = years, then series columns (NA-padded).
sub <- ca533[, 1:8]
years <- as.numeric(rownames(sub))
ids <- colnames(sub)
df <- data.frame(year = years, sub, check.names = FALSE, stringsAsFactors = FALSE)

# Dump the input frame so the JS side reads identical numbers.
dump_input <- function(df) {
  cols <- lapply(seq_len(ncol(df)), function(j) jarr(df[[j]]))
  paste0("{\"names\":[", paste(vapply(colnames(df), jstr, character(1)), collapse = ","), "]",
         ",\"cols\":[", paste(unlist(cols), collapse = ","), "]}")
}

# For the nls methods (4/6) record which curve dplR actually used per series
# (NegativeExponential/Hugershoff = nls converged; Line/Mean = fallback path).
rmethods <- function(sel) {
  meth <- if (sel == 4) "ModNegExp" else "ModHugershoff"
  vapply(ids, function(nm) {
    x <- df[[nm]]; y <- x[!is.na(x)]
    r <- detrend.series(y, method = meth, make.plot = FALSE, pos.slope = TRUE,
                        return.info = TRUE, verbose = FALSE)
    r$model.info[[1]]$method
  }, character(1))
}

run_case <- function(cs) {
  out <- normalise(the.data = df,
                   detrending_select = cs$sel,
                   splinewindow = cs$spline,
                   ARmod = cs$ar,
                   logT = cs$log)
  cols <- lapply(seq_len(ncol(out)), function(j) jarr(out[[j]]))
  expected <- paste0("{\"names\":[", paste(vapply(colnames(out), jstr, character(1)), collapse = ","), "]",
                     ",\"cols\":[", paste(unlist(cols), collapse = ","), "]}")
  rm_field <- ""
  if (cs$sel %in% c(4, 6)) {
    rm_field <- paste0(",\"rmethods\":[",
                       paste(vapply(rmethods(cs$sel), jstr, character(1)), collapse = ","), "]")
  }
  fields <- c(
    paste0("\"name\":", jstr(cs$name)),
    paste0("\"sel\":", cs$sel),
    paste0("\"spline\":", cs$spline),
    paste0("\"ar\":", tolower(as.character(cs$ar))),
    paste0("\"log\":", tolower(as.character(cs$log))),
    paste0("\"expected\":", expected)
  )
  paste0("{", paste(fields, collapse = ","), rm_field, "}")
}

cases <- list(
  list(name = "m1_raw",        sel = 1, spline = 21, ar = FALSE, log = FALSE),
  list(name = "m2_zscore",     sel = 2, spline = 21, ar = FALSE, log = FALSE),
  list(name = "m3_spline",     sel = 3, spline = 21, ar = FALSE, log = FALSE),
  list(name = "m3_spline_w51", sel = 3, spline = 51, ar = FALSE, log = FALSE),
  list(name = "m4_negexp",     sel = 4, spline = 21, ar = FALSE, log = FALSE),
  list(name = "m5_friedman",   sel = 5, spline = 21, ar = FALSE, log = FALSE),
  list(name = "m6_hugershoff", sel = 6, spline = 21, ar = FALSE, log = FALSE),
  list(name = "m7_firstdiff",  sel = 7, spline = 21, ar = FALSE, log = FALSE),
  list(name = "m1_ar",         sel = 1, spline = 21, ar = TRUE,  log = FALSE),
  list(name = "m1_log",        sel = 1, spline = 21, ar = FALSE, log = TRUE),
  list(name = "m2_ar",         sel = 2, spline = 21, ar = TRUE,  log = FALSE),
  list(name = "m3_ar",         sel = 3, spline = 21, ar = TRUE,  log = FALSE),
  list(name = "m3_log",        sel = 3, spline = 21, ar = FALSE, log = TRUE),
  list(name = "m3_ar_log",     sel = 3, spline = 21, ar = TRUE,  log = TRUE),
  list(name = "m5_ar",         sel = 5, spline = 21, ar = TRUE,  log = FALSE),
  list(name = "m7_ar",         sel = 7, spline = 21, ar = TRUE,  log = FALSE)
)

objs <- vapply(cases, run_case, character(1))

input_json <- dump_input(df)
writeLines(paste0("{\"input\":", input_json, ",\"cases\":[",
                  paste(objs, collapse = ","), "]}"), outfile)
cat("wrote", outfile, "with", length(objs), "cases\n")
