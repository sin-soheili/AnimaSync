"use strict";
/* slicing.js — sprite sheet: grid slicing, auto-detect, per-frame crop.
   Part of CatSync (fork). Classic script, shares one global scope with the
   other src/ files — see ARCHITECTURE.md for why this isn't ES modules. */

/* ══════════════════════════════════════════════════════════
   1. sprite sheet: load, slice, key
   ══════════════════════════════════════════════════════════ */

/* ── the grid ────────────────────────────────────────────
   A sheet is not always W/cols × H/rows. Generated sheets come back with a
   margin around the outside, gutters between cells, or a size that simply
   doesn't divide evenly — and the old slicer refused all three. The grid is
   its own geometry now: an origin, a cell size, and a gutter. cols × rows
   only says how many cells to step through. */

function gridDims() {
  return {
    cols: clamp(parseInt($("cols").value, 10) || 1, 1, 32),
    rows: clamp(parseInt($("rows").value, 10) || 1, 1, 32),
  };
}

const cellRect = (g, c, r) => ({
  x: g.ox + c * (g.cw + g.gx),
  y: g.oy + r * (g.ch + g.gy),
  w: g.cw, h: g.ch,
});

/* Cells fill the sheet: whatever the margin and gutters leave over is split
   evenly. This is what cols / rows / gutter fall back to, so a grid never
   silently runs off the edge just because you asked for one more column. */
function fitCellsToSheet() {
  const g = S.grid, { cols, rows } = gridDims();
  const W = S.sheetImg.width, H = S.sheetImg.height;
  g.cw = Math.max(1, Math.floor((W - g.ox - g.gx * (cols - 1)) / cols));
  g.ch = Math.max(1, Math.floor((H - g.oy - g.gy * (rows - 1)) / rows));
}

function evenGrid() {
  S.grid = { ox: 0, oy: 0, cw: 1, ch: 1, gx: 0, gy: 0 };
  fitCellsToSheet();
}

function syncGridInputs() {
  const g = S.grid;
  if (!g) return;
  $("gW").value = g.cw; $("gH").value = g.ch;
  $("gX").value = g.ox; $("gY").value = g.oy;
  $("gGX").value = g.gx; $("gGY").value = g.gy;
}

/* Grid edits from the number fields. `refit` is set by the controls that
   change how much room the cells have (cols, rows, gutter) — origin and cell
   size are taken exactly as typed. */
function readGridInputs(refit) {
  if (!S.grid || !S.sheetImg) return;
  const g = S.grid;
  const W = S.sheetImg.width, H = S.sheetImg.height;
  g.ox = clamp(parseInt($("gX").value, 10) || 0, -W, W - 1);
  g.oy = clamp(parseInt($("gY").value, 10) || 0, -H, H - 1);
  g.gx = clamp(parseInt($("gGX").value, 10) || 0, 0, W);
  g.gy = clamp(parseInt($("gGY").value, 10) || 0, 0, H);
  if (refit) fitCellsToSheet();
  else {
    g.cw = clamp(parseInt($("gW").value, 10) || 1, 1, W * 2);
    g.ch = clamp(parseInt($("gH").value, 10) || 1, 1, H * 2);
  }
  syncGridInputs();
  sliceSheet();
  updateReady();
}

/* Cut one frame's canvas straight from the sheet, at whatever rect it's been
   given — the grid's cell, or a per-frame override on top of it. */
function cutFrameCanvas(R) {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(R.w));
  cv.height = Math.max(1, Math.round(R.h));
  const x = cv.getContext("2d");
  x.imageSmoothingEnabled = false;
  // A cell hanging off the sheet draws only the part that exists, in the
  // right place — drawImage clips source and destination together. So an
  // overhanging grid gives you a padded frame, not an error.
  x.drawImage(S.sheetImg, R.x, R.y, R.w, R.h, 0, 0, cv.width, cv.height);
  return cv;
}

function frameGridPos(i) {
  const { cols } = gridDims();
  return { c: i % cols, r: Math.floor(i / cols) };
}

/* One place that writes a frame's rect and re-cuts its canvas from the
   sheet — used by the numeric X/Y/W/H fields and by dragging the frame
   directly on the slice canvas, so neither can disagree with the other. */
