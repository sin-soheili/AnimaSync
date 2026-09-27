"use strict";
/* live.js — live mode: mic straight to a pop-out window, for OBS.
   Part of CatSync (fork). Classic script, shares one global scope with the
   other src/ files — see ARCHITECTURE.md for why this isn't ES modules. */

/* ══════════════════════════════════════════════════════════
   6b. live — the mic driving the cat in realtime, in a window
       of its own, so it can sit on a stream instead of going
       through an editor first
   ══════════════════════════════════════════════════════════ */

/* analyze() normalizes every frame against the 95th percentile of the whole
   file. Live has no whole file, so the reference is a peak follower: it rises
   toward a loud frame and falls back slowly. Both ends of that are load-bearing.

   The attack is soft — a quarter of the way per frame — so one door slam doesn't
   set the bar for the next ten seconds, which is the thing the 95th percentile
   buys the batch path. And the floor is a plausible speaking level rather than
   silence: let the reference decay all the way down in a quiet room and it
   renormalizes the room's own hiss up to "shouting", and the mouth flaps at
   nothing. */
const LIVE_REF_MIN = -20;     // dB — the reference never falls below this
const LIVE_REF_DECAY = 2;     // dB per second
const LIVE_ATTACK = 0.25;     // fraction of the way toward a louder frame

let live = null;              // live session, null when off

const LIVE_DOC = `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>catsync — زنده</title><style>
html,body{height:100%;margin:0;overflow:hidden;background:#0e1014;color:#e6e9ef;
  font:12px/1.4 Tahoma,"Segoe UI",ui-sans-serif,-apple-system,"SF Pro Text",sans-serif;}
#idx{direction:ltr;unicode-bidi:isolate;}
body{display:flex;flex-direction:column;}
#stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;}
#stage.checker{background-image:
  linear-gradient(45deg,#33383f 25%,transparent 25%),
  linear-gradient(-45deg,#33383f 25%,transparent 25%),
  linear-gradient(45deg,transparent 75%,#33383f 75%),
  linear-gradient(-45deg,transparent 75%,#33383f 75%);
  background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0;}
/* fills the window rather than only shrinking to it: an OS window can't go
   below about 100px, so a small sprite would otherwise sit marooned in a
   corner. Drag the window to any size and the cat follows. */
#cat{image-rendering:pixelated;display:block;width:100%;height:100%;object-fit:contain;}
#bar{display:flex;align-items:center;gap:8px;padding:6px 8px;background:#1c1f25;border-top:1px solid #2e333c;}
#meter{position:relative;flex:1;min-width:0;height:8px;border-radius:4px;background:#23272f;
  border:1px solid #2e333c;overflow:hidden;}
#meter i{display:block;height:100%;width:0;background:#4fd1c5;}
#meter.hot i{background:#f0b429;}
#meter.clip i{background:#ff5c5c;}
#meter b{position:absolute;top:0;bottom:0;width:2px;background:#f0b429;}
#idx{flex:0 0 auto;color:#8b93a1;font-variant-numeric:tabular-nums;}
#bar button{border:1px solid #2e333c;background:#23272f;color:#e6e9ef;font:inherit;
  border-radius:4px;padding:3px 9px;cursor:pointer;}
#bar button:hover{background:#2c313a;}
body.min #bar{display:none;}
#restore{display:none;position:fixed;right:5px;bottom:5px;border:0;border-radius:4px;
  background:#1c1f25cc;color:#e6e9ef;font:inherit;padding:2px 9px;cursor:pointer;
  opacity:0;transition:opacity .15s;}
body.min #restore{display:block;}
body.min:hover #restore{opacity:.9;}
</style>
<div id="stage"><canvas id="cat" width="2" height="2"></canvas></div>
<div id="bar"><div id="meter"><i></i><b></b></div><span id="idx">&mdash;</span>
<button id="fit" title="اندازهٔ پنجره را با گربه برابر کن (f)">تناسب</button>
<button id="min" title="پنهان کردن نوار و کوچک کردن به فقط گربه (h)">&ndash;</button></div>
<button id="restore" title="نمایش نوار (h)">&#9652;</button>`;

