"use strict";
/* app.js — bootstrap: wires every control to the logic modules above it, and
   owns the new interaction layer (toolbar, modals, onboarding, export CTA)
   that this fork's redesign added on top of the original single-panel UI.
   Loaded last, after every function it calls has been defined. */

/* ══════════════════════════════════════════════════════════
   modal / toolbar system
   Each tool (Sprite, Audio, Frames, Advanced, Export) is a bottom sheet on
   mobile and a centered dialog on desktop — same overlay markup either way,
   styles.css handles the layout switch. Nothing here is UI-framework code,
   just open/close plus the two escape hatches every modal needs generically.
   ══════════════════════════════════════════════════════════ */

const TOOL_OF_MODAL = { modalSprite: "toolSprite", modalAudio: "toolAudio", modalFrames: "toolFrames", modalAdvanced: "toolAdvanced" };

function openModal(id) {
  const overlay = $(id + "Overlay");
  if (!overlay) return;
  overlay.hidden = false;
  const tool = TOOL_OF_MODAL[id];
  if (tool) $(tool).classList.add("active");

  // Canvases inside a modal render correctly while hidden (their pixel
  // buffers are set in JS, not CSS), but re-measuring on open is cheap
  // insurance against a stale zero-width cached from while it was hidden.
  if (id === "modalFrames") {
    $("frameCountLbl").textContent = S.keyed.length || "—";
    syncFrameRectInputs();
    drawThumbs();
    drawSliceView();
  }
  if (id === "modalAdvanced") {
    renderAlign();
  }
}

function closeModal(id) {
  const overlay = $(id + "Overlay");
  if (!overlay) return;
  overlay.hidden = true;
  const tool = TOOL_OF_MODAL[id];
  if (tool) $(tool).classList.remove("active");
}

function anyModalOpen() {
  return ["modalSprite", "modalAudio", "modalFrames", "modalAdvanced", "modalExport"]
    .find(id => !$(id + "Overlay").hidden);
}

$("toolSprite").addEventListener("click", () => openModal("modalSprite"));
$("toolAudio").addEventListener("click", () => openModal("modalAudio"));
$("toolFrames").addEventListener("click", () => openModal("modalFrames"));
$("toolAdvanced").addEventListener("click", () => openModal("modalAdvanced"));
$("onboardSprite").addEventListener("click", () => openModal("modalSprite"));
$("onboardAudio").addEventListener("click", () => openModal("modalAudio"));
$("exportOpenBtn").addEventListener("click", () => openModal("modalExport"));

document.querySelectorAll("[data-close]").forEach(b =>
  b.addEventListener("click", () => closeModal(b.dataset.close)));
document.querySelectorAll(".modalOverlay").forEach(ov =>
  ov.addEventListener("click", e => { if (e.target === ov) closeModal(ov.dataset.modal); }));
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const open = anyModalOpen();
  if (open) closeModal(open);
});

/* ══════════════════════════════════════════════════════════
   input wiring — sprite sheet, audio, mic
   ══════════════════════════════════════════════════════════ */

wireDrop($("dropSheet"), "image/*", file => {
  const img = new Image();
  img.onload = () => {
    newSheet(img);
    $("dropSheet").classList.add("loaded");
    $("dropSheet").innerHTML = `<strong>تصویر کاراکتر</strong><br>${file.name} · ${img.width}×${img.height}`;
    // a fresh sheet is the one moment guessing is worth it — the grid it comes
    // with is more often gutters-and-margins than a clean even divide
    detectGrid(true);
    updateReady();
    closeModal("modalSprite");   // done — back to the main screen and the preview
  };
  img.onerror = () => err("input", "این تصویر خوانده نشد.");
  img.src = URL.createObjectURL(file);
});

wireDrop($("dropAudio"), "audio/*", async file => {
  if (rec) stopRecording();
  $("dropAudio").classList.add("loaded");
  $("dropAudio").innerHTML = `<strong>فایل صدا</strong><br>${file.name}`;
  S.takeBlob = null;                 // you already have this one as a file
  $("saveTake").hidden = true;
  $("recTime").textContent = "—";
  const buf = await file.arrayBuffer();
  await loadAudioBuffer(buf, URL.createObjectURL(file));
  updateReady();
  closeModal("modalAudio");
});