function setFrameRect(i, x, y, w, h) {
  if (!S.sheetImg || i == null || i < 0 || !S.rects[i]) return;
  const W = S.sheetImg.width, H = S.sheetImg.height;
  const r = {
    x: clamp(Math.round(x), -W, W),
    y: clamp(Math.round(y), -H, H),
    w: clamp(Math.round(w), 1, W * 2),
    h: clamp(Math.round(h), 1, H * 2),
  };
  S.rects[i] = r;
  S.slices[i] = cutFrameCanvas(r);
  applyKey();
  syncFrameRectInputs();
  drawSliceView();
  return r;
}

/* The largest a single frame gets, across every per-frame override — used as
   the bound for the viewport and the alignment drag, so a frame that's been
   individually resized larger than the grid cell is never unreachable. */
function maxFrameExtent() {
  let w = S.cellW || 1, h = S.cellH || 1;
  for (const cv of S.slices) {
    if (cv.width > w) w = cv.width;
    if (cv.height > h) h = cv.height;
  }
  return { w, h };
}

function sliceSheet() {
  if (!S.sheetImg) return;
  const { cols, rows } = gridDims();
  const W = S.sheetImg.width, H = S.sheetImg.height;

  if (cols * rows < 2) return err("slice", "دست‌کم به ۲ فریم نیاز است. ستون‌ها و ردیف‌ها را بررسی کنید.");
  if (!S.grid) evenGrid();
  const g = S.grid;
  const cw = g.cw, ch = g.ch;

  // Grid geometry changed (this is the only path that reaches sliceSheet), so
  // the individual per-frame adjustments are rebuilt from the fresh grid —
  // pipeline: sheet → grid slicing → per-frame adjustment sits on top of THIS.
  S.rects = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) S.rects.push(cellRect(g, c, r));
  }
  S.slices = S.rects.map(cutFrameCanvas);

  // keep alignment across re-keying; only reset when the sheet really changed
  if (!S.offsets || S.offsets.length !== S.slices.length) {
    S.offsets = S.slices.map(() => ({ dx: 0, dy: 0 }));
    S.sel = 0;
  }
  if (!S.crop || S.cellW !== cw || S.cellH !== ch) {
    S.cellW = cw; S.cellH = ch;
    S.crop = { x: 0, y: 0, w: cw, h: ch };
    syncCropInputs();
  }

  syncGridInputs();
  const last = cellRect(g, cols - 1, rows - 1);
  const overW = Math.max(0, last.x + cw - W), overH = Math.max(0, last.y + ch - H);
  const leftW = W - (last.x + cw), leftH = H - (last.y + ch);
  $("gridLbl").textContent = `${cols * rows} خانه · ${cw}×${ch} px`;

  if (overW > 0 || overH > 0 || g.ox < 0 || g.oy < 0) {
    msg("slice", "work", `شبکه از لبهٔ شیت ${W}×${H} بیرون می‌زند — آن خانه‌ها ناقص در می‌آیند.`);
  } else if (leftW > 0 || leftH > 0) {
    const bits = [leftW > 0 ? `${leftW}px در سمت راست` : "", leftH > 0 ? `${leftH}px در پایین` : ""].filter(Boolean);
    msg("slice", "work", `${bits.join(" و ")} شیت زیر پوشش شبکه نیست.`);
  } else {
    clearMsg("slice");
  }

  drawSliceView();
  applyKey();
}

/* ── the sheet view: the grid drawn on the sheet, draggable ── */

let sliceZoom = 1;   // sheet px -> canvas drawing px, read by the drag wiring in app.js