function openLiveWindow(w, h) {
  const feat = "popup=yes,menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=yes"
    + `,width=${Math.round(clamp(w || 320, 160, 1600))},height=${Math.round(clamp(h || 240, 120, 1200)) + 34}`;
  let pop = null;
  try { pop = window.open("", "catsyncLive", feat); } catch (e) {}
  if (!pop) return null;
  pop.document.open();
  pop.document.write(LIVE_DOC);
  pop.document.close();
  return pop;
}

async function startLive() {
  if (live) return stopLive("پخش زنده متوقف شد.");
  if (!S.keyed.length) return err("live", "اول یک اسپریت‌شیت بارگذاری کنید — حالت زنده به فریم‌ها نیاز دارد، نه فایل صوتی.");
  const no = noMicHere();
  if (no) return err("live", no);
  if (rec) stopRecording();                 // one mic, one job

  // Opened here, inside the click, and deliberately before the getUserMedia
  // await: a window.open that runs after an await has lost the user gesture
  // that justified it, and every browser blocks it.
  const [w0, h0] = spriteSize();
  const pop = openLiveWindow(w0, h0);
  if (!pop) return err("live", "مرورگر پنجرهٔ جدا را مسدود کرد. برای این صفحه پاپ‌آپ را مجاز کنید و دوباره «شروع پخش زنده» را بزنید.");

  // playback would come out of the speakers and straight back into the mic
  const a = $("audioEl");
  if (!a.paused) { a.pause(); $("playBtn").textContent = "پخش"; stopLoop(); }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
  } catch (e) {
    pop.close();
    return err("live", micError(e));
  }
  if (pop.closed) {                          // closed while the permission prompt was up
    stream.getTracks().forEach(t => t.stop());
    return;
  }

  const c = ctx();
  if (c.state === "suspended") { try { await c.resume(); } catch (e) {} }

  // Meter and mapping only. The mic is never connected to the destination —
  // that's a speaker-to-mic feedback loop, and it's loud.
  const src = c.createMediaStreamSource(stream);
  const an = c.createAnalyser();
  // one analysis window per output frame, which is what analyze() does to a
  // file. fftSize has to be a power of two, so take the nearest one.
  an.fftSize = clamp(1 << Math.round(Math.log2(c.sampleRate / (S.fps || 30))), 256, 4096);
  an.smoothingTimeConstant = 0;              // we do our own smoothing, on the reference
  src.connect(an);

  const cv = pop.document.getElementById("cat");
  live = {
    win: pop, stream, src, an,
    buf: new Float32Array(an.fftSize),
    cv, cx: cv.getContext("2d"),
    st: { cur: 0, held: 99 },                // held high: the first frame may change freely
    ref: LIVE_REF_MIN, v: 0, peak: 0,
    bg: null, cal: null, min: false,
    tPrev: 0, tFrame: 0, raf: 0, beat: 0, gen: 0,
  };
  live.cx.imageSmoothingEnabled = false;

  wireLiveWindow(pop);
  applyLiveBg();
  fitLiveWindow();

  $("liveBtn").classList.add("rec");
  $("liveBtn").textContent = "توقف پخش زنده";

  live.beat = setInterval(() => {
    if (!live) return;
    if (!live.win || live.win.closed) return stopLive("پنجرهٔ پخش زنده بسته شد.");
    // a window the OS has minimised or fully covered stops running rAF; when it
    // comes back the pending callback may never fire, so re-arm rather than hang
    if (performance.now() - live.tPrev > 2000) armLiveFrame();
  }, 1000);
  armLiveFrame();
  calibrateLive(true);   // same reflex as autoThreshold() on a new file
}

// Driven by the pop-out's own rAF, not this page's. A background tab is
// throttled to about 1fps, and the entire point is that this page can sit
// behind OBS while the cat keeps moving.
const liveRaf = (w, fn) => (w.requestAnimationFrame ? w.requestAnimationFrame(fn) : requestAnimationFrame(fn));

function armLiveFrame() {
  if (!live || !live.win || live.win.closed) return;
  const w = live.win;
  try { (w.cancelAnimationFrame || cancelAnimationFrame).call(w, live.raf); } catch (e) {}
  const now = performance.now();
  live.tPrev = now;
  live.tFrame = now;
  // The watchdog re-arms a chain that stopped firing while the window was
  // hidden, and cancelling a callback in a hidden window isn't reliable — so
  // every chain carries the generation it was started in and a superseded one
  // retires itself. Two chains alive at once would step the mapping twice per
  // frame, which is exactly the strobing min-hold exists to prevent.
  const gen = ++live.gen;
  const loop = () => { if (live && live.gen === gen) liveFrame(loop); };
  live.raf = liveRaf(w, loop);
}

