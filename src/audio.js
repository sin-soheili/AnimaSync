"use strict";
/* audio.js — audio: decode, per-frame RMS analysis, mic recording.
   Part of CatSync (fork). Classic script, shares one global scope with the
   other src/ files — see ARCHITECTURE.md for why this isn't ES modules. */


/* ══════════════════════════════════════════════════════════
   2. audio: decode + per-frame RMS  (cached — never recomputed
      when threshold / hold / scale change)
   ══════════════════════════════════════════════════════════ */

let audioCtx = null;
function ctx() { return audioCtx || (audioCtx = new (window.AudioContext || window.webkitAudioContext)()); }

async function loadAudioBuffer(arrayBuf, url) {
  let buf;
  try {
    buf = await ctx().decodeAudioData(arrayBuf.slice(0));
  } catch (e) {
    return err("input", "این فایل صوتی قابل رمزگشایی نیست. یک WAV یا MP3 ساده امتحان کنید.");
  }
  S.audioBuffer = buf;
  if (S.audioURL) URL.revokeObjectURL(S.audioURL);
  S.audioURL = url;
  $("audioEl").src = url;
  clearMsg("input");
  analyze();
  autoThreshold();   // only on new audio — don't stomp manual tuning later
}

function downmix(buf) {
  const n = buf.length;
  const mono = new Float32Array(n);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) mono[i] += data[i];
  }
  if (buf.numberOfChannels > 1) {
    for (let i = 0; i < n; i++) mono[i] /= buf.numberOfChannels;
  }
  return mono;
}

function analyze() {
  if (!S.audioBuffer) return;
  const buf = S.audioBuffer;
  S.fps = parseInt($("fps").value, 10);
  const n = buf.length;
  const mono = downmix(buf);

  // one window per output video frame
  const win = Math.max(1, Math.round(buf.sampleRate / S.fps));
  const frames = Math.max(1, Math.floor(n / win));
  const db = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * win, end = start + win;
    for (let i = start; i < end; i++) sum += mono[i] * mono[i];
    const rms = Math.sqrt(sum / win);
    db[f] = 20 * Math.log10(rms + 1e-9);
  }

  // normalize against the 95th percentile of non-silent windows, not the max —
  // one loud pop shouldn't squash the rest of the take
  const voiced = Array.from(db).filter(v => v > DB_FLOOR).sort((a, b) => a - b);
  let ref = voiced.length ? voiced[Math.floor(voiced.length * 0.95)] : 0;
  if (ref <= DB_FLOOR + 1) ref = DB_FLOOR + 1;

  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    out[f] = clamp(((db[f] - DB_FLOOR) / (ref - DB_FLOOR)) * 100, 0, 100);
  }
  S.rms = out;

  $("stDur").textContent = buf.duration.toFixed(2) + "s";
  remap();
  drawWave();
  updateReady();
}

// The threshold is a hard gate on the recording's noise floor, and where that
// floor sits is a property of the mic and the room — a fixed default is right
// for one take and wrong for the next. So place it from the audio itself, just
// above the quiet frames, and let the slider fine-tune from there.
function autoThreshold() {
  if (!S.rms || !S.rms.length) return;
  const sorted = Array.from(S.rms).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.20)];   // typical quiet frame
  const t = clamp(Math.round(floor + 6), 2, 60);
  $("thr").value = t;
  $("thrV").textContent = t;
  remap();
}

/* ══════════════════════════════════════════════════════════
   2b. recording — the mic straight into the pipeline, so a
       take is a button press instead of a round trip through
       another app
   ══════════════════════════════════════════════════════════ */

const MAX_TAKE = 10 * 60;    // seconds; a forgotten tab shouldn't eat all your RAM
let rec = null;              // live recording session, null when idle

// All three of these fight the thing we're measuring. Auto gain flattens loud
// against quiet, which is the entire lip-sync signal. Noise suppression gates
// room tone down to digital silence, which turns the threshold into a cliff
// with nothing sensible to sit on. Echo cancellation is for calls. Off, off,
// off — a raw take reads better, and live mode wants the same raw signal.
const MIC_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

function micError(e) {
  const n = e && e.name;
  return n === "NotAllowedError" ? "دسترسی میکروفون رد شد. آن را مجاز کنید (آیکون کنار نوار آدرس) و دوباره امتحان کنید." :
    n === "NotFoundError" || n === "DevicesNotFoundError" ? "میکروفونی پیدا نشد." :
    n === "NotReadableError" ? "میکروفون مشغول است — برنامه یا تب دیگری آن را گرفته." :
    "میکروفون باز نشد" + (n ? ` (${n}).` : ".");
}

function noMicHere() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return location.protocol === "file:"
      ? "این مرورگر میکروفون را روی صفحهٔ file:// باز نمی‌کند. از نسخهٔ آنلاین در alejandruxxug.github.io/Catsync استفاده کنید، یا یک فایل بکشید."
      : "این مرورگر به این صفحه میکروفون نمی‌دهد. به‌جایش یک WAV یا MP3 بکشید.";
  }
  return null;
}

function pickAudioMime() {
  if (!window.MediaRecorder) return null;
  const want = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const m of want) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";                 // let the browser pick
}

/* `m` is the meter element — the panel has one, and so does the live pop-out,
   which lives in a different document. `thr` positions the threshold tick, on
   meters that have one. */
