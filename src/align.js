"use strict";
/* align.js — onion-skin alignment: per-frame offsets, drag, auto-align.
   Part of CatSync (fork). Classic script, shares one global scope with the
   other src/ files — see ARCHITECTURE.md for why this isn't ES modules. */

/* ══════════════════════════════════════════════════════════
   4b. alignment — onion skin
   Image models can't hold a sprite pixel-identical across cells,
   so cells come back shifted. Nudge them here instead of
   round-tripping through a pixel editor.
   ══════════════════════════════════════════════════════════ */

let alignZoom = 4;

function refIndexFor(i) {
  if (i <= 0) return -1;
  return $("refMode").value === "prev" ? i - 1 : 0;
}

function selectFrame(i) {
  S.sel = clamp(i, 0, S.keyed.length - 1);
  drawThumbs();
  renderAlign();
  drawSliceView();   // highlight which cell on the sheet you're looking at
  syncFrameRectInputs();
}

/* ── independent per-frame crop ───────────────────────────────────────
   Grid slicing gives every cell the same size; a generated sheet rarely
   comes back that uniform. This is the per-frame override on top of it —
   its own rect, cut straight from the sheet, that alignment, the viewport,
   playback and every export all read from same as any other slice. */

function syncFrameRectInputs() {
  const r = S.rects[S.sel];
  if (!r) return;
  $("frX").value = r.x; $("frY").value = r.y;
  $("frW").value = r.w; $("frH").value = r.h;
}

function readFrameRectInputs() {
  if (!S.sheetImg || !S.rects[S.sel]) return;
  setFrameRect(S.sel,
    parseInt($("frX").value, 10) || 0,
    parseInt($("frY").value, 10) || 0,
    parseInt($("frW").value, 10) || 1,
    parseInt($("frH").value, 10) || 1);
}

function resetFrameRect() {
  const { c, r } = frameGridPos(S.sel);
  const rect = cellRect(S.grid, c, r);
  setFrameRect(S.sel, rect.x, rect.y, rect.w, rect.h);
}

function renderAlign() {
  const cv = $("alignCv");
  if (!S.keyed.length) { cv.hidden = true; $("alignEmpty").style.display = ""; return; }

  const cur = S.keyed[S.sel];
  const sw = cur.width, sh = cur.height;
  alignZoom = Math.max(1, Math.floor(Math.min(360 / sw, 230 / sh))) || 1;

  cv.hidden = false;
  $("alignEmpty").style.display = "none";
  cv.width = sw * alignZoom;
  cv.height = sh * alignZoom;
  measure(cv);

  const x = cv.getContext("2d");
  x.imageSmoothingEnabled = false;
  x.fillStyle = "#15181d";
  x.fillRect(0, 0, cv.width, cv.height);

  const ri = refIndexFor(S.sel);
  const o = off(S.sel);
  const mode = $("onionMode").value;
  const opa = parseInt($("onionOp").value, 10) / 100;

  if (ri >= 0) {
    const ro = off(ri);
    x.globalAlpha = mode === "diff" ? 1 : opa;
    x.drawImage(S.keyed[ri], ro.dx * alignZoom, ro.dy * alignZoom, cv.width, cv.height);
    x.globalAlpha = 1;
  }

  if (mode === "diff" && ri >= 0) x.globalCompositeOperation = "difference";
  x.drawImage(cur, o.dx * alignZoom, o.dy * alignZoom, cv.width, cv.height);
  x.globalCompositeOperation = "source-over";

  // centre guides — easier to spot a body that drifted sideways
  x.strokeStyle = "#ffffff14"; x.lineWidth = 1;
  x.beginPath();
  x.moveTo(cv.width / 2, 0); x.lineTo(cv.width / 2, cv.height);
  x.moveTo(0, cv.height / 2); x.lineTo(cv.width, cv.height / 2);
  x.stroke();

  // the exported viewport — drag any edge or corner of it to reshape the cut
  if (S.crop) drawCutGuide(x, cv, alignZoom, sw, sh);

  $("selLbl").textContent = ri < 0 ? `${S.sel} · مرجع` : `${S.sel} در برابر ${ri}`;
  $("offLbl").innerHTML = `dx ${o.dx} &nbsp; dy ${o.dy}` +
    ($("moveAll").checked ? ` <span style="color:var(--dim)">· همه</span>` : "");
  // Only auto-align needs a reference frame. Moving is always allowed.
  $("autoOne").disabled = ri < 0;
}