function liveFrame(loop) {
  if (!live) return;
  const w = live.win;
  if (!w || w.closed) return stopLive("پنجرهٔ پخش زنده بسته شد.");
  live.raf = liveRaf(w, loop);

  const now = performance.now();
  const dt = Math.min(0.25, (now - live.tPrev) / 1000);
  live.tPrev = now;

  const b = live.buf;
  live.an.getFloatTimeDomainData(b);
  let sum = 0, peak = 0;
  for (let i = 0; i < b.length; i++) {
    const s = b[i];
    sum += s * s;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
  }
  const db = 20 * Math.log10(Math.sqrt(sum / b.length) + 1e-9);

  if (db > live.ref) live.ref += (db - live.ref) * LIVE_ATTACK;
  else live.ref -= LIVE_REF_DECAY * dt;
  if (live.ref < LIVE_REF_MIN) live.ref = LIVE_REF_MIN;

  live.v = clamp(((db - DB_FLOOR) / (live.ref - DB_FLOOR)) * 100, 0, 100);
  live.peak = peak;
  if (live.cal) live.cal.push(live.v);

  // Step the mapping on the fps grid, not the display's — otherwise "min hold
  // 2" means 2/60s on one machine and 2/30s on another, and the same settings
  // that look right here would look wrong in an export.
  const step = 1000 / (S.fps || 30);
  if (now - live.tFrame > 500) live.tFrame = now - step;      // resync after a stall
  const thr = parseInt($("thr").value, 10), hold = parseInt($("hold").value, 10);
  let ticks = 0;
  while (now - live.tFrame >= step && ticks < 8) {
    live.tFrame += step;
    ticks++;
    stepMap(live.st, live.v, thr, hold, S.keyed.length);
  }

  if (ticks) paintLive();
  updateLiveMeters();
}

function paintLive() {
  if (!live || !S.keyed.length || !S.crop) return;
  const [w, h] = spriteSize();
  if (!w || !h) return;
  const cv = live.cv, x = live.cx;
  if (cv.width !== w || cv.height !== h) {      // scale or viewport moved under us
    cv.width = w; cv.height = h;
    x.imageSmoothingEnabled = false;
  }
  x.clearRect(0, 0, w, h);
  if (live.bg) { x.fillStyle = live.bg; x.fillRect(0, 0, w, h); }

  const i = clamp(live.st.cur, 0, S.keyed.length - 1);
  const spr = S.keyed[i], o = off(i), c = S.crop;
  const s = parseInt($("scale").value, 10);
  // live is an output, so the viewport always applies, exactly like an export
  x.drawImage(spr, (o.dx - c.x) * s, (o.dy - c.y) * s, spr.width * s, spr.height * s);
}

/* A solid background is painted onto the canvas rather than left to CSS, so
   what OBS captures is what the WebM export would have baked in. Checker is the
   one exception — it's for eyeballing the alpha, not for capturing. */
function applyLiveBg() {
  if (!live || !live.win || live.win.closed) return;
  const mode = $("liveBg").value;
  live.bg = mode === "key" ? $("key").value
    : mode === "green" ? "#00b140"
    : mode === "black" ? "#000000" : null;
  const stage = live.win.document.getElementById("stage");
  if (stage) {
    stage.classList.toggle("checker", live.bg === null);
    stage.style.background = live.bg || "";     // "" so the checker class shows through
  }
  paintLive();
}

function updateLiveMeters() {
  const v = live ? live.v : 0, peak = live ? live.peak : 0;
  const thr = parseInt($("thr").value, 10);
  setMeter($("liveMeter"), v, peak, thr);
  $("liveIdx").textContent = live ? "اسپرایت " + live.st.cur : "—";
  if (!live || !live.win || live.win.closed) return;
  const d = live.win.document;
  setMeter(d.getElementById("meter"), v, peak, thr);
  const il = d.getElementById("idx");
  if (il) il.textContent = "اسپرایت " + live.st.cur;
}

/* The pop-out has no script of its own — it's same-origin and shares this
   realm, so it's wired from here. */