function drawSliceView() {
  const cv = $("sliceCv");
  if (!S.sheetImg) { cv.hidden = true; $("sliceEmpty").style.display = ""; return; }
  cv.hidden = false;
  $("sliceEmpty").style.display = "none";

  const W = S.sheetImg.width, H = S.sheetImg.height;
  // Small sheets get an integer zoom so the cell edges are actually draggable;
  // big ones are capped and CSS shrinks them the rest of the way to the panel.
  const z = (W <= 700 && H <= 480)
    ? Math.max(1, Math.min(Math.floor(700 / W), Math.floor(480 / H)))
    : Math.min(1, 880 / W, 620 / H);
  sliceZoom = z;
  cv.width = Math.max(1, Math.round(W * z));
  cv.height = Math.max(1, Math.round(H * z));
  measure(cv);

  const x = cv.getContext("2d");
  x.imageSmoothingEnabled = z < 1;   // an honest downscale beats aliased pixels here
  x.fillStyle = "#15181d";
  x.fillRect(0, 0, cv.width, cv.height);
  x.drawImage(S.sheetImg, 0, 0, cv.width, cv.height);

  const g = S.grid;
  if (!g) return;
  const { cols, rows } = gridDims();
  const lw = Math.max(1, cv.width / 500);

  // dim everything the grid doesn't pick up — per-frame rects if any exist,
  // so a frame nudged off its cell shows where it really reads from
  const rectAt = i => S.rects[i] || cellRect(g, i % cols, Math.floor(i / cols));
  x.save();
  x.beginPath();
  x.rect(0, 0, cv.width, cv.height);
  for (let i = 0; i < cols * rows; i++) {
    const R = rectAt(i);
    x.rect(R.x * z, R.y * z, R.w * z, R.h * z);
  }
  x.fillStyle = "#0b0d10bb";
  x.fill("evenodd");
  x.restore();

  x.lineWidth = lw;
  x.font = `${Math.max(9, Math.round(cv.width / 60))}px ui-sans-serif, sans-serif`;
  x.textBaseline = "top";
  for (let i = 0; i < cols * rows; i++) {
    const R = rectAt(i);
    x.strokeStyle = i === S.sel ? "#ff4fa3" : "#4fd1c5cc";
    x.strokeRect(R.x * z + lw / 2, R.y * z + lw / 2, R.w * z - lw, R.h * z - lw);
    x.fillStyle = i === S.sel ? "#ff4fa3" : "#4fd1c5aa";
    x.fillText(String(i), R.x * z + lw * 2, R.y * z + lw * 2);
  }

  // grips on the selected frame — the thing that's actually draggable here.
  // Click any other frame to select it instead; drag empty margin to nudge
  // the whole grid's origin.
  const sel = S.rects[S.sel];
  if (sel) {
    const H = rectCorners(cv, z, sel);
    x.fillStyle = "#ff4fa3";
    for (const k2 of ["nw", "ne", "sw", "se"]) x.fillRect(H[k2].x, H[k2].y, H.s, H.s);
  }
}

/* ── auto-detect ─────────────────────────────────────────
   Read the grid off the sheet instead of asking for it: a column of pixels
   that is entirely background can't be inside a sprite, so the content runs
   between those columns are the cells. */

let sheetData = null;
function sheetPixels() {
  if (sheetData) return sheetData;
  const img = S.sheetImg;
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const x = cv.getContext("2d");
  x.imageSmoothingEnabled = false;
  x.drawImage(img, 0, 0);
  sheetData = x.getImageData(0, 0, cv.width, cv.height);
  return sheetData;
}

function runsOf(mask) {
  const out = [];
  let s = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) { if (s < 0) s = i; }
    else if (s >= 0) { out.push({ s, e: i - 1 }); s = -1; }
  }
  if (s >= 0) out.push({ s, e: mask.length - 1 });
  return out;
}

/* A gap inside a sprite — between two legs, say — splits a cell into two runs
   and would be read as two cells. Real gutters are the widest gaps on the
   sheet and roughly uniform, so anything under half the widest gap is treated
   as part of the sprite. No fixed pixel threshold: it scales with the sheet. */
function mergeRuns(runs) {
  if (runs.length < 3) return runs;
  let widest = 0;
  for (let i = 1; i < runs.length; i++) widest = Math.max(widest, runs[i].s - runs[i-1].e - 1);
  const t = widest / 2;
  const out = [{ ...runs[0] }];
  for (let i = 1; i < runs.length; i++) {
    const tail = out[out.length - 1];
    if (runs[i].s - tail.e - 1 < t) tail.e = runs[i].e;
    else out.push({ ...runs[i] });
  }
  return out;
}

/* Turn content runs into origin / cell size / gutter along one axis.
   Pitch comes from first-to-last run start, which averages out the per-cell
   drift that makes generated sheets annoying. Origin and size are then chosen
   so that every run fits inside its cell — no sprite gets clipped. */