/* ── dragging the cut ─────────────────────────────────────
   The viewport can be dragged on two surfaces: the align canvas, where it sits
   next to the onion skin, and the preview, where you can reframe against the
   animation as it plays. Both are sprite pixels drawn at some integer zoom, so
   they share all of this and differ only in that zoom and in what a drag
   *outside* the cut means. */

/* How many canvas pixels one CSS pixel is. Measured rather than assumed,
   because both canvases keep their full resolution and are scaled down by CSS
   to fit. Cached: drawFrameAt runs every animation frame and a layout read in
   that loop is not free. Pointer handlers re-measure, since they're user-paced
   and being right matters more there. */
const pxRatio = new WeakMap();
function measure(cv) {
  const r = cv.getBoundingClientRect();
  pxRatio.set(cv, cv.width / (r.width || cv.width));
  return pxRatio.get(cv);
}
const ratioOf = cv => pxRatio.get(cv) || 1;

/* A small draggable-rect toolkit — four corner grips, edge-drag to resize,
   body-drag (or shift-drag) to move. Originally built just for the export
   viewport; generalized so the same gestures work for whichever frame is
   selected on the slice canvas, without keeping two copies of this math. */

/* Four corner grips, in canvas pixels. Sized off how big the canvas is
   actually being displayed, so a grip stays about 9px on screen whether a
   48px sprite is zoomed 4x or a 1024px one is scaled down to fit. Kept
   inside the canvas too: a rect larger than the canvas has corners off in
   space, and without this there'd be nothing left to grab. */
function rectCorners(cv, zoom, rect) {
  const s = 9 * ratioOf(cv);
  const L = rect.x * zoom, T = rect.y * zoom;
  const R = (rect.x + rect.w) * zoom, B = (rect.y + rect.h) * zoom;
  const put = (x, y) => ({
    x: clamp(x, 0, Math.max(0, cv.width - s)),
    y: clamp(y, 0, Math.max(0, cv.height - s)),
  });
  return { s, nw: put(L, T), ne: put(R - s, T), sw: put(L, B - s), se: put(R - s, B - s) };
}

/* Draw a rect as a guide: dim what falls outside it (only worth doing when
   it differs from some reference size — the whole cell, say), outline it,
   and mark the four grips. */
function drawRectGuide(x, cv, zoom, rect, refW, refH, color) {
  const rx = rect.x * zoom, ry = rect.y * zoom, rw = rect.w * zoom, rh = rect.h * zoom;
  if (refW != null && (rect.x !== 0 || rect.y !== 0 || rect.w !== refW || rect.h !== refH)) {
    x.save();
    x.beginPath();
    x.rect(0, 0, cv.width, cv.height);
    x.rect(rx, ry, rw, rh);
    x.fillStyle = "#0b0d10aa";
    x.fill("evenodd");
    x.restore();
  }
  x.strokeStyle = color;
  x.lineWidth = Math.max(1, Math.round(ratioOf(cv)));
  x.strokeRect(rx + .5, ry + .5, rw - 1, rh - 1);
  const H = rectCorners(cv, zoom, rect);
  x.fillStyle = color;
  for (const k of ["nw", "ne", "sw", "se"]) x.fillRect(H[k].x, H[k].y, H.s, H.s);
}

