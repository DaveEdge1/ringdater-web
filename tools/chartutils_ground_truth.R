# Ground truth for src/viz/chartUtils.js: sources the ACTUAL ringdater
# functions and emits JSON consumed by test/chartutils_test.js. R is the oracle.
suppressWarnings(suppressMessages(library(dplR)))
PKG <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
source(file.path(PKG, "x_scale_bar_function.R"))
source(file.path(PKG, "y_scale_bar_function.R"))
source(file.path(PKG, "col_pal_function.R"))

jnum <- function(x) {
  if (is.null(x)) return("null")
  if (is.na(x)) return("null")
  format(x, digits = 17, scientific = FALSE, trim = TRUE)
}
jstr <- function(s) paste0("\"", s, "\"")
jnumarr <- function(v) paste0("[", paste(vapply(v, jnum, ""), collapse = ","), "]")
jstrarr <- function(v) paste0("[", paste(vapply(v, jstr, ""), collapse = ","), "]")

# ---- scale bar cases -------------------------------------------------------
# span-focused ranges to hit every bucket boundary for both x and y rules,
# plus non-integer and negative mins.
mins <- c(0, 1, -50, 100, -1000, 1785, 0.5, -3.25)
spans <- c(2, 5, 10, 15, 20, 21, 25, 40, 50, 51, 60, 90, 100, 101, 120, 200,
           250, 251, 260, 400, 500, 501, 600, 900, 1000, 1001, 1200, 2500, 5000)

out <- c()
for (mn in mins) {
  for (sp in spans) {
    mx <- mn + sp
    xb <- x.scale.bar(as.numeric(mn), as.numeric(mx))
    yb <- y.scale.bar(as.numeric(mn), as.numeric(mx))
    out <- c(out, paste0(
      "{\"fn\":\"x\",\"min\":", jnum(mn), ",\"max\":", jnum(mx),
      ",\"breaks\":", jnumarr(xb), "}"))
    out <- c(out, paste0(
      "{\"fn\":\"y\",\"min\":", jnum(mn), ",\"max\":", jnum(mx),
      ",\"breaks\":", jnumarr(yb), "}"))
  }
}

# ---- col_pal cases ---------------------------------------------------------
pal <- c()
for (s in 1:4) {
  pal <- c(pal, paste0("{\"scale\":", s, ",\"colors\":", jstrarr(col_pal(s)), "}"))
}

cat("{\n\"scalebar\":[\n", paste(out, collapse = ",\n"),
    "\n],\n\"colpal\":[\n", paste(pal, collapse = ",\n"), "\n]\n}\n", sep = "")