function axisFromRuns(runs, want, limit) {
  if (!runs.length) return null;
  if (runs.length === 1) {
    // one blob: the sprites touch. Keep the count asked for and just trim the margin.
    const total = runs[0].e - runs[0].s + 1;
    return { o: runs[0].s, size: Math.max(1, Math.floor(total / want)), gap: 0, n: want, tight: false };
  }
  const n = runs.length;
  const pitch = Math.max(1, Math.round((runs[n-1].s - runs[0].s) / (n - 1)));
  let o = Infinity;
  for (let k = 0; k < n; k++) o = Math.min(o, runs[k].s - k * pitch);
  o = clamp(Math.round(o), 0, limit - 1);
  let size = 1;
  for (let k = 0; k < n; k++) size = Math.max(size, runs[k].e + 1 - (o + k * pitch));
  const tight = size > pitch;              // cells would overlap; clamp and say so
  size = Math.min(size, pitch);
  return { o, size, gap: Math.max(0, pitch - size), n, tight };
}

/* A new sheet invalidates everything downstream — the old alignment offsets
   and viewport belong to cells that no longer exist. */
function newSheet(img) {
  S.sheetImg = img;
  sheetData = null;
  S.grid = null;
  S.offsets = [];
  S.rects = [];
  S.crop = null;
  S.sel = 0;
  clearMsg("slice");
}

function fallbackGrid(why) {
  evenGrid();
  syncGridInputs();
  sliceSheet();
  msg("slice", "work", why + " برگشت به شبکهٔ یکنواخت — ستون، ردیف و اندازهٔ خانه را دستی تنظیم کنید.");
  return false;
}

function detectGrid(onLoad) {
  if (!S.sheetImg) return false;
  const d = sheetPixels(), W = d.width, H = d.height, a = d.data;
  const hex = $("key").value;
  const kr = parseInt(hex.slice(1, 3), 16),
        kg = parseInt(hex.slice(3, 5), 16),
        kb = parseInt(hex.slice(5, 7), 16);
  const inner = (parseInt($("tol").value, 10) / 100) * 441.673;
  const inner2 = inner * inner;

  const colHas = new Uint8Array(W), rowHas = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (a[i+3] < 8) continue;                       // already transparent
      const dr = a[i] - kr, dg = a[i+1] - kg, db = a[i+2] - kb;
      if (dr*dr + dg*dg + db*db <= inner2) continue;  // key colour
      colHas[x] = 1; rowHas[y] = 1;
    }
  }

  const cur = gridDims();
  const cx = axisFromRuns(mergeRuns(runsOf(colHas)), cur.cols, W);
  const cy = axisFromRuns(mergeRuns(runsOf(rowHas)), cur.rows, H);
  const bad = !cx || !cy
    ? "کل شیت به‌عنوان پس‌زمینه خوانده شد — رنگ کلید و تلورانس را در «ظاهر» بررسی کنید."
    : (cx.n * cy.n < 2)
      ? "فاصله‌ای برای بریدن پیدا نشد."
      : null;
  if (bad) {
    if (onLoad) return fallbackGrid(bad);
    err("slice", bad + " ستون، ردیف و اندازهٔ خانه را دستی تنظیم کنید، یا تلورانس را کم کنید تا فاصله‌ها به‌عنوان پس‌زمینه خوانده شوند.");
    return false;
  }

  $("cols").value = cx.n; $("rows").value = cy.n;
  S.grid = { ox: cx.o, oy: cy.o, cw: cx.size, ch: cy.size, gx: cx.gap, gy: cy.gap };
  syncGridInputs();
  sliceSheet();
  updateReady();
  const note = (cx.tight || cy.tight)
    ? " خانه‌ها به هم چسبیده بودند، پس به فاصلهٔ واقعی محدود شدند — فریم‌ها را برای نشتِ همسایه بررسی کنید."
    : "";
  msg("slice", "ok", `${cx.n}×${cy.n} خانهٔ ${cx.size}×${cy.size}px شناسایی شد` +
    ((cx.gap || cy.gap) ? ` با فاصلهٔ ${cx.gap}×${cy.gap}px.` : ".") + note);
  return true;
}