function drawCutGuide(x, cv, zoom, cellW, cellH) {
  drawRectGuide(x, cv, zoom, S.crop, cellW, cellH, "#4fd1c5");
}

/* Which part of a rect a point lands on, and for a resize, which sides it
   grabbed. Corner grips are tested first and in canvas pixels, because they
   get clamped into view — the edges they belong to may be off-canvas.
   `bodyMove`: a hit inside the rect but not on any edge normally falls
   through to "outside" — the viewport crop sits over a sprite that's worth
   reaching underneath. A frame on the slice canvas has nothing underneath
   worth reaching, so it gets `bodyMove: true` and a body-drag just moves it. */
function rectHit(cv, zoom, rect, e, bodyMove) {
  if (!rect) return { kind: "outside" };
  const r = cv.getBoundingClientRect();
  const zx = measure(cv);
  const cx = (e.clientX - r.left) * zx, cy = (e.clientY - r.top) * zx;
  const H = rectCorners(cv, zoom, rect);
  const inGrip = q => cx >= q.x && cx <= q.x + H.s && cy >= q.y && cy <= q.y + H.s;
  for (const [k, f] of [["nw", { n: 1, w: 1 }], ["ne", { n: 1, e: 1 }],
                        ["sw", { s: 1, w: 1 }], ["se", { s: 1, e: 1 }]]) {
    if (inGrip(H[k])) return e.shiftKey ? { kind: "move" } : { kind: "resize", ...f };
  }

  const k = zx / zoom;                           // css px -> content px
  const px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k;
  const tol = 9 * k;                              // same grab area as a grip
  const dL = Math.abs(px - rect.x), dR = Math.abs(px - (rect.x + rect.w));
  const dT = Math.abs(py - rect.y), dB = Math.abs(py - (rect.y + rect.h));
  const onBox = px >= rect.x - tol && px <= rect.x + rect.w + tol
             && py >= rect.y - tol && py <= rect.y + rect.h + tol;
  if (!onBox) return { kind: "outside" };
  // on a rect only a pixel or two wide both edges are in reach — take the
  // nearer, or dragging one would fight the other
  const w = dL <= tol && dL <= dR, ee = dR <= tol && dR < dL;
  const n = dT <= tol && dT <= dB, s = dB <= tol && dB < dT;
  if (!(w || ee || n || s)) return (bodyMove || e.shiftKey) ? { kind: "move" } : { kind: "outside" };
  return e.shiftKey ? { kind: "move" } : { kind: "resize", w, e: ee, n, s };
}

function cutHit(cv, zoom, e) {
  if (!S.crop || !S.keyed.length) return { kind: "outside" };
  return rectHit(cv, zoom, S.crop, e, false);
}

function cursorForCut(h) {
  if (h.kind === "move") return "move";
  if (h.kind !== "resize") return "";
  if ((h.n && h.w) || (h.s && h.e)) return "nwse-resize";
  if ((h.n && h.e) || (h.s && h.w)) return "nesw-resize";
  return (h.w || h.e) ? "ew-resize" : "ns-resize";
}

/* Worked as four edges rather than x/y/w/h: dragging the left edge must leave
   the right one exactly where it is, and clamping x and w separately would
   slide it. An edge is stopped one pixel short of its opposite instead of
   being allowed through into a mirrored rect. `bounds()` gives the clamp
   range and `commit(x,y,w,h)` writes the result back wherever it belongs. */
function applyRectDrag(mode, start, ddx, ddy, bounds, commit) {
  if (mode.kind === "move") {
    commit(start.x + ddx, start.y + ddy, start.w, start.h);
    return;
  }
  const { w: cw, h: ch } = bounds();
  let l = start.x, t = start.y, r = start.x + start.w, b = start.y + start.h;
  if (mode.w) l = clamp(l + ddx, -cw, r - 1);
  if (mode.e) r = clamp(r + ddx, l + 1, l + cw * 3);
  if (mode.n) t = clamp(t + ddy, -ch, b - 1);
  if (mode.s) b = clamp(b + ddy, t + 1, t + ch * 3);
  commit(l, t, r - l, b - t);
}

