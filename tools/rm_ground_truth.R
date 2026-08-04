# Ground truth for src/io/ringMeasurer.js. Sources the ACTUAL ringdater
# Ring Measurer loader + combiner and emits test/rm_gt.json.  R is the oracle.
suppressWarnings(suppressMessages({library(dplR); library(stringr)}))
PKG <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
FIX <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/tools/rm_fixtures"
source(file.path(PKG, "load_ring_measurer_fun.R"))
source(file.path(PKG, "combine_RM_files_function.R"))

## ---- JSON serialization helpers -------------------------------------------
jstr <- function(s) {
  if (is.null(s) || (length(s) == 1 && is.na(s))) return("null")
  s <- gsub("\\\\", "\\\\\\\\", s)
  s <- gsub("\"", "\\\\\"", s)
  s <- gsub("\n", "\\\\n", s); s <- gsub("\t", "\\\\t", s); s <- gsub("\r", "\\\\r", s)
  paste0("\"", s, "\"")
}
jnum <- function(x) {
  if (is.null(x) || is.na(x)) return("null")
  if (is.infinite(x)) return(if (x > 0) "\"Inf\"" else "\"-Inf\"")
  format(x, digits = 17, scientific = FALSE, trim = TRUE)
}
# a single cell: number stays numeric, NA -> null, character -> quoted string
jcell <- function(x) {
  if (is.null(x) || (length(x) == 1 && is.na(x))) return("null")
  if (is.numeric(x)) return(jnum(x))
  jstr(as.character(x))
}
jstrarr <- function(v) paste0("[", paste(vapply(v, jstr, ""), collapse = ","), "]")
jcellarr <- function(v) paste0("[", paste(vapply(v, jcell, ""), collapse = ","), "]")
# a data.frame -> {names:[...], cols:[[...],...]}  (columns may be char or numeric)
jframe <- function(df) {
  if (is.null(df)) return("null")
  nm <- jstrarr(colnames(df))
  cols <- vapply(seq_len(ncol(df)), function(j) jcellarr(df[[j]]), "")
  paste0("{\"names\":", nm, ",\"cols\":[", paste(cols, collapse = ","), "]}")
}
raw_text <- function(path) readChar(path, file.info(path)$size, useBytes = TRUE)

## ---- run a single check_load case -----------------------------------------
single_case <- function(label, file, avg) {
  path <- file.path(FIX, file)
  csv <- raw_text(path)
  d <- read.csv(path, header = TRUE)   # matches combine_RM_files' read.csv(header=TRUE)
  res <- tryCatch(
    { r <- check_load_ringmeasurer_data(d, avg_series = avg); list(ok = TRUE, frame = r) },
    error = function(e) list(ok = FALSE, msg = conditionMessage(e)))
  exp <- if (res$ok) paste0("{\"kind\":\"frame\",\"frame\":", jframe(res$frame), "}")
         else paste0("{\"kind\":\"error\",\"message\":", jstr(res$msg), "}")
  paste0("{\"kind\":\"single\",\"label\":", jstr(label),
         ",\"avgSeries\":", tolower(as.character(avg)),
         ",\"csv\":", jstr(csv), ",\"expected\":", exp, "}")
}

## ---- run a combine case ----------------------------------------------------
combine_case <- function(label, subdir) {
  dir <- file.path(FIX, subdir)
  files <- list.files(dir, pattern = "\\.csv$", full.names = TRUE, recursive = TRUE)
  csvs <- vapply(files, raw_text, "")
  res <- combine_RM_files(dir)
  csvs_json <- paste0("[", paste(vapply(csvs, jstr, ""), collapse = ","), "]")
  paste0("{\"kind\":\"combine\",\"label\":", jstr(label),
         ",\"csvs\":", csvs_json,
         ",\"expected\":{\"frame\":", jframe(res$rwi),
         ",\"errors\":", length(res$errors), "}}")
}

out <- c(
  single_case("multi_series_avg",   "multi_series.csv",   TRUE),
  single_case("multi_series_noavg", "multi_series.csv",   FALSE),
  single_case("three_series_na_avg","three_series_na.csv", TRUE),
  single_case("three_series_na_noavg","three_series_na.csv", FALSE),
  single_case("char_labels_avg",    "char_labels.csv",    TRUE),
  single_case("char_labels_noavg",  "char_labels.csv",    FALSE),
  single_case("single_series_avg_ERR", "single_series.csv", TRUE),
  single_case("single_series_noavg",   "single_series.csv", FALSE),
  single_case("not_rm_passthrough", "not_rm.csv",         TRUE),
  combine_case("combine_varlen", "combine_a"),
  combine_case("combine_equal",  "combine_equal")
)
cat("[\n", paste(out, collapse = ",\n"), "\n]\n", sep = "")
