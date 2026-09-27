"use strict";
/* state.js — state — shared application data model, the one source of truth.
   Part of CatSync (fork). Classic script, shares one global scope with the
   other src/ files — see ARCHITECTURE.md for why this isn't ES modules. */

"use strict";

/* ══════════════════════════════════════════════════════════
   state
   ══════════════════════════════════════════════════════════ */
const S = {
  sheetImg: null,      // HTMLImageElement / canvas of the raw sheet
  slices: [],          // [canvas] raw cells, unkeyed
  keyed: [],           // [canvas] cells with key color knocked to alpha 0
  audioBuffer: null,   // decoded AudioBuffer
  audioURL: null,
  takeBlob: null,      // WAV of the last mic recording, so a take can be saved
  rms: null,           // Float32Array, one normalized 0-100 value per video frame
  mapping: null,       // Int16Array, sprite index per video frame
  fps: 30,
  offsets: [],         // [{dx,dy}] per sprite, whole pixels — manual alignment
  sel: 0,              // sprite currently being aligned
  crop: null,          // {x,y,w,h} in sprite px — the exported viewport
  cellW: 0, cellH: 0,
  grid: null,          // {ox,oy,cw,ch,gx,gy} — where the cells actually sit on the sheet
  rects: [],           // [{x,y,w,h}] per frame, sheet px — grid cell, or an individual override
};

const DB_FLOOR = -60;   // anything quieter than this is treated as pure silence
const HYST = 3;         // hysteresis margin, on the 0-100 loudness scale

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