function applyCutDrag(mode, start, ddx, ddy) {
  applyRectDrag(mode, start, ddx, ddy, maxFrameExtent, setCrop);
}

/* `other` is what a drag that misses the cut does on this surface — the align
   canvas moves the sprite, the preview does nothing. */
function wireCutDrag(cv, zoomOf, enabled, other) {
  let mode = null, sx = 0, sy = 0, startCrop = null, startOther = null;
  let cursor = null;
  const setCursor = c => { if (c !== cursor) { cv.style.cursor = c; cursor = c; } };
  const hit = e => (enabled() ? cutHit(cv, zoomOf(), e) : { kind: "outside" });

  cv.addEventListener("pointerdown", e => {
    mode = hit(e);
    if (mode.kind === "outside" && !other) { mode = null; return; }
    setCursor(mode.kind === "outside" ? (other.cursor || "") : cursorForCut(mode));
    cv.setPointerCapture(e.pointerId);
    sx = e.clientX; sy = e.clientY;
    startCrop = S.crop ? { ...S.crop } : null;
    startOther = mode.kind === "outside" && other ? other.start() : null;
    if (cv.focus) cv.focus();
  });

  cv.addEventListener("pointermove", e => {
    if (!mode) { setCursor(cursorForCut(hit(e))); return; }   // show what grabbing here would do
    const k = ratioOf(cv) / zoomOf();                          // css px -> sprite px
    const ddx = Math.round((e.clientX - sx) * k);
    const ddy = Math.round((e.clientY - sy) * k);
    if (mode.kind === "outside") other.move(startOther, ddx, ddy);
    else if (startCrop) applyCutDrag(mode, startCrop, ddx, ddy);
  });

  const end = () => {
    if (!mode) return;
    const wasCut = mode.kind !== "outside";
    mode = null;
    setCursor("");
    if (wasCut) afterCutChange();
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("pointerleave", () => { if (!mode) setCursor(""); });
}

/* Keep a frame reachable — dragged far enough it leaves the cell entirely and
   there's nothing left on screen to grab. */
function clampOffset(o) {
  const { w, h } = maxFrameExtent();
  o.dx = clamp(o.dx, -w, w);
  o.dy = clamp(o.dy, -h, h);
  return o;
}

/* Every frame can be moved, frame 0 included. It's still the alignment
   reference, but locking it meant a sprite clipped by the viewport edge could
   never be pulled back into frame. */
function nudge(dx, dy) {
  const all = $("moveAll").checked;
  S.offsets.forEach((o, i) => {
    if (!all && i !== S.sel) return;
    o.dx += dx; o.dy += dy;
    clampOffset(o);
  });
  afterOffsetChange();
}

function afterOffsetChange() {
  drawThumbs();
  renderAlign();
  drawFrameAt(currentFrame());
}

/* cached pixels for auto-align, dropped whenever keying changes */
let idCache = new Map();
function pixelsOf(i) {
  if (idCache.has(i)) return idCache.get(i);
  const cv = S.keyed[i];
  const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height);
  idCache.set(i, d);
  return d;
}

/* The search cost is (2R+1)² × pixels, which explodes on a high-resolution
   sheet — a 1024px sprite would freeze the tab. So run the search on a
   downscaled copy and scale the answer back up. Precision ends up relative
   to sprite size rather than absolute, which is what actually matters:
   1px out of 48 and 4px out of 1024 look identical on screen. Small sprites
   are untouched (factor 1) and stay pixel-exact. */