/* ── mic wiring ── */
$("recBtn").addEventListener("click", startRecording);
$("saveTake").addEventListener("click", () => {
  if (!S.takeBlob) return;
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  download(S.takeBlob, `catsync-take-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.wav`);
});
// a take lives in the tab and nowhere else until it's saved
window.addEventListener("beforeunload", e => {
  if (rec || S.takeBlob) { e.preventDefault(); e.returnValue = ""; }
});

/* ── live wiring ── */
$("liveBtn").addEventListener("click", startLive);
$("liveBg").addEventListener("change", applyLiveBg);
$("liveCal").addEventListener("click", () => calibrateLive(false));   // not the click Event
// the pop-out is ours; don't leave it orphaned on the desktop
window.addEventListener("pagehide", () => {
  try { if (live && live.win && !live.win.closed) live.win.close(); } catch (e) {}
});

/* ── align wiring (Advanced → تراز فریم‌ها) ── */
$("prevFrame").addEventListener("click", () => selectFrame(S.sel - 1));
$("nextFrame").addEventListener("click", () => selectFrame(S.sel + 1));
$("refMode").addEventListener("change", renderAlign);
$("onionMode").addEventListener("change", renderAlign);
$("onionOp").addEventListener("input", () => { $("onionOpV").textContent = $("onionOp").value; renderAlign(); });
document.querySelectorAll(".nudge button[data-dx]").forEach(b => {
  b.addEventListener("click", () => nudge(+b.dataset.dx, +b.dataset.dy));
});
$("moveAll").addEventListener("change", renderAlign);
$("resetOne").addEventListener("click", () => { S.offsets[S.sel] = { dx: 0, dy: 0 }; afterOffsetChange(); });
$("resetAll").addEventListener("click", () => {
  confirmAction("جابه‌جایی همهٔ فریم‌ها به صفر برمی‌گردد و تراز فعلی از دست می‌رود. ادامه؟", () => {
    S.offsets = S.keyed.map(() => ({ dx: 0, dy: 0 })); afterOffsetChange();
  });
});
$("autoOne").addEventListener("click", () => autoAlignOne(S.sel, false));
$("autoAll").addEventListener("click", autoAlignAll);

/* ── per-frame crop wiring (simple workflow → فریم‌ها) ── */
["frX", "frY", "frW", "frH"].forEach(id => $(id).addEventListener("input", readFrameRectInputs));
$("resetFrameRect").addEventListener("click", resetFrameRect);

/* The align canvas: the cut, and otherwise the sprite. */
wireCutDrag($("alignCv"), () => alignZoom, () => true, {
  cursor: "grabbing",
  start: () => S.offsets.map(o => ({ dx: o.dx, dy: o.dy })),   // drag from where we began
  move: (startOffs, ddx, ddy) => {
    if (!startOffs) return;
    const all = $("moveAll").checked;
    S.offsets = startOffs.map((o, i) =>
      (all || i === S.sel)
        ? clampOffset({ dx: o.dx + ddx, dy: o.dy + ddy })
        : { dx: o.dx, dy: o.dy });
    afterOffsetChange();
  },
});

/* The preview: the cut only, and only while it's unlocked — once the cut is
   locked the preview *is* the cut and there's nothing outside it to grab. */
wireCutDrag($("preview"), () => parseInt($("scale").value, 10), () => !cutLocked(), null);

(() => {
  const cv = $("alignCv");
  cv.addEventListener("keydown", e => {
    // on a big sprite a 1px jump is invisible, so scale the coarse step
    const big = S.keyed.length ? Math.max(S.keyed[0].width, S.keyed[0].height) : 64;
    const step = e.shiftKey ? Math.max(4, Math.round(big / 64)) : 1;
    const map = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (map[e.key]) { e.preventDefault(); nudge(map[e.key][0] * step, map[e.key][1] * step); }
  });
})();