function wireLiveWindow(pop) {
  const d = pop.document;
  const setMin = on => {
    if (!live) return;
    live.min = on;
    d.body.classList.toggle("min", on);
    fitLiveWindow();
  };
  d.getElementById("min").onclick = () => setMin(true);
  d.getElementById("restore").onclick = () => setMin(false);
  d.getElementById("fit").onclick = () => fitLiveWindow();
  d.addEventListener("keydown", e => {
    if (!live) return;
    if (e.key === "h" || e.key === "H") setMin(!live.min);
    else if (e.key === "f" || e.key === "F") fitLiveWindow();
    else if (e.key === "Escape") stopLive("پخش زنده متوقف شد.");
  });
  pop.addEventListener("pagehide", () => { if (live && live.win === pop) stopLive("پنجرهٔ پخش زنده بسته شد."); });
}

/* Size the window so the cat sits in it 1:1. resizeTo takes the outer size, so
   the OS title bar and frame have to be added back on. Minimised means the bar
   is gone and the window is exactly the cat — nothing to crop out in OBS. */
function fitLiveWindow() {
  if (!live || !live.win || live.win.closed) return;
  const pop = live.win;
  const [w, h] = spriteSize();
  if (!w || !h) return;
  const bar = live.min ? 0 : ((pop.document.getElementById("bar") || {}).offsetHeight || 30);
  const dw = Math.max(0, pop.outerWidth - pop.innerWidth);
  const dh = Math.max(0, pop.outerHeight - pop.innerHeight);
  const sc = pop.screen || { availWidth: 1920, availHeight: 1080 };
  // browsers won't make a popup much smaller than 100px square, so asking for
  // less is pointless — the canvas fills whatever we end up with anyway
  const cw = clamp(w, 100, Math.max(100, (sc.availWidth || 1920) - dw - 20));
  const ch = clamp(h + bar, 80, Math.max(80, (sc.availHeight || 1080) - dh - 20));
  try { pop.resizeTo(Math.round(cw + dw), Math.round(ch + dh)); } catch (e) {}
}

/* The batch path sets the threshold from each new file's own noise floor, which
   is the only sane default — where it sits is a property of the mic and the
   room. Live has no file, so it gets there the only other way: listen to the
   room for a moment. This runs automatically on going live, and again whenever
   you ask, because a fan coming on is a different room. */
function calibrateLive(auto) {
  if (!live) return err("live", "اول پخش زنده را شروع کنید — صدای محیط باید از همان میکروفونِ روشن گرفته شود.");
  live.cal = [];
  msg("live", "work", "در حال گوش دادن به صدای محیط — یک لحظه ساکت بمانید…");
  setTimeout(() => {
    if (!live || !live.cal) return;
    const s = live.cal.sort((a, b) => a - b);
    live.cal = null;
    if (s.length < 8) return err("live", "صدای کافی برای سنجش محیط دریافت نشد — پنجره هنوز باز است؟");
    // 90th percentile, not the max, so one chair creak doesn't set the gate
    const t = clamp(Math.round(s[Math.floor(s.length * 0.9)] + 5), 2, 60);
    $("thr").value = t;
    $("thrV").textContent = t;
    remap();
    updateLiveMeters();
    msg("live", "ok", `زنده — آستانه ${t} از صدای محیط شما. `
      + (auto ? "پنجره را در OBS به‌عنوان Window Capture اضافه و کروماکی کنید. " : "")
      + "اگر دهان در سکوت هم حرکت می‌کند، آستانه را بالا ببرید — اگر هرگز باز نمی‌شود، پایین بیاورید.");
  }, 1400);
}

function stopLive(note) {
  if (!live) return;
  const L = live;
  live = null;                                 // stops the frame loop
  clearInterval(L.beat);
  try { (L.win.cancelAnimationFrame || cancelAnimationFrame).call(L.win, L.raf); } catch (e) {}
  try { L.src.disconnect(); } catch (e) {}
  // Release the device, or the browser keeps showing the recording indicator
  // and the mic stays hot after you've stopped.
  L.stream.getTracks().forEach(t => t.stop());
  try { if (L.win && !L.win.closed) L.win.close(); } catch (e) {}
  $("liveBtn").classList.remove("rec");
  $("liveBtn").textContent = "شروع پخش زنده";
  updateLiveMeters();
  if (note) msg("live", "ok", note); else clearMsg("live");
}
