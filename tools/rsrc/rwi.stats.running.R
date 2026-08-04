function (rwi, ids = NULL, period = c("max", "common"), method = c("spearman", 
    "pearson", "kendall"), prewhiten = FALSE, n = NULL, running.window = TRUE, 
    window.length = min(50, nrow(rwi)), window.overlap = floor(window.length/2), 
    first.start = NULL, min.corr.overlap = min(30, window.length), 
    round.decimals = 3, zero.is.missing = TRUE) 
{
    period2 <- match.arg(period)
    method2 <- match.arg(method)
    if (running.window) {
        if (window.length < 3) {
            stop("minimum 'window.length' is 3")
        }
        window.advance <- window.length - window.overlap
        if (window.advance < 1) {
            stop(gettextf("'window.overlap' is too large, max value is 'window.length'-1 (%d)", 
                window.length - 1))
        }
        if (window.length < min.corr.overlap) {
            stop("'window.length' is smaller than 'min.corr.overlap'")
        }
    }
    if (mean(unlist(rwi), na.rm = TRUE) <= 0) {
        stop("'rwi' has a non-positive grand mean (mean(unlist(rwi), na.rm=TRUE)), which will cause normalize1() to return incorrect rbar and eps values. This can happen when 'rwi' has been detrended using difference=TRUE, which produces first differences rather than ring widths. To fix this, pass a shifted version of 'rwi' directly into the function call, e.g. rwi.stats.running(rwi + 1, ...). Avoid overwriting your rwi object in your workspace as this can cause problems downstream.", 
            call. = FALSE)
    }
    tmp <- normalize1(rwi, n, prewhiten)
    if (!all(tmp$idx.good)) {
        warning("after prewhitening, 'rwi' contains column(s) without at least four observations", 
            call. = FALSE)
        cat(gettext("note that there is no error checking on column lengths if filtering is not performed\n", 
            domain = "R-dplR"))
    }
    rwi2 <- as.matrix(tmp$rwi.mat)
    n.cores <- ncol(rwi2)
    zero.flag <- rwi2 == 0
    if (any(zero.flag, na.rm = TRUE)) {
        if (!zero.is.missing) {
            warning("There are zeros in the data. Consider the option 'zero.is.missing'.")
        }
        else {
            rwi2[zero.flag] <- NA
        }
    }
    if (is.null(ids)) {
        ids3 <- data.frame(tree = seq_len(n.cores), core = rep.int(1, 
            n.cores))
        rwi3 <- rwi2
    }
    else {
        if (!is.data.frame(ids) || !all(c("tree", "core") %in% 
            names(ids))) {
            stop("'ids' must be a data.frame with columns 'tree' and 'core'")
        }
        if (!all(vapply(ids, is.numeric, TRUE))) {
            stop("'ids' must have numeric columns")
        }
        colnames.rwi <- colnames(rwi2)
        rownames.ids <- row.names(ids)
        if (!is.null(rownames.ids) && all(colnames.rwi %in% rownames.ids)) {
            ids2 <- ids[colnames.rwi, c("tree", "core")]
        }
        else if (nrow(ids) == n.cores) {
            ids2 <- ids[c("tree", "core")]
        }
        else {
            stop("dimension problem: ", "'ncol(rwi)' != 'nrow(ids)'")
        }
        row.names(ids2) <- NULL
        unique.ids <- unique(ids2)
        n.unique <- nrow(unique.ids)
        if (n.unique < n.cores) {
            ids3 <- unique.ids
            rwi3 <- matrix(data = as.numeric(NA), nrow = nrow(rwi2), 
                ncol = n.unique, dimnames = list(rownames(rwi2)))
            for (i in seq_len(n.unique)) {
                these.cols <- row.match(ids2, unique.ids[i, ])
                rwi3[, i] <- rowMeans(rwi2[, these.cols, drop = FALSE], 
                  na.rm = TRUE)
            }
            message("Series with matching tree/core IDs have been averaged")
        }
        else {
            ids3 <- ids2
            rwi3 <- rwi2
        }
    }
    rwiNotNA <- !is.na(rwi3)
    n.years <- nrow(rwi3)
    if (running.window && window.length > n.years) {
        stop("'window.length' is larger than the number of years in 'rwi'")
    }
    treeIds <- ids3$tree
    unique.trees <- unique(treeIds)
    n.trees <- length(unique.trees)
    if (n.trees < 2) {
        stop("at least 2 trees are needed")
    }
    cores.of.tree <- list()
    seq.tree <- seq_len(n.trees)
    for (i in seq.tree) {
        cores.of.tree[[i]] <- which(treeIds == unique.trees[i])
    }
    tree.any <- matrix(FALSE, n.years, n.trees)
    for (i in seq.tree) {
        tree.any[, i] <- rowAnys(rwiNotNA, cols = treeIds == 
            unique.trees[i])
    }
    n.trees.by.year <- rowSums(tree.any)
    if (period2 == "common") {
        bad.rows <- !rowAlls(rwiNotNA)
        rwi3[bad.rows, ] <- NA
        rwiNotNA[bad.rows, ] <- FALSE
        good.rows.flag <- !bad.rows
        period.common <- TRUE
    }
    else {
        good.rows.flag <- n.trees.by.year > 1
        period.common <- FALSE
    }
    good.rows <- which(good.rows.flag)
    if (length(good.rows) < min.corr.overlap) {
        stop("too few years with enough trees for correlation calculations")
    }
    if (running.window) {
        if (is.numeric(first.start)) {
            if (first.start < 1) {
                stop("'first.start' too small, must be >= 1")
            }
            else if (first.start > n.years - window.length + 
                1) {
                stop("'first.start' too large")
            }
            first.start2 <- first.start
        }
        else {
            min.offset <- max(0, min(good.rows) - (window.length - 
                min.corr.overlap) - 1)
            max.offset <- min(min.offset + window.advance - 1, 
                n.years - window.length)
            offsets <- min.offset:max.offset
            n.offsets <- length(offsets)
            n.data <- rep.int(NA_real_, n.offsets)
            for (i in seq_len(n.offsets)) {
                offset <- offsets[i]
                n.windows.minusone <- (n.years - offset - window.length)%/%window.advance
                max.idx <- offset + window.length + n.windows.minusone * 
                  window.advance
                rowIdx <- seq(1 + offset, max.idx)
                n.data[i] <- sum(rwiNotNA[rowIdx[good.rows.flag[rowIdx]], 
                  ])
            }
            first.start2 <- offsets[n.offsets - which.max(rev(n.data)) + 
                1] + 1
        }
        window.start <- seq(from = first.start2, to = n.years - 
            window.length + 1, by = window.advance)
        window.length2 <- window.length
    }
    else {
        window.start <- 1
        window.length2 <- n.years
    }
    all.years <- as.numeric(rownames(rwi3))
    loop.body <- function(s.idx) {
        rbar.tot <- NA_real_
        rbar.wt <- NA_real_
        rbar.bt <- NA_real_
        start.year <- all.years[s.idx]
        e.idx <- s.idx + window.length2 - 1
        end.year <- all.years[e.idx]
        mid.year <- floor((start.year + end.year)/2)
        year.idx <- s.idx:e.idx
        rsum.bt <- 0
        n.bt <- 0
        good.flag <- rep.int(FALSE, n.trees)
        for (i in seq_len(n.trees - 1)) {
            i.data <- rwi3[year.idx, cores.of.tree[[i]], drop = FALSE]
            for (j in (i + 1):n.trees) {
                j.data <- rwi3[year.idx, cores.of.tree[[j]], 
                  drop = FALSE]
                bt.r.mat <- cor.with.limit(min.corr.overlap, 
                  i.data, j.data, method = method2)
                bt.r.mat <- bt.r.mat[!is.na(bt.r.mat)]
                n.bt.temp <- length(bt.r.mat)
                if (n.bt.temp > 0) {
                  rsum.bt <- rsum.bt + sum(bt.r.mat)
                  n.bt <- n.bt + n.bt.temp
                  good.flag[c(i, j)] <- TRUE
                }
            }
        }
        good.trees <- which(good.flag)
        rsum.wt <- 0
        n.wt <- 0
        n.cores.tree <- rep.int(NA_real_, n.trees)
        for (i in good.trees) {
            these.cores <- cores.of.tree[[i]]
            if (length(these.cores) == 1) {
                n.cores.tree[i] <- 1
            }
            else {
                these.data <- rwi3[year.idx, these.cores, drop = FALSE]
                wt.r.vec <- cor.with.limit.upper(min.corr.overlap, 
                  these.data, method = method2)
                wt.r.vec <- wt.r.vec[!is.na(wt.r.vec)]
                n.wt.temp <- length(wt.r.vec)
                if (n.wt.temp > 0) {
                  rsum.wt <- rsum.wt + sum(wt.r.vec)
                  n.wt <- n.wt + n.wt.temp
                  n.cores.tree[i] <- 0.5 + sqrt(0.25 + 2 * n.wt.temp)
                }
                else {
                  n.cores.tree[i] <- 1
                }
            }
        }
        n.tot <- n.wt + n.bt
        if (n.tot > 0) {
            rbar.tot <- (rsum.wt + rsum.bt)/n.tot
        }
        if (n.wt > 0) {
            rbar.wt <- rsum.wt/n.wt
        }
        if (n.bt > 0) {
            rbar.bt <- rsum.bt/n.bt
        }
        coresPresent <- which(colAnys(rwiNotNA, rows = year.idx))
        treesPresent <- unique(treeIds[coresPresent])
        nCores <- length(coresPresent)
        nTrees <- length(treesPresent)
        n <- length(good.trees)
        if (n.wt == 0) {
            if (n.bt > 0) {
                c.eff <- 1
            }
            else {
                c.eff <- 0
            }
            rbar.eff <- rbar.bt
        }
        else {
            nCoresTree <- na.omit(n.cores.tree)
            uniqueNC <- unique(nCoresTree)
            if (length(uniqueNC) == 1) {
                c.eff <- uniqueNC
                rbar.eff <- rbar.bt/(rbar.wt + (1 - rbar.wt)/c.eff)
            }
            else {
                c.eff.rproc <- mean(1/nCoresTree)
                c.eff <- 1/c.eff.rproc
                rbar.eff <- rbar.bt/(rbar.wt + (1 - rbar.wt) * 
                  c.eff.rproc)
            }
        }
        eps <- n * rbar.eff/((n - 1) * rbar.eff + 1)
        snr <- n * rbar.eff/(1 - rbar.eff)
        if (running.window) {
            out <- c(start.year = start.year, mid.year = mid.year, 
                end.year = end.year)
        }
        else {
            out <- numeric(0)
        }
        c(out, n.cores = nCores, n.trees = nTrees, n = n, n.tot = n.tot, 
            n.wt = n.wt, n.bt = n.bt, rbar.tot = rbar.tot, rbar.wt = rbar.wt, 
            rbar.bt = rbar.bt, c.eff = c.eff, rbar.eff = rbar.eff, 
            eps = eps, snr = snr)
    }
    if (running.window && !inherits(try(suppressWarnings(req.fe <- requireNamespace("foreach", 
        quietly = TRUE)), silent = TRUE), "try-error") && req.fe) {
        exportFun <- c("<-", "+", "-", "floor", ":", "rep.int", 
            "for", "seq_len", "[", "[[", "cor.with.limit", "!", 
            "is.na", "length", "if", ">", "sum", "c", "[<-", 
            "which", "==", "cor.with.limit.upper", "sqrt", "*", 
            "/", "(", "{", "mean")
        compos.stats <- foreach::"%dopar%"(foreach::foreach(s.idx = window.start, 
            .combine = "rbind", .export = exportFun), loop.body(s.idx))
    }
    else {
        compos.stats <- NULL
        for (s.idx in window.start) {
            compos.stats <- rbind(compos.stats, loop.body(s.idx))
        }
    }
    rownames(compos.stats) <- NULL
    if (is.numeric(round.decimals) && length(round.decimals) > 
        0 && is.finite(round.decimals[1]) && round.decimals[1] >= 
        0) {
        data.frame(round(compos.stats, round.decimals[1]))
    }
    else {
        data.frame(compos.stats)
    }
}
