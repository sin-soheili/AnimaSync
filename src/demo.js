"use strict";
/* demo.js — demo assets — a throwaway sheet + clip to test the pipeline.
   Part of CatSync (fork). Classic script, shares one global scope with the
   other src/ files — see ARCHITECTURE.md for why this isn't ES modules. */

/* ══════════════════════════════════════════════════════════
   7. demo assets — a throwaway sheet + clip, so the whole
      pipeline is testable before any real art exists
   ══════════════════════════════════════════════════════════ */

function demoSheet() {
  const CW = 48, CH = 64, N = 4;
  const cv = document.createElement("canvas");
  cv.width = CW * N; cv.height = CH;
  const x = cv.getContext("2d");
  x.fillStyle = "#ff00ff";
  x.fillRect(0, 0, cv.width, cv.height);

  const mouths = [[8, 2], [8, 4], [10, 10], [14, 6]];  // [width, height] per frame
  // deliberate drift on cells 1-3, exactly like a real generated sheet comes
  // back — so the onion skin and auto-align have something to actually fix
  const jitter = [[0, 0], [2, -1], [-3, 2], [1, 3]];
  for (let i = 0; i < N; i++) {
    const ox = i * CW, jx = jitter[i][0], jy = jitter[i][1];
    const px = (X, Y, W, H, col) => { x.fillStyle = col; x.fillRect(ox + X + jx, Y + jy, W, H); };

    px(14, 30, 20, 26, "#6b6f76");                   // body
    px(16, 56, 6, 6, "#5a5e64"); px(26, 56, 6, 6, "#5a5e64");  // feet
    px(12, 10, 24, 22, "#8e939b");                   // head
    px(12, 4, 6, 8, "#8e939b"); px(30, 4, 6, 8, "#8e939b");    // ears
    px(14, 6, 2, 5, "#d98fa8");  px(32, 6, 2, 5, "#d98fa8");   // inner ears
    px(14, 17, 20, 5, "#101216");                    // sunglasses
    px(23, 18, 2, 3, "#101216");                     // bridge
    px(22, 25, 4, 3, "#d98fa8");                     // nose

    const [mw, mh] = mouths[i];                      // mouth: the only thing that changes
    px(24 - (mw >> 1), 30, mw, mh, "#2a1a22");
  }
  return cv;
}

function demoAudio() {
  const sr = 44100, dur = 4.0;
  const n = Math.floor(sr * dur);
  const data = new Float32Array(n);
  // low room tone under everything — real recordings are never digitally
  // silent, and without it the threshold slider appears to do nothing
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * 0.005;
  // syllable-ish bursts with a real pause in the middle, so the closed-mouth
  // percentage means something
  const beats = [];
  let t = 0.15;
  while (t < 1.7) { beats.push([t, 0.10 + Math.random() * 0.09, 0.35 + Math.random() * 0.5]); t += 0.16 + Math.random() * 0.10; }
  t = 2.5;
  while (t < 3.8) { beats.push([t, 0.10 + Math.random() * 0.09, 0.35 + Math.random() * 0.5]); t += 0.16 + Math.random() * 0.10; }

  for (const [start, len, amp] of beats) {
    const s0 = Math.floor(start * sr), s1 = Math.min(n, Math.floor((start + len) * sr));
    const f = 120 + Math.random() * 90;
    for (let i = s0; i < s1; i++) {
      const p = (i - s0) / (s1 - s0);
      const env = Math.sin(Math.PI * p);
      data[i] += amp * env * (0.6 * Math.sin(2 * Math.PI * f * i / sr) + 0.4 * (Math.random() * 2 - 1) * 0.5);
    }
  }
  return encodeWAV(data, sr);
}

function encodeWAV(samples, sr) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    v.setInt16(o, clamp(samples[i], -1, 1) * 0x7FFF, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function loadDemo() {
  newSheet(demoSheet());
  $("cols").value = 4; $("rows").value = 1;
  // the demo sheet is a clean even grid on purpose — auto-detect would trim it
  // down to the sprites and hide the drift the align panel is there to fix
  evenGrid(); syncGridInputs();
  $("dropSheet").classList.add("loaded");
  $("dropSheet").innerHTML = "<strong>اسپریت‌شیت</strong><br>شیت آزمایشی · ۴×۱";
  sliceSheet();

  const blob = demoAudio();
  const url = URL.createObjectURL(blob);
  $("dropAudio").classList.add("loaded");
  $("dropAudio").innerHTML = "<strong>صدا</strong><br>کلیپ آزمایشی · ۴٫۰ ثانیه";
  await loadAudioBuffer(await blob.arrayBuffer(), url);
  $("scale").value = 4; $("scaleV").textContent = "4×";
  resizePreview();
  drawFrameAt(0);
}