function setMeter(m, pct, peak, thr) {
  if (!m) return;
  m.firstElementChild.style.width = clamp(pct, 0, 100) + "%";
  m.classList.toggle("hot", peak > 0.7 && peak <= 0.98);
  m.classList.toggle("clip", peak > 0.98);
  const tick = m.querySelector("b");
  if (tick) tick.style.left = clamp(thr || 0, 0, 100) + "%";
}

async function startRecording() {
  if (rec) return stopRecording();

  const no = noMicHere();
  if (no) return err("input", no);
  if (!window.MediaRecorder) {
    return err("input", "این مرورگر MediaRecorder ندارد و نمی‌تواند ضبط کند. به‌جایش یک WAV یا MP3 بکشید.");
  }
  if (live) stopLive();          // one mic, one job

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
  } catch (e) {
    return err("input", micError(e));
  }

  const a = $("audioEl");
  if (!a.paused) { a.pause(); $("playBtn").textContent = "پخش"; stopLoop(); }

  const c = ctx();
  if (c.state === "suspended") { try { await c.resume(); } catch (e) {} }

  // Meter only. The mic is deliberately never connected to the destination —
  // that's a speaker-to-mic feedback loop, and it's loud.
  const src = c.createMediaStreamSource(stream);
  const an = c.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);

  const mime = pickAudioMime();
  let mr;
  try {
    mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    stream.getTracks().forEach(t => t.stop());
    return err("input", "این مرورگر از شروع ضبط صدا خودداری کرد. به‌جایش یک WAV یا MP3 بکشید.");
  }

  const chunks = [];
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstop = () => finishRecording(chunks, mr.mimeType || mime);
  mr.start();

  rec = { mr, stream, src, an, t0: performance.now(), raf: 0 };
  $("recBtn").classList.add("rec");
  $("recBtn").innerHTML = "&#9632; توقف";
  $("saveTake").hidden = true;
  msg("input", "work", "در حال ضبط. با همان بلندی صدایی که واقعاً استفاده می‌کنید صحبت کنید، سپس «توقف» را بزنید.");

  const frame = new Float32Array(an.fftSize);
  const tickMeter = () => {
    if (!rec) return;
    an.getFloatTimeDomainData(frame);
    let sum = 0, peak = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      sum += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    const db = 20 * Math.log10(Math.sqrt(sum / frame.length) + 1e-9);
    setMeter($("meter"), ((db + 60) / 60) * 100, peak);   // -60dB..0dB across the bar

    const t = (performance.now() - rec.t0) / 1000;
    $("recTime").textContent = t.toFixed(1) + "s";
    if (t >= MAX_TAKE) { stopRecording(); return; }
    rec.raf = requestAnimationFrame(tickMeter);
  };
  tickMeter();
}

function stopRecording() {
  if (!rec) return;
  const r = rec;
  rec = null;                                  // stops the meter loop
  cancelAnimationFrame(r.raf);
  try { r.mr.stop(); } catch (e) {}            // fires onstop -> finishRecording
  try { r.src.disconnect(); } catch (e) {}
  // Release the device, or the browser keeps showing the recording indicator
  // and the mic stays hot after you've stopped.
  r.stream.getTracks().forEach(t => t.stop());
  $("recBtn").classList.remove("rec");
  $("recBtn").innerHTML = "&#9679; ضبط";
  setMeter($("meter"), 0, 0);
}

async function finishRecording(chunks, mime) {
  if (!chunks.length) return err("input", "ضبط خالی برگشت. بررسی کنید میکروفونِ درست انتخاب شده باشد.");
  msg("input", "work", "در حال کدگذاری ضبط…");
  const raw = new Blob(chunks, { type: mime || "audio/webm" });

  let buf;
  try {
    buf = await ctx().decodeAudioData(await raw.arrayBuffer());
  } catch (e) {
    return err("input", "ضبط قابل رمزگشایی نبود. دوباره امتحان کنید، یا با برنامهٔ دیگری ضبط کنید و فایل را بکشید.");
  }

  // MediaRecorder writes a live-stream container with no length in the header —
  // the same hole that made the WebM video export come out short. An <audio>
  // element reports Infinity for its duration and won't seek, which breaks the
  // waveform and the scrubber. We already have the decoded samples, so the take
  // is re-encoded as a plain WAV, which carries a real length. Mono, because
  // that's what the analysis reduces to anyway.
  const wav = encodeWAV(downmix(buf), buf.sampleRate);
  S.takeBlob = wav;

  const secs = buf.duration;
  $("dropAudio").classList.add("loaded");
  $("dropAudio").innerHTML = `<strong>صدا</strong><br>ضبط‌شده · ${secs.toFixed(1)} ثانیه`;
  $("recTime").textContent = secs.toFixed(1) + "s";
  $("saveTake").hidden = false;

  await loadAudioBuffer(await wav.arrayBuffer(), URL.createObjectURL(wav));
  updateReady();
  if (S.audioBuffer) {
    msg("input", "ok", `${secs.toFixed(1)} ثانیه دریافت شد. آستانه از سطح نویز همین ضبط تنظیم شد — عدد دهانِ بسته را بررسی کنید.`);
  }
}

/* ══════════════════════════════════════════════════════════
   3. mapping: loudness → sprite index (cheap; runs on every
      slider drag)
   ══════════════════════════════════════════════════════════ */
