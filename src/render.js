"use strict";
/* render.js — preview canvas, waveform, viewport / crop, playback loop.
   Part of CatSync (fork). Classic script, shares one global scope with the
   other src/ files — see ARCHITECTURE.md for why this isn't ES modules. */

/* ══════════════════════════════════════════════════════════
   4. preview + waveform
   ══════════════════════════════════════════════════════════ */

/* What gets exported — always the viewport. */
function spriteSize() {
  if (!S.keyed.length || !S.crop) return [0, 0];
  const s = parseInt($("scale").value, 10);
  return [S.crop.w * s, S.crop.h * s];
}

const cutLocked = () => $("lockView").checked;

/* What the preview shows. Until the cut is locked it's the whole frame, so
   moving a sprite that currently falls outside the viewport is still visible
   instead of being silently clipped away mid-edit. */
function previewSize() {
  if (!S.keyed.length || !S.crop) return [0, 0];
  if (cutLocked()) return spriteSize();
  const s = parseInt($("scale").value, 10);
  const { w, h } = maxFrameExtent();
  return [w * s, h * s];
}

/* ── viewport / crop ─────────────────────────────────────
   The exported frame is this window onto the cell, not the whole
   cell — so you can trim dead space or frame head-and-shoulders,
   and every export follows it. */

function syncCropInputs() {
  if (!S.crop) return;
  $("cropX").value = S.crop.x; $("cropY").value = S.crop.y;
  $("cropW").value = S.crop.w; $("cropH").value = S.crop.h;
  $("cropLbl").textContent = `${S.crop.w}×${S.crop.h} px`;
}

/* The one place the cut is clamped and written. Typing in the boxes and
   dragging it on the align canvas both come through here, so they can't
   disagree about what's allowed. */
function setCrop(x, y, w, h) {
  const { w: cw, h: ch } = maxFrameExtent();
  S.crop = {
    x: clamp(Math.round(x), -cw, cw),
    y: clamp(Math.round(y), -ch, ch),
    w: clamp(Math.round(w), 1, cw * 3),
    h: clamp(Math.round(h), 1, ch * 3),
  };
  syncCropInputs();
  resizePreview();
  renderAlign();
  drawFrameAt(currentFrame());
}

function readCropInputs() {
  if (!S.crop) return;
  setCrop(
    parseInt($("cropX").value, 10) || 0,
    parseInt($("cropY").value, 10) || 0,
    parseInt($("cropW").value, 10) || 1,
    parseInt($("cropH").value, 10) || 1);
}

/* The live pop-out repaints itself at the new size on its own — paintLive
   notices the canvas is the wrong shape — but the window around it doesn't.
   Refit once the gesture is over rather than on every keystroke, or the window
   jumps about while you're still deciding. */
function afterCutChange() {
  if (live) fitLiveWindow();
}

/* Union bounding box of every frame's opaque pixels, offsets applied.
   Trims the dead space the sheet came with without clipping any pose. */
function fitCropToContent(pad) {
  if (!S.keyed.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < S.keyed.length; i++) {
    const d = pixelsOf(i), o = off(i);
    const w = d.width, h = d.height, a = d.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (a[(y * w + x) * 4 + 3] > 8) {
          const px = x + o.dx, py = y + o.dy;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
      }
    }
  }
  if (minX === Infinity) return msg("input", "err", "همهٔ فریم‌ها کاملاً شفاف‌اند — رنگ کلید و تلورانس را بررسی کنید.");
  S.crop = {
    x: Math.floor(minX - pad), y: Math.floor(minY - pad),
    w: Math.ceil(maxX - minX + 1 + pad * 2), h: Math.ceil(maxY - minY + 1 + pad * 2),
  };
  syncCropInputs();
  resizePreview();
  renderAlign();
  drawFrameAt(currentFrame());
  msg("input", "ok", `محدودهٔ خروجی روی ${S.crop.w}×${S.crop.h}px تنظیم شد.`);
}

function resizePreview() {
  const [w, h] = spriteSize();
  if (!w) return;
  const [pw, ph] = previewSize();
  const cv = $("preview");
  cv.width = pw; cv.height = ph;
  cv.hidden = false;
  $("emptyNote").style.display = "none";
  cv.classList.toggle("checker", $("checker").checked);
  cv.classList.toggle("fit", $("fitView").checked);
  measure(cv);
  // always report the exported size, never the preview's
  $("stOut").textContent = `${w}×${h}`;
}

function drawFrameAt(f) {
  if (!S.keyed.length || !S.crop) return;
  const cv = $("preview");
  const x = cv.getContext("2d");
  x.imageSmoothingEnabled = false;              // nearest neighbour only
  x.clearRect(0, 0, cv.width, cv.height);
  const idx = S.mapping ? S.mapping[clamp(f, 0, S.mapping.length - 1)] : 0;
  const i = clamp(idx, 0, S.keyed.length - 1);
  const spr = S.keyed[i];
  const s = parseInt($("scale").value, 10), o = off(i), c = S.crop;
  const locked = cutLocked();
  const cx = locked ? c.x : 0, cy = locked ? c.y : 0;
  x.drawImage(spr, (o.dx - cx) * s, (o.dy - cy) * s, spr.width * s, spr.height * s);

  // Unlocked: the viewport is only a guide, so show where the cut will fall —
  // and it's draggable right here, against the animation as it plays. Locked,
  // the preview *is* the cut, so there's nothing outside it to grab.
  if (!locked) drawCutGuide(x, cv, s, spr.width, spr.height);

  $("frameLbl").textContent = S.mapping ? `فریم ${f} · اسپرایت ${idx}` : "";
}

function currentFrame() {
  const a = $("audioEl");
  return Math.floor((a.currentTime || 0) * S.fps);
}

function drawWave() {
  const cv = $("wave");
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600, h = 84;
  cv.width = w * dpr; cv.height = h * dpr;
  cv.style.height = h + "px";
  const x = cv.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, h);

  if (!S.rms) return;
  const len = S.rms.length;
  const thr = parseInt($("thr").value, 10);

  // threshold line
  const thrY = h - (thr / 100) * h;
  x.strokeStyle = "#f0b42977"; x.lineWidth = 1;
  x.beginPath(); x.moveTo(0, thrY); x.lineTo(w, thrY); x.stroke();

  for (let px = 0; px < w; px++) {
    const f = Math.floor((px / w) * len);
    const v = S.rms[f];
    const bh = (v / 100) * h;
    const open = S.mapping && S.mapping[f] > 0;
    x.fillStyle = open ? "#ff4fa3" : "#3a4049";
    x.fillRect(px, h - bh, 1, bh);
  }

  // playhead
  const a = $("audioEl");
  if (S.audioBuffer && a.duration) {
    const px = (a.currentTime / S.audioBuffer.duration) * w;
    x.fillStyle = "#4fd1c5";
    x.fillRect(px, 0, 1.5, h);
  }
}

/* playback loop */
let raf = null;
function tick() {
  const a = $("audioEl");
  drawFrameAt(currentFrame());
  drawWave();
  $("timeLbl").textContent =
    `${(a.currentTime || 0).toFixed(2)} / ${(S.audioBuffer ? S.audioBuffer.duration : 0).toFixed(2)} s`;
  raf = requestAnimationFrame(tick);
}
function startLoop() { if (!raf) tick(); }
function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
