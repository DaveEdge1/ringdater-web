ext <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/inst/extdata"
out <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/txtfix"
dir.create(out, showWarnings=FALSE)
# 2-column tab txt WITHOUT header (undated txt branch)
d2 <- data.frame(1473:1480, c(0.5,0.6,0.7,0.8,0.9,1.0,1.1,1.2))
write.table(d2, file.path(out,"two_col.txt"), sep="\t", row.names=FALSE, col.names=FALSE)
# multi-column tab txt WITH header (undated txt branch triggers factor reload)
d3 <- data.frame(Year=1473:1480, S_A=seq(0.5,1.2,0.1), S_B=seq(1.0,1.7,0.1))
write.table(d3, file.path(out,"multi_col.txt"), sep="\t", row.names=FALSE, col.names=TRUE, quote=FALSE)
# a dated chron txt (header) for ld_undated_chron txt branch
write.table(d3, file.path(out,"chron.txt"), sep="\t", row.names=FALSE, col.names=TRUE, quote=FALSE)
cat("done\n")

suppressWarnings(suppressMessages({library(dplR); library(stringr); library(readxl); library(magrittr)}))
PKG <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/R"
for (f in c("comb_NA_function","name_check_function","load_ring_measurer_fun",
            "load_undated_function","load_chron_function","load_data_tabs_function",
            "ld_undated_chron_function","normalise_function","whiten_function",
            "detcurves_function","readRWL_functions"))
  suppressWarnings(source(file.path(PKG, paste0(f,".R"))))
EXT <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/inst/extdata"
VIG <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater_pkg/vignettes/example_data"
TXT <- "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/txtfix"

jstr <- function(s){ if(is.null(s)||(length(s)==1&&is.na(s))) return("null")
  s<-gsub("\\\\","\\\\\\\\",s); s<-gsub("\"","\\\\\"",s)
  s<-gsub("\n","\\\\n",s); s<-gsub("\t","\\\\t",s); s<-gsub("\r","\\\\r",s); paste0("\"",s,"\"") }
jcell <- function(x){
  if(is.na(x)) return("null")
  if(is.character(x)||is.factor(x)) return(jstr(as.character(x)))
  if(is.logical(x)) return(if(x)"true" else "false")
  if(is.infinite(x)) return(if(x>0)"\"Inf\"" else "\"-Inf\"")
  format(x, digits=17, scientific=FALSE, trim=TRUE)
}
frameJSON <- function(df){
  nm <- colnames(df)
  colstr <- vapply(seq_len(ncol(df)), function(j){
    v <- df[[j]]
    paste0("[", paste(vapply(v, jcell, ""), collapse=","), "]")
  }, "")
  paste0("{\"names\":[", paste(vapply(nm, jstr, ""), collapse=","),
         "],\"cols\":[", paste(colstr, collapse=","), "]}")
}
OUT <- new.env(); KEYS <- c()
emit <- function(key, df){ assign(key, frameJSON(df), OUT); KEYS[[length(KEYS)+1]]<<-key }
run <- function(key, expr){ r <- tryCatch(expr, error=function(e){cat("ERR",key,conditionMessage(e),"\n"); NULL})
  if(!is.null(r)) emit(key, r) }

sink(tempfile())  # silence loader print()s
run("load_undated_undated_example_csv", load_undated(file.path(EXT,"undated_example.csv")))
run("load_undated_UndatedSeries_csv",   load_undated(file.path(VIG,"UndatedSeries.csv")))
run("load_undated_dated_xlsx",          load_undated(file.path(EXT,"dated_example_excel.xlsx")))
run("load_undated_two_col_txt",         load_undated(file.path(TXT,"two_col.txt")))

run("load_chron_chron_comp_1_csv",  load_chron(file.path(EXT,"chron_comp_1.csv")))
run("load_chron_chron_comp_2_csv",  load_chron(file.path(EXT,"chron_comp_2.csv")))
run("load_chron_ExampleChron_csv",  load_chron(file.path(VIG,"chronologies/ExampleChron.csv")))
run("load_chron_dated_xlsx",        load_chron(file.path(EXT,"dated_example_excel.xlsx")))

run("ld_undated_chron_xlsx",        ld_undated_chron(file.path(EXT,"undated_Chron.xlsx")))
run("ld_undated_chron_ExampleChron_csv", ld_undated_chron(file.path(VIG,"chronologies/ExampleChron.csv")))
run("ld_undated_chron_chron_txt",   ld_undated_chron(file.path(TXT,"chron.txt")))

ud <- load_undated(file.path(EXT,"undated_example.csv"))
run("load_data_tabs_undated_example", load_data_tabs(ud))
sink()

parts <- vapply(KEYS, function(k) paste0(jstr(k),":",get(k,OUT)), "")
writeLines(paste0("{", paste(parts, collapse=",\n"), "}"),
  "/tmp/claude-1000/-home-dave-ringdater/2d87fca1-cfb4-4db0-bee8-c49a5b13e67a/scratchpad/ringdater-js/test/io_csv_gt.json")
cat("KEYS:", paste(KEYS, collapse=", "), "\n")
