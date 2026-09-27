"use strict";
/* uicore.js — small UI utilities shared by every other module (msg/err, confirm dialog, drop zones).
   Part of CatSync (fork). Classic script, shares one global scope with the
   other src/ files — see ARCHITECTURE.md for why this isn't ES modules. */

/* ══════════════════════════════════════════════════════════
   8. messages + wiring
   ══════════════════════════════════════════════════════════ */

const MSG_EL = { exp: "expMsg", slice: "sliceMsg", input: "inputMsg", live: "liveMsg" };

function msg(which, kind, text) {
  const el = $(MSG_EL[which] || "inputMsg");
  el.className = "msg " + kind;
  el.textContent = text;
}
function err(which, text) { msg(which, "err", text); }
function clearMsg(which) {
  const el = $(MSG_EL[which] || "inputMsg");
  el.className = "msg"; el.textContent = "";
}

/* A custom stand-in for confirm() — for resets broad enough (every offset,
   the whole grid) that a stray tap shouldn't be able to trigger them
   unattended. No browser alert(): styled consistently with the rest of the app. */
let confirmResolve = null;
function confirmAction(text, onConfirm) {
  $("confirmMsg").textContent = text;
  $("confirmOverlay").hidden = false;
  confirmResolve = onConfirm;
  $("confirmYes").focus();
}
function closeConfirm(run) {
  $("confirmOverlay").hidden = true;
  const fn = confirmResolve;
  confirmResolve = null;
  if (run && fn) fn();
}
$("confirmYes").addEventListener("click", () => closeConfirm(true));
$("confirmNo").addEventListener("click", () => closeConfirm(false));
$("confirmOverlay").addEventListener("click", e => { if (e.target === $("confirmOverlay")) closeConfirm(false); });
document.addEventListener("keydown", e => {
  if (!$("confirmOverlay").hidden && e.key === "Escape") closeConfirm(false);
});

/* Reads the drop zone's own label — set by whichever path filled it (a
   dropped file, a finished recording, or the demo) — instead of keeping a
   second copy of the file name in app state. One source of truth: the DOM
   node that's already showing it. */
function dropLabel(dropEl) {
  if (!dropEl.classList.contains("loaded")) return null;
  const br = dropEl.querySelector("br");
  if (!br) return null;
  let s = "", n = br.nextSibling;
  while (n) { s += n.textContent; n = n.nextSibling; }
  return s.trim();
}

function updateReady() {
  const ready = !!(S.mapping && S.keyed.length && S.audioBuffer);
  $("expPng").disabled = !ready;
  $("expWebm").disabled = !ready;
  $("playBtn").disabled = !S.audioBuffer;
  $("liveBtn").disabled = !S.keyed.length;    // live needs frames, not audio

  const hasSheet = !!S.sheetImg, hasAudio = !!S.audioBuffer;
  $("toolFrames").disabled = !hasSheet;
  $("exportOpenBtn").disabled = !ready;

  $("onboardCard").classList.toggle("hidden", hasSheet);
  $("stageCard").classList.toggle("hidden", !hasSheet);
  $("fileStatusRow").classList.toggle("hidden", !hasSheet);
  $("exportOpenBtn").classList.toggle("hidden", !hasSheet);

  $("toolSprite").classList.toggle("has-data", hasSheet);
  $("toolAudio").classList.toggle("has-data", hasAudio);
  $("chipSprite").classList.toggle("filled", hasSheet);
  $("chipAudio").classList.toggle("filled", hasAudio);
  $("chipSpriteName").textContent = dropLabel($("dropSheet")) || "انتخاب نشده";
  $("chipAudioName").textContent = dropLabel($("dropAudio")) || "انتخاب نشده";
}

function wireDrop(el, accept, onFile) {
  const input = document.createElement("input");
  input.type = "file"; input.accept = accept; input.hidden = true;
  document.body.append(input);
  el.addEventListener("click", () => input.click());
  input.addEventListener("change", () => { if (input.files[0]) onFile(input.files[0]); });
  el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("over"); });
  el.addEventListener("dragleave", () => el.classList.remove("over"));
  el.addEventListener("drop", e => {
    e.preventDefault(); el.classList.remove("over");
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  });
}
