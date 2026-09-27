# Architecture

This fork splits the original single-file `catsync.html` into a small set of
plain files. This note explains the split, and — since it's the one place a
framework choice would usually go — why there's no framework here at all.

## Why not React (or any framework)

The app is fundamentally canvas and `<input>` manipulation driven by a
handful of pure functions (slice → key → analyze → map → render → export).
There's no routing, no large tree of reusable visual components, and no
state that needs to flow through more than one or two levels — a framework's
main selling points don't apply here. Introducing one would add a build step
and a dependency the project has specifically avoided since it started, for
no corresponding gain: the actual complexity this fork needed to manage was
*UX* complexity (what's visible when), not *rendering* complexity.

## Why not ES modules either

The natural "modern vanilla" answer is `<script type="module">` with real
`import`/`export`. It was tried and rejected for one concrete reason:
**module scripts are blocked by CORS when a page is opened via `file://`** in
Chrome and Firefox. That breaks the project's core distribution model —
"download `catsync.html`, double-click it, it works, nothing is installed."
A visitor opening the file directly (not through GitHub Pages or a local
server) would get a blank page with console errors and no explanation.

## What's actually here

Classic (non-module) scripts, one per concern, loaded in dependency order
via plain `<script src="src/….js">` tags at the end of `<body>`. Classic
scripts share one global scope — the same scope the original single `<script>`
block had — so every function still calls every other function exactly as
it did before the split; nothing was renamed or rewired to make this work.
The only rule the split enforces is load order: a file that *calls* a
function must come after the file that *defines* it. `app.js` is loaded
last, and it's the only file that runs wiring at load time (event listeners,
initial draws) — every other file only declares functions and constants, so
their own load order relative to each other rarely matters in practice.

```
catsync.html      markup + the toolbar/modal shell
styles.css        one stylesheet, mobile-first, light theme
src/
  state.js        the S object — one source of truth for sprite/audio/
                   frame/viewport/export state, shared by every module below
  slicing.js      sprite sheet → grid slicing, auto-detect, per-frame crop
  keying.js       chroma keying + the sliced-frames thumbnail strip
  audio.js        decode, per-frame RMS analysis, mic recording
  mapping.js      loudness → sprite index (the lip-sync state machine)
  render.js       preview canvas, waveform, viewport/crop, playback loop
  align.js        onion-skin alignment (offsets, auto-align) + the shared
                  draggable-rect toolkit (corner/edge grips, body-move) used
                  both by the export viewport and by per-frame dragging
  zip.js          ZIP writer for the PNG sequence export
  webm.js         WebM container duration repair
  exportfiles.js  PNG sequence export + WebM real-time recording export
  live.js         live mode: mic straight to a pop-out window, for OBS
  demo.js         demo assets — a throwaway sheet + clip
  uicore.js       msg/err, the confirm dialog, drop-zone wiring, updateReady()
  app.js          bootstrap: the toolbar/modal system, then every event
                  listener — loaded last, after everything it calls exists
```

`state.js`'s `S` object is the one source of truth mentioned in `uicore.js`'s
`updateReady()`: every other module reads and writes the same `S.sheetImg`,
`S.rects`, `S.offsets`, `S.crop`, `S.mapping` — so a frame edited in the
Frames modal is the exact same frame object played back, exported to PNG,
exported to WebM, and driven live, never a separate copy kept in sync by
hand.

## UI split from core logic

`app.js` and `uicore.js` are the only two files that know about the toolbar,
modals, or which panel is open. Everything else — slicing, keying, audio
analysis, mapping, rendering, alignment, export, live mode — only reads and
writes `S` and a handful of DOM elements it owns (a canvas, a set of inputs),
the same way it did in the single-file version. That's what makes the modal
redesign in this version possible without touching any of those files: the
UI changed, the pipeline underneath it didn't.

## Extending this

To add a new control: add the input to `catsync.html` (inside whichever
modal makes sense — Frames for per-frame concerns, Advanced for everything
else), read its value from wherever the relevant `src/*.js` file already
reads its neighbors, and wire its event listener in `app.js` next to the
others from the same section. No build step, no bundler — refresh the page.
