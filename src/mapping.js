"use strict";
/* mapping.js — loudness → sprite index mapping (the lip-sync state machine).
   Part of CatSync (fork). Classic script, shares one global scope with the
   other src/ files — see ARCHITECTURE.md for why this isn't ES modules. */

function bandOf(v, thr, N) {
  if (v <= thr) return 0;
  const t = (v - thr) / (100 - thr);
  return clamp(1 + Math.floor(t * (N - 1)), 1, N - 1);
}

/* One frame of the state machine. `st` is {cur, held} and is mutated in place,
   so this works the same whether it's walking a decoded file or being fed one
   live frame at a time — which is the point of pulling it out. The two paths
   drifting apart would mean a stream that doesn't match its own exports. */
function stepMap(st, v, thr, hold, N) {
  let want = bandOf(v, thr, N);

  // hysteresis: must clear the boundary by a margin before switching,
  // otherwise a value sitting on the edge chatters between two mouths
  if (want > st.cur && bandOf(v - HYST, thr, N) <= st.cur) want = st.cur;
  else if (want < st.cur && bandOf(v + HYST, thr, N) >= st.cur) want = st.cur;

  // minimum hold — the single most important step. without it, strobing.
  if (want !== st.cur && st.held < hold) { want = st.cur; }

  if (want === st.cur) st.held++;
  else { st.cur = want; st.held = 1; }
  return st.cur;
}

function remap() {
  if (!S.rms || !S.keyed.length) return;
  const thr = parseInt($("thr").value, 10);
  const hold = parseInt($("hold").value, 10);
  const N = S.keyed.length;
  const len = S.rms.length;
  const map = new Int16Array(len);

  const st = { cur: 0, held: 0 };
  for (let f = 0; f < len; f++) map[f] = stepMap(st, S.rms[f], thr, hold, N);

  S.mapping = map;
  let closed = 0;
  for (let f = 0; f < len; f++) if (map[f] === 0) closed++;
  $("stFrames").textContent = len;
  $("stClosed").textContent = Math.round((closed / len) * 100) + "%";
  drawWave();
  drawFrameAt(currentFrame());
}