/* ── viewport wiring (Advanced → محدودهٔ خروجی) ── */
["cropX", "cropY", "cropW", "cropH"].forEach(id => {
  $(id).addEventListener("input", readCropInputs);
  $(id).addEventListener("change", afterCutChange);   // committed, not mid-typing
});
$("lockView").addEventListener("change", () => {
  resizePreview();
  drawFrameAt(currentFrame());
});
$("fitCrop").addEventListener("click", () => { fitCropToContent(1); afterCutChange(); });
$("fullCrop").addEventListener("click", () => {
  setCrop(0, 0, S.cellW, S.cellH);
  afterCutChange();
});

/* ── slicing wiring (Advanced → برش شبکه) ── */
// cols / rows / gutter change how much room there is, so the cells refit;
// cell size and origin are taken exactly as typed.
["cols", "rows", "gGX", "gGY"].forEach(id =>
  $(id).addEventListener("input", () => readGridInputs(true)));
["gW", "gH", "gX", "gY"].forEach(id =>
  $(id).addEventListener("input", () => readGridInputs(false)));
$("detectGrid").addEventListener("click", () => detectGrid(false));
$("evenGrid").addEventListener("click", () => {
  if (!S.sheetImg) return;
  confirmAction("کل شبکه به یک تقسیم یکنواخت برمی‌گردد و برش‌های مستقلِ هر فریم پاک می‌شود. ادامه؟", () => {
    evenGrid(); syncGridInputs(); sliceSheet(); updateReady();
  });
});

/* The slice canvas: click a frame to select it, then drag its own edges or
   its body to reshape or move it — independent of every other frame, no
   numbers required. That's the primary gesture here. Dragging empty margin
   (outside every frame) falls back to nudging the whole grid's origin,
   which is still occasionally useful for the initial coarse setup. */
(() => {
  const cv = $("sliceCv");
  const zoomOf = () => sliceZoom;
  let acting = null;             // "frame" | "grid" | null
  let mode = null;                // rectHit()-style mode, while acting === "frame"
  let sx = 0, sy = 0, startRect = null, startGrid = null, pending = 0;
  let cursor = null;
  const setCursor = c => { if (c !== cursor) { cv.style.cursor = c; cursor = c; } };

  const toSheet = e => {
    const r = cv.getBoundingClientRect();
    const W = S.sheetImg ? S.sheetImg.width : 1;
    const k = W / r.width;                       // css px -> sheet px
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  };
  const schedule = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; sliceSheet(); updateReady(); });
  };

  /* Which frame (if any) a point falls inside — for "click elsewhere on the
     sheet to select that frame" rather than the one currently active. */
  const frameAt = e => {
    const p = toSheet(e);
    for (let i = 0; i < S.rects.length; i++) {
      const R = S.rects[i];
      if (p.x >= R.x && p.x <= R.x + R.w && p.y >= R.y && p.y <= R.y + R.h) return i;
    }
    return -1;
  };

  cv.addEventListener("pointerdown", e => {
    if (!S.grid || !S.sheetImg) return;
    const sel = S.rects[S.sel];
    const hit = sel ? rectHit(cv, zoomOf(), sel, e, true) : { kind: "outside" };

    if (hit.kind !== "outside") {
      acting = "frame"; mode = hit;
      setCursor(cursorForCut(mode));
      cv.setPointerCapture(e.pointerId);
      sx = e.clientX; sy = e.clientY;
      startRect = { ...sel };
      cv.focus();
      return;
    }

    const hitI = frameAt(e);
    if (hitI >= 0) { selectFrame(hitI); return; }   // a plain tap just selects it

    acting = "grid";
    const p = toSheet(e);
    cv.classList.add("drag");
    cv.setPointerCapture(e.pointerId);
    sx = p.x; sy = p.y;
    startGrid = { ...S.grid };
    cv.focus();
  });

  cv.addEventListener("pointermove", e => {
    if (acting === "frame") {
      if (!mode) return;
      const k = ratioOf(cv) / zoomOf();
      const ddx = Math.round((e.clientX - sx) * k), ddy = Math.round((e.clientY - sy) * k);
      applyRectDrag(mode, startRect, ddx, ddy,
        () => (S.sheetImg ? { w: S.sheetImg.width, h: S.sheetImg.height } : { w: 1, h: 1 }),
        (x, y, w, h) => setFrameRect(S.sel, x, y, w, h));
      return;
    }
    if (acting === "grid") {
      const p = toSheet(e), g = S.grid;
      const W = S.sheetImg.width, H = S.sheetImg.height;
      g.ox = clamp(Math.round(startGrid.ox + (p.x - sx)), -g.cw, W - 1);
      g.oy = clamp(Math.round(startGrid.oy + (p.y - sy)), -g.ch, H - 1);
      syncGridInputs();
      drawSliceView();
      schedule();
    }
  });

  const end = () => {
    if (acting === "frame") setCursor("");
    if (acting === "grid") { cv.classList.remove("drag"); sliceSheet(); updateReady(); }
    acting = null; mode = null;
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);

  // arrow keys nudge whichever frame is selected — the grid's own origin is
  // still reachable through the numeric fields, but the frame is what a user
  // focused on this canvas actually wants to move
  cv.addEventListener("keydown", e => {
    const map = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (!map[e.key]) return;
    e.preventDefault();
    const sel = S.rects[S.sel];
    if (!sel) return;
    const step = e.shiftKey ? 8 : 1;
    setFrameRect(S.sel, sel.x + map[e.key][0] * step, sel.y + map[e.key][1] * step, sel.w, sel.h);
  });
})();

