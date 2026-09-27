"use strict";
/* keying.js — chroma keying + the sliced-frames thumbnail strip.
   Part of CatSync (fork). Classic script, shares one global scope with the
   other src/ files — see ARCHITECTURE.md for why this isn't ES modules. */

const off = i => (S.offsets[i] || { dx: 0, dy: 0 });

function applyKey() {
  if (!S.slices.length) return;
  const hex = $("key").value;
  const kr = parseInt(hex.slice(1, 3), 16),
        kg = parseInt(hex.slice(3, 5), 16),
        kb = parseInt(hex.slice(5, 7), 16);
  // tolerance / feather are 0-100 over the RGB distance range
  const MAXD = 441.673;                       // sqrt(3*255^2)
  const tol = parseInt($("tol").value, 10);
  const feather = parseInt($("feather").value, 10);
  const inner = (tol / 100) * MAXD;
  const outer = inner + (feather / 100) * MAXD;
  const inner2 = inner * inner;
  const doFeather = feather > 0;
  const doDespill = doFeather && $("despill").checked;

  const canDespill = doDespill;

  S.keyed = S.slices.map(src => {
    const cv = document.createElement("canvas");
    cv.width = src.width; cv.height = src.height;
    const x = cv.getContext("2d");
    x.drawImage(src, 0, 0);
    const img = x.getImageData(0, 0, cv.width, cv.height);
    const d = img.data;

    for (let i = 0; i < d.length; i += 4) {
      const dr = d[i] - kr, dg = d[i+1] - kg, db = d[i+2] - kb;
      const dist2 = dr*dr + dg*dg + db*db;

      if (!doFeather) {
        // hard cutoff — the right answer for true pixel art
        if (dist2 <= inner2) d[i+3] = 0;
        continue;
      }

      if (dist2 <= inner2) { d[i+3] = 0; continue; }
      const dist = Math.sqrt(dist2);
      if (dist >= outer) continue;                    // fully opaque, leave alone

      const a = (dist - inner) / (outer - inner);     // 0 at the key, 1 at the edge
      d[i+3] = Math.round(d[i+3] * a);

      // Despill only the partly-transparent band, scaled by how transparent it
      // is. Opaque interior pixels are never touched, so a genuinely pink nose
      // survives a magenta key.
      //
      // Desaturate toward the pixel's own mean rather than clamping the key's
      // dominant channels down: with a magenta key those are R and B, so
      // clamping them collapses toward the lone dark G channel and leaves a
      // dark halo. Pivoting on the mean holds luminance exactly and just
      // drains the colour cast.
      if (canDespill) {
        const mean = (d[i] + d[i+1] + d[i+2]) / 3;
        const keep = a;                                // = 1 - strength
        d[i]   = mean + (d[i]   - mean) * keep;
        d[i+1] = mean + (d[i+1] - mean) * keep;
        d[i+2] = mean + (d[i+2] - mean) * keep;
      }
    }

    x.putImageData(img, 0, 0);
    return cv;
  });

  idCache.clear(); workCache.clear();   // keyed pixels changed, cached copies are stale
  S.sel = clamp(S.sel, 0, S.keyed.length - 1);
  drawThumbs();
  renderAlign();
  syncFrameRectInputs();
  $("stSprites").textContent = S.keyed.length;
  remap();
  resizePreview();
  drawFrameAt(currentFrame());
}

function drawThumbs() {
  const box = $("thumbs");
  box.innerHTML = "";
  S.keyed.forEach((cv, i) => {
    const fig = document.createElement("figure");
    if (i === S.sel) fig.className = "sel";
    const c = document.createElement("canvas");
    c.width = cv.width; c.height = cv.height;
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = false;
    const o = off(i);
    // The raw slice, uncut. Drawing it at its offset clipped whatever fell
    // outside the cell, so the strip hid exactly the part you were trying to
    // judge. Alignment belongs in the align canvas; this is the source frame.
    x.drawImage(cv, 0, 0);
    const lbl = document.createElement("div");
    lbl.className = "lbl";
    lbl.textContent = i === 0 ? "0 · بسته" : i;
    const ol = document.createElement("div");
    ol.className = "off";
    ol.textContent = (o.dx || o.dy) ? `${o.dx >= 0 ? "+" : ""}${o.dx},${o.dy >= 0 ? "+" : ""}${o.dy}` : " ";
    fig.append(c, lbl, ol);
    fig.addEventListener("click", () => selectFrame(i));
    box.append(fig);
  });
}