const WORK_MAX = 192;
let workCache = new Map();
function workOf(i) {
  if (workCache.has(i)) return workCache.get(i);
  const src = S.keyed[i];
  const f = Math.max(1, Math.ceil(Math.max(src.width, src.height) / WORK_MAX));
  let data;
  if (f === 1) {
    data = pixelsOf(i);
  } else {
    const w = Math.max(1, Math.round(src.width / f)), h = Math.max(1, Math.round(src.height / f));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const x = cv.getContext("2d");
    x.imageSmoothingEnabled = true;      // averaging is what we want for correlation
    x.drawImage(src, 0, 0, w, h);
    data = x.getImageData(0, 0, w, h);
  }
  const out = { data, f };
  workCache.set(i, out);
  return out;
}

/* how far to look, as a fraction of sprite size */
function searchRadius(i) {
  const s = S.keyed[i];
  return clamp(Math.round(Math.max(s.width, s.height) * 0.06), 12, 48);
}

/* Search a small window for the shift that best matches the reference.
   Alpha is weighted heavily — the silhouette is what has to line up, and
   the mouth is the one part that's legitimately allowed to differ. */
function bestShift(curI, refI, R) {
  const A = workOf(curI), B = workOf(refI);
  const f = A.f;
  const Ad = A.data, Bd = B.data;
  const w = Ad.width, h = Ad.height, a = Ad.data, b = Bd.data;
  const Rr = Math.max(2, Math.round(R / f));      // radius in working pixels
  let best = { rx: 0, ry: 0, score: Infinity };

  for (let ry = -Rr; ry <= Rr; ry++) {
    for (let rx = -Rr; rx <= Rr; rx++) {
      let score = 0;
      // every pixel: sub-sampling aliases away odd-numbered shifts and
      // silently returns an off-by-one. ~30ms per frame, so it doesn't matter.
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const ai = (y * w + x) * 4;
          const bx = x + rx, by = y + ry;
          let br = 0, bg = 0, bb = 0, ba = 0;
          if (bx >= 0 && bx < w && by >= 0 && by < h) {
            const bi = (by * w + bx) * 4;
            br = b[bi]; bg = b[bi+1]; bb = b[bi+2]; ba = b[bi+3];
          }
          const da = a[ai+3] - ba;
          score += da * da * 3;
          if (a[ai+3] > 8 && ba > 8) {
            const dr = a[ai] - br, dg = a[ai+1] - bg, db = a[ai+2] - bb;
            score += dr*dr + dg*dg + db*db;
          }
        }
      }
      // tie-break toward no movement, so a flat match doesn't drift
      score += (Math.abs(rx) + Math.abs(ry)) * 0.5;
      if (score < best.score) best = { rx, ry, score };
    }
  }
  return { rx: best.rx * f, ry: best.ry * f };   // back to full-resolution pixels
}

function autoAlignOne(i, quiet) {
  const ri = refIndexFor(i);
  if (ri < 0) return;
  const { rx, ry } = bestShift(i, ri, searchRadius(i));
  const ro = off(ri);
  S.offsets[i] = { dx: ro.dx + rx, dy: ro.dy + ry };   // relative to the aligned reference
  if (!quiet) { afterOffsetChange(); msg("input", "ok", `فریم ${i} به‌اندازهٔ ${rx >= 0 ? "+" : ""}${rx}, ${ry >= 0 ? "+" : ""}${ry} جابه‌جا شد.`); }
}

function autoAlignAll() {
  if (S.keyed.length < 2) return;
  for (let i = 1; i < S.keyed.length; i++) autoAlignOne(i, true);   // chains when ref = previous
  afterOffsetChange();
  const moved = S.offsets.filter(o => o.dx || o.dy).length;
  msg("input", "ok", moved ? `${moved} فریم تراز شد. برای بررسی پیش‌وپس کنید.` : "همه‌چیز از قبل تراز بود.");
}

/* ══════════════════════════════════════════════════════════
   5. ZIP writer — STORE (no compression). PNGs are already
      compressed, so a stored archive is valid and tiny to write.
   ══════════════════════════════════════════════════════════ */
