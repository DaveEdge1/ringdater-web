# Ground truth for checks.js: sources the ACTUAL ringdater functions and emits
# JSON consumed by test/checks_test.js.  R is the oracle.
suppressWarnings(suppressMessages(library(dplR)))
PKG <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(PKG, "name_check_function.R"))
source(file.path(PKG, "loaded_data_check_function.R"))
source(file.path(PKG, "pairwise_data_check_function.R"))

# stub shinyalert so pairwise_data_check runs headless and we can capture text
LAST_ALERT <- new.env()
shinyalert <- function(title, text, type = "info", ...) {
  assign("title", title, LAST_ALERT); assign("text", text, LAST_ALERT)
  invisible(NULL)
}

## ---- JSON serialization helpers -------------------------------------------
jstr <- function(s) {
  if (is.null(s) || (length(s)==1 && is.na(s))) return("null")
  s <- gsub("\\\\", "\\\\\\\\", s)
  s <- gsub("\"", "\\\\\"", s)
  s <- gsub("\n", "\\\\n", s); s <- gsub("\t", "\\\\t", s); s <- gsub("\r", "\\\\r", s)
  paste0("\"", s, "\"")
}
jnum <- function(x) {
  if (is.null(x)) return("null")
  if (is.na(x)) return("null")
  if (is.infinite(x)) return(if (x > 0) "\"Inf\"" else "\"-Inf\"")
  format(x, digits = 17, scientific = FALSE, trim = TRUE)
}
jstrarr <- function(v) paste0("[", paste(vapply(v, jstr, ""), collapse = ","), "]")
jnumarr <- function(v) paste0("[", paste(vapply(v, jnum, ""), collapse = ","), "]")
# a data.frame -> {names:[...], cols:[[...],...]}
jframe <- function(df) {
  if (is.null(df)) return("null")
  nm <- jstrarr(colnames(df))
  cols <- vapply(seq_len(ncol(df)), function(j) jnumarr(df[[j]]), "")
  paste0("{\"names\":", nm, ",\"cols\":[", paste(cols, collapse = ","), "]}")
}

## ---- input construction ----------------------------------------------------
# build a data.frame with arbitrary (possibly duplicate) colnames + numeric data
mkdf <- function(names, cols) {
  m <- as.data.frame(cols, stringsAsFactors = FALSE)
  colnames(m) <- names
  m
}

cases <- list()
add <- function(fn, label, df, nonframe = FALSE) {
  cases[[length(cases) + 1]] <<- list(fn = fn, label = label, df = df, nonframe = nonframe)
}

## ===== nameCheck cases (data + colnames; only names matter) =================
nc_names <- list(
  c("year", "series 1", "2sample", "x_tree", "series 1"),
  c("year", "a.b", "a b", "a-b", "a__b"),
  c("increment", ".foo", ".5depth", "_leading", "5x"),
  c("yr", "if", "TRUE", "NA", "NULL", "function"),
  c("year", "X", "x", "xtree", "Xtree"),
  c("t", "café", "naïve", "a b c", "a...b"),
  c("year", "dup", "dup", "dup", "dup.1"),
  c("only_one_col"),
  c("Year", "@weird#name!", "123", "  spaced  ", "tab\there")
)
for (i in seq_along(nc_names)) {
  nms <- nc_names[[i]]
  cols <- lapply(seq_along(nms), function(j) as.numeric(seq_along(nms) + j))
  add("nameCheck", paste0("nc", i), mkdf(nms, cols))
}

## ===== loadedDataCheck / pairwiseDataCheck cases ============================
# helper to build year+series data.frames
ld <- function(...) {
  args <- list(...)
  mkdf(names(args), args)
}
# 0: clean contiguous
add("loadedDataCheck", "ld_clean",
    ld(year = 1:10, s1 = c(NA,NA,3,4,5,6,7,NA,NA,NA), s2 = c(NA,2,3,4,5,6,7,8,9,10)))
# 2: interior missing value in a series
add("loadedDataCheck", "ld_interior_na",
    ld(year = 1:8, s1 = c(1,2,NA,4,5,6,7,8), s2 = c(1,2,3,4,5,6,7,8)))
# 1: NA in the year column where a series has data
add("loadedDataCheck", "ld_year_na",
    ld(year = c(1,2,NA,4,5), s1 = c(10,20,30,40,50)))
