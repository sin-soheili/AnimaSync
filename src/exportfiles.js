"use strict";
/* exportfiles.js — PNG sequence export + WebM real-time recording export.
   Part of CatSync (fork). Classic script, shares one global scope with the
   other src/ files — see ARCHITECTURE.md for why this isn't ES modules. */

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function exportPNG() {
  if (!S.mapping) return;
  const btn = $("expPng");
  btn.disabled = true;
  msg("exp", "work", "در حال رندر اسپرایت‌ها…");

  const [w, h] = spriteSize();
  // Only N distinct images exist, so render each once and reuse the bytes for
  // every frame that points at it. Turns thousands of encodes into a handful.
  const unique = [];
  const sc = parseInt($("scale").value, 10);
  for (let i = 0; i < S.keyed.length; i++) {
    const spr = S.keyed[i], o = off(i);
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const x = cv.getContext("2d");
    x.imageSmoothingEnabled = false;
    x.drawImage(spr, (o.dx - S.crop.x) * sc, (o.dy - S.crop.y) * sc, spr.width * sc, spr.height * sc);
    const blob = await new Promise(res => cv.toBlob(res, "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    unique.push({ bytes, crc: crc32(bytes) });
  }

  const total = S.mapping.length;
  const files = [];
  const pad = String(total).length < 4 ? 4 : String(total).length;
  for (let f = 0; f < total; f++) {
    const u = unique[S.mapping[f]];
    files.push({ name: `frame_${String(f + 1).padStart(pad, "0")}.png`, bytes: u.bytes, crc: u.crc });
    if (f % 500 === 0) {
      msg("exp", "work", `بسته‌بندی فریم ${f + 1} از ${total}…`);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  msg("exp", "work", "در حال ساخت آرشیو…");
  await new Promise(r => setTimeout(r, 0));
  const zip = buildZip(files);
  download(zip, `catsync_${total}f_${S.fps}fps.zip`);
  msg("exp", "ok", `${total} فریم با ${S.fps} فریم بر ثانیه اکسپورت شد. آن را به‌صورت توالی تصویر وارد کنید.`);
  btn.disabled = false;
}

let recorder = null;

/* createMediaElementSource can only ever be called once per element, so cache
   the tap. Rebuilding it per export threw, got swallowed, and every export
   after the first came out silent. */
let audioTap = null;
function audioTapFor(a) {
  if (audioTap) return audioTap;
  try {
    const src = ctx().createMediaElementSource(a);
    const dest = ctx().createMediaStreamDestination();
    src.connect(dest);
    src.connect(ctx().destination);   // keep it audible while recording
    audioTap = { src, dest };
  } catch (e) {
    audioTap = null;
  }
  return audioTap;
}

async function exportWebM() {
  if (!S.mapping) return;
  const btn = $("expWebm");
  const a = $("audioEl");
  btn.disabled = true;

  const [w, h] = spriteSize();
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const x = cv.getContext("2d");
  x.imageSmoothingEnabled = false;

  // captureStream(0) hands us frame-by-frame control via requestFrame().
  // Left on auto-capture, frames are only sampled when the canvas happens to
  // be dirty and rAF throttles to ~1fps in a background tab, so the cadence
  // silently collapses. Fall back to auto if requestFrame isn't available.
  const stream = cv.captureStream(0);
  const vtrack = stream.getVideoTracks()[0];
  const manual = typeof vtrack.requestFrame === "function";
  const autoStream = manual ? null : cv.captureStream(S.fps);
  const useStream = manual ? stream : autoStream;

  // one persistent tap — createMediaElementSource throws on a second call for
  // the same element, which used to silently drop audio from every re-export
  const tap = audioTapFor(a);
  if (tap) tap.dest.stream.getAudioTracks().forEach(t => useStream.addTrack(t));

  // VP8 first: it encodes far faster in realtime than VP9, and falling behind
  // realtime is what truncates the end of the clip. Quality barely matters
  // here — this is the preview export, the PNG sequence is the master.
  const mime = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"]
    .find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) { msg("exp", "err", "این مرورگر نمی‌تواند WebM ضبط کند. از توالی PNG استفاده کنید."); btn.disabled = false; return; }

  const total = S.mapping.length;
  const seconds = total / S.fps;
  const frameMs = 1000 / S.fps;
  const keyHex = $("key").value;
  const sc = parseInt($("scale").value, 10);

  const drawIdx = idx => {
    x.fillStyle = keyHex;                        // baked-in background, no alpha
    x.fillRect(0, 0, w, h);
    const o = off(idx), spr = S.keyed[idx];
    x.drawImage(spr, (o.dx - S.crop.x) * sc, (o.dy - S.crop.y) * sc, spr.width * sc, spr.height * sc);
    if (manual) vtrack.requestFrame();
  };

  const parts = [];
  let encodedMs = 0;          // how far the encoder has actually committed
  let bytesOut = 0;

  // Bitrate scaled to the frame — a fixed 8Mbps on a large canvas is a big
  // part of why the encoder falls behind realtime in the first place.
  const bitrate = clamp(Math.round(w * h * S.fps * 0.12), 1_500_000, 12_000_000);

  recorder = new MediaRecorder(useStream, { mimeType: mime, videoBitsPerSecond: bitrate });
  recorder.ondataavailable = async e => {
    if (!e.data.size) return;
    parts.push(e.data);
    bytesOut += e.data.size;
    try {
      encodedMs = scanClusterTimecodes(new Uint8Array(await e.data.arrayBuffer()), encodedMs);
    } catch (err) { /* progress read is best-effort */ }
  };
  recorder.onstop = async () => {
    let blob = new Blob(parts, { type: "video/webm" });
    const raw = new Uint8Array(await blob.arrayBuffer());

    // Re-measure from the finished file — this catches the final chunks that
    // arrive as part of stop() and is the truest number we have.
    const finalMs = scanClusterTimecodes(raw, encodedMs);
    const dur = finalMs > 0 ? finalMs / 1000 : (recordedSeconds || seconds);

    // Stamp what the stream actually holds. Over-claiming makes players freeze
    // on the last frame to fill the gap; under-claiming truncates.
    const patched = patchWebmDuration(raw, dur);
    if (patched) blob = new Blob([patched], { type: "video/webm" });
    download(blob, `catsync_${S.fps}fps.webm`);

    const lost = seconds - dur;
    let note;
    if (!patched) {
      note = `WebM اکسپورت شد، اما سربرگ مدت‌زمان نوشته نشد — برخی پخش‌کننده‌ها طول اشتباه نشان می‌دهند.`;
    } else if (lost > 0.5) {
      note = `WebM اکسپورت شد اما ${lost.toFixed(1)} ثانیه از صدای ${seconds.toFixed(1)} ثانیه‌ای کوتاه‌تر است — رمزگذار در ${w}×${h} عقب افتاد. مقیاس را کم کنید یا محدودهٔ خروجی را کوچک‌تر کنید و دوباره امتحان کنید، یا از توالی PNG استفاده کنید که محدودیت زمان‌واقعی ندارد.`;
    } else {
      note = `WebM اکسپورت شد — ${total} فریم، ${dur.toFixed(2)} ثانیه، ${(bytesOut / 1048576).toFixed(1)}MB در ${w}×${h}. پس‌زمینه را در نرم‌افزار ویرایش کروماکی کنید.`;
    }
    msg("exp", patched && lost <= 0.5 ? "ok" : "work", note);
    btn.disabled = false;
  };

  let stopped = false;      // playback done; still flushing
  let timer = null;
  let recStart = 0;         // wall clock at recorder.start()
  let recordedSeconds = 0;  // what actually got captured
  const TAIL_MS = 150;

  const finish = () => {
    if (stopped) return;
    stopped = true;
    a.pause();

    // Keep pushing the final frame while the encoder flushes — going silent
    // leaves recorded time with no frames in it, which players render as a
    // held frame. Then wait for the encoder to actually catch up rather than
    // stopping on a fixed timer: on a large canvas it can be seconds behind
    // realtime, and stop() discards everything still queued.
    const targetMs = (total * frameMs) - frameMs;
    const hardDeadline = performance.now() + Math.max(20000, total * frameMs * 0.5);
    let settled = 0, lastSeen = -1;

    const drain = setInterval(() => {
      try { if (recorder && recorder.state === "recording") recorder.requestData(); } catch (e) {}

      const caughtUp = encodedMs >= targetMs;
      // if progress stalls entirely, don't hang forever
      if (encodedMs === lastSeen) settled++; else { settled = 0; lastSeen = encodedMs; }
      const stalled = settled >= 8;                    // ~2s with no movement
      const timedOut = performance.now() > hardDeadline;

      if (!caughtUp && !stalled && !timedOut) {
        const behind = Math.max(0, (targetMs - encodedMs) / 1000);
        msg("exp", "work", `رمزگذار در حال جبران عقب‌افتادگی — ${behind.toFixed(1)} ثانیه از ویدیو هنوز نوشته نشده…`);
        return;
      }

      clearInterval(drain);
      if (timer) clearInterval(timer);
      recordedSeconds = encodedMs > 0 ? encodedMs / 1000 : (performance.now() - recStart) / 1000;
      setTimeout(() => {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      }, TAIL_MS);
    }, 250);
  };

  msg("exp", "work", `در حال ضبط ${seconds.toFixed(1)} ثانیه به‌صورت زمان‌واقعی — تب را عوض نکنید…`);

  // prime a frame, start recording, and only then start playback, so nothing
  // is lost in the gap between play() resolving and the recorder arming
  drawIdx(S.mapping[0]);
  recorder.start(1000);
  recStart = performance.now();          // the container's t=0
  await new Promise(r => setTimeout(r, 40));

  a.currentTime = 0;
  try { await a.play(); } catch (e) { finish(); msg("exp", "err", "پخش مسدود شد، پس چیزی ضبط نشد."); return; }
  startLoop();

  // pace off the wall clock: MediaRecorder timestamps by real elapsed time, so
  // frames have to be emitted in real time for the duration to come out right
  const t0 = performance.now();
  let lastEmitted = -1;
  timer = setInterval(() => {
    const raw = Math.floor((performance.now() - t0) / frameMs);
    if (stopped) {
      // flushing: hold on the last frame but keep the stream alive
      drawIdx(S.mapping[total - 1]);
      return;
    }
    if (raw >= total) { drawIdx(S.mapping[total - 1]); finish(); return; }
    if (raw !== lastEmitted) { lastEmitted = raw; drawIdx(S.mapping[raw]); }
    if (raw % 30 === 0) msg("exp", "work", `در حال ضبط… ${Math.round((raw / total) * 100)}%`);
  }, Math.max(4, frameMs / 2));

  // The frame counter is authoritative — the mapping is derived from this same
  // audio, so they land together. If `ended` fires early (a slightly short
  // decode, say), stopping here would freeze the animation before the mapping
  // is done, so only honour it once we're already at the end.
  a.onended = () => {
    const raw = Math.floor((performance.now() - t0) / frameMs);
    if (raw >= total - 2) finish();
    a.onended = null;
  };
}