/* ── look / sync wiring (Advanced) ── */
$("key").addEventListener("input", () => { applyKey(); applyLiveBg(); });
$("tol").addEventListener("input", () => { $("tolV").textContent = $("tol").value; applyKey(); });
$("feather").addEventListener("input", () => { $("featherV").textContent = $("feather").value; applyKey(); });
$("despill").addEventListener("change", applyKey);
$("scale").addEventListener("input", () => {
  $("scaleV").textContent = $("scale").value + "×";
  resizePreview(); drawFrameAt(currentFrame());
});
$("checker").addEventListener("change", () => $("preview").classList.toggle("checker", $("checker").checked));
$("fitView").addEventListener("change", () => $("preview").classList.toggle("fit", $("fitView").checked));
// analyze() sets S.fps too, but it bails without audio — and live mode needs
// the frame rate whether or not a file was ever loaded
$("fps").addEventListener("input", () => {
  $("fpsV").textContent = $("fps").value;
  S.fps = parseInt($("fps").value, 10);
  analyze();
});
$("thr").addEventListener("input", () => { $("thrV").textContent = $("thr").value; remap(); updateLiveMeters(); });
$("hold").addEventListener("input", () => { $("holdV").textContent = $("hold").value; remap(); });

/* ── demo / export / playback ── */
$("demoBtn").addEventListener("click", () => { loadDemo().then(updateReady); });
$("expPng").addEventListener("click", exportPNG);
$("expWebm").addEventListener("click", exportWebM);

$("playBtn").addEventListener("click", () => {
  const a = $("audioEl");
  if (a.paused) { a.play(); $("playBtn").textContent = "توقف"; startLoop(); }
  else { a.pause(); $("playBtn").textContent = "پخش"; stopLoop(); }
});
$("audioEl").addEventListener("ended", () => { $("playBtn").textContent = "پخش"; stopLoop(); });

$("wave").addEventListener("click", e => {
  if (!S.audioBuffer) return;
  const r = $("wave").getBoundingClientRect();
  $("audioEl").currentTime = ((e.clientX - r.left) / r.width) * S.audioBuffer.duration;
  drawWave(); drawFrameAt(currentFrame());
});

// a resize changes how much the canvases are being scaled down by, and the
// grips are sized in screen pixels
window.addEventListener("resize", () => {
  drawWave();
  measure($("preview")); measure($("alignCv"));
  if (S.keyed.length) { drawFrameAt(currentFrame()); renderAlign(); }
});

drawWave();
updateLiveMeters();   // puts the threshold tick where the slider already is
updateReady();        // sets the initial onboarding / toolbar / chip state