# all-NA series should be skipped (still 0)
add("loadedDataCheck", "ld_allna_series",
    ld(year = 1:6, s1 = c(NA,NA,NA,NA,NA,NA), s2 = c(1,2,3,4,5,6)))
# single row overlaps
add("loadedDataCheck", "ld_offset",
    ld(year = 2000:2010,
       s1 = c(1,2,3,4,5,NA,NA,NA,NA,NA,NA),
       s2 = c(NA,NA,NA,NA,NA,NA,7,8,9,10,11)))

# pairwise cases (reuse some shapes)
add("pairwiseDataCheck", "pw_clean",
    ld(year = 1:10, s1 = c(NA,NA,3,4,5,6,7,NA,NA,NA), s2 = c(NA,2,3,4,5,6,7,8,9,10)))
add("pairwiseDataCheck", "pw_wrong_dir",
    ld(year = 10:1, s1 = as.numeric(1:10), s2 = as.numeric(1:10)))
add("pairwiseDataCheck", "pw_interior_na",
    ld(year = 1:8, s1 = c(1,2,NA,4,5,6,7,8), s2 = c(1,2,3,4,5,6,7,8)))
add("pairwiseDataCheck", "pw_year_na",
    ld(year = c(1,2,NA,4,5), s1 = c(10,20,30,40,50), s2 = c(1,2,3,4,5)))
add("pairwiseDataCheck", "pw_trim",
    ld(year = 1990:2005,
       s1 = c(rep(NA,3), 1:8, rep(NA,5)),
       s2 = c(rep(NA,5), 1:6, rep(NA,5))))

## ===== error-path cases =====================================================
# insufficient data (1 column)
add("loadedDataCheck",   "ld_one_col",  ld(year = 1:5))
add("pairwiseDataCheck", "pw_one_col",  ld(year = 1:5))
# not a data.frame (pass a bare numeric vector)
add("nameCheck",         "nc_nonframe", 1:5, nonframe = TRUE)
add("loadedDataCheck",   "ld_nonframe", 1:5, nonframe = TRUE)
add("pairwiseDataCheck", "pw_nonframe", 1:5, nonframe = TRUE)

## ---- run + serialize -------------------------------------------------------
out <- c()
for (cs in cases) {
  df <- cs$df
  res <- tryCatch({
    if (cs$fn == "nameCheck") {
      r <- name_check(df)
      list(kind = "names", val = colnames(r))
    } else if (cs$fn == "loadedDataCheck") {
      r <- loaded_data_check(df)
      list(kind = "code", val = r)
    } else {
      r <- pairwise_data_check(df)
      list(kind = "pw", val = r,
           title = if (exists("title", LAST_ALERT)) get("title", LAST_ALERT) else NULL,
           text  = if (exists("text",  LAST_ALERT)) get("text",  LAST_ALERT) else NULL)
    }
  }, error = function(e) list(kind = "error", val = conditionMessage(e)))
  # clear alert env between cases
  if (exists("title", LAST_ALERT)) rm("title", envir = LAST_ALERT)
  if (exists("text",  LAST_ALERT)) rm("text",  envir = LAST_ALERT)

  inp <- if (isTRUE(cs$nonframe)) "{\"nonframe\":true}" else jframe(df)
  if (res$kind == "names") {
    exp <- paste0("{\"kind\":\"names\",\"names\":", jstrarr(res$val), "}")
  } else if (res$kind == "code") {
    exp <- paste0("{\"kind\":\"code\",\"code\":", jnum(res$val), "}")
  } else if (res$kind == "error") {
    exp <- paste0("{\"kind\":\"error\",\"message\":", jstr(res$val), "}")
  } else { # pw
    r <- res$val
    if (is.null(r)) {
      exp <- paste0("{\"kind\":\"pw\",\"data\":null,\"title\":", jstr(res$title),
                    ",\"text\":", jstr(res$text), "}")
    } else {
      exp <- paste0("{\"kind\":\"pw\",\"data\":", jframe(r),
                    ",\"title\":null,\"text\":null}")
    }
  }
  out <- c(out, paste0("{\"fn\":", jstr(cs$fn), ",\"label\":", jstr(cs$label),
                       ",\"input\":", inp, ",\"expected\":", exp, "}"))
}
cat("[\n", paste(out, collapse = ",\n"), "\n]\n", sep = "")
