"use strict";
/* webm.js — WebM container duration repair.
   Part of CatSync (fork). Classic script, shares one global scope with the
   other src/ files — see ARCHITECTURE.md for why this isn't ES modules. */

/* ══════════════════════════════════════════════════════════
   5b. WebM duration repair

   MediaRecorder writes a *live-stream* WebM: the Segment has unknown
   size and the Info block carries no Duration element, because when
   recording starts the length genuinely isn't known yet. Nothing
   backfills it on stop. Players and editors then have to guess the
   length from cluster timecodes, and many guess low — which is why the
   clip looks shorter than the audio.

   We know the exact intended length (frames ÷ fps), so write it in.
   Any surprise while parsing returns the original blob untouched: a
   slightly-wrong duration beats a corrupted file.
   ══════════════════════════════════════════════════════════ */

const EBML_ID = {
  SEGMENT: 0x18538067, INFO: 0x1549A966, DURATION: 0x4489, TIMECODESCALE: 0x2AD7B1,
  SEEKHEAD: 0x114D9B74, CUES: 0x1C53BB6B,
};

function readVint(b, pos) {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  let len = 1;
  for (let m = 0x80; m && !(first & m); m >>= 1) len++;
  if (len > 8 || pos + len > b.length) return null;
  let value = first & (0xFF >> len);
  let unknown = value === (0xFF >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[pos + i];
    if (b[pos + i] !== 0xFF) unknown = false;
  }
  return { value, len, unknown };
}

function readId(b, pos) {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  let len = 1;
  for (let m = 0x80; m && !(first & m); m >>= 1) len++;
  if (len > 4 || pos + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[pos + i];
  return { id, len };
}

function writeVint(value) {
  let len = 1;
  while (len < 8 && value >= Math.pow(2, 7 * len) - 1) len++;
  const out = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) { out[i] = v & 0xFF; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

/* walk one level of children, returns [{id, start, headerLen, size, unknown}] */
function ebmlChildren(b, start, end) {
  const out = [];
  let pos = start;
  while (pos < end) {
    const id = readId(b, pos);
    if (!id) return out;
    const sz = readVint(b, pos + id.len);
    if (!sz) return out;
    const headerLen = id.len + sz.len;
    out.push({ id: id.id, start: pos, headerLen, size: sz.value, unknown: sz.unknown });
    if (sz.unknown) return out;                       // can't skip past it
    pos += headerLen + sz.value;
  }
  return out;
}

/* How much video the encoder has actually committed, in ms.

   A realtime MediaRecorder can fall behind on a large canvas: frames queue up
   inside the encoder and stop() throws away whatever hasn't been written yet,
   silently truncating the end. Wall-clock time says nothing about this, so
   read it out of the stream — every Cluster carries an absolute Timecode, so
   the highest one seen is how far the encoding has genuinely got. */
function scanClusterTimecodes(bytes, soFar) {
  let best = soFar;
  for (let i = 0; i + 8 < bytes.length; i++) {
    if (bytes[i] !== 0x1F || bytes[i+1] !== 0x43 || bytes[i+2] !== 0xB6 || bytes[i+3] !== 0x75) continue;
    const sz = readVint(bytes, i + 4);
    if (!sz) continue;
    let p = i + 4 + sz.len;
    if (bytes[p] !== 0xE7) continue;                 // Timecode must lead a Cluster
    const tsz = readVint(bytes, p + 1);
    if (!tsz || tsz.value > 8 || tsz.value < 1) continue;
    let v = 0;
    for (let k = 0; k < tsz.value; k++) v = v * 256 + bytes[p + 1 + tsz.len + k];
    if (v > best) best = v;                          // TimecodeScale 1e6 => ms
  }
  return best;
}

function patchWebmDuration(bytes, seconds) {
  try {
    const top = ebmlChildren(bytes, 0, bytes.length);
    const seg = top.find(e => e.id === EBML_ID.SEGMENT);
    if (!seg) return null;

    const segStart = seg.start + seg.headerLen;
    const segEnd = seg.unknown ? bytes.length : segStart + seg.size;
    const info = ebmlChildren(bytes, segStart, segEnd).find(e => e.id === EBML_ID.INFO);
    if (!info || info.unknown) return null;

    const infoStart = info.start + info.headerLen;
    const infoEnd = infoStart + info.size;
    const kids = ebmlChildren(bytes, infoStart, infoEnd);

    // Duration is expressed in TimecodeScale units (default 1ms)
    let scale = 1000000;
    const ts = kids.find(e => e.id === EBML_ID.TIMECODESCALE);
    if (ts) {
      let v = 0;
      for (let i = 0; i < ts.size; i++) v = v * 256 + bytes[ts.start + ts.headerLen + i];
      if (v > 0) scale = v;
    }
    const durValue = (seconds * 1e9) / scale;

    const existing = kids.find(e => e.id === EBML_ID.DURATION);
    if (existing) {
      // overwrite in place — same length, nothing else moves
      const out = bytes.slice();
      const at = existing.start + existing.headerLen;
      const dv = new DataView(out.buffer, out.byteOffset);
      if (existing.size === 4) dv.setFloat32(at, durValue, false);
      else if (existing.size === 8) dv.setFloat64(at, durValue, false);
      else return null;
      return out;
    }

    // Inserting bytes shifts everything after Info, which would invalidate the
    // absolute byte offsets inside a SeekHead or Cues. MediaRecorder's live
    // profile writes neither, but if one is there, leave the file alone.
    const segKids = ebmlChildren(bytes, segStart, segEnd);
    if (segKids.some(e => e.id === EBML_ID.SEEKHEAD || e.id === EBML_ID.CUES)) return null;

    // no Duration element: append one to Info and resize Info
    const dur = new Uint8Array(11);
    dur[0] = 0x44; dur[1] = 0x89;                     // Duration id
    dur[2] = 0x88;                                    // 8-byte payload
    new DataView(dur.buffer).setFloat64(3, durValue, false);

    const newInfoSize = info.size + dur.length;
    const newSizeVint = writeVint(newInfoSize);

    // rebuild: everything before Info | Info id | new size | old content + Duration | rest
    const idLen = readId(bytes, info.start).len;
    const head = bytes.subarray(0, info.start);
    const idPart = bytes.subarray(info.start, info.start + idLen);
    const body = bytes.subarray(infoStart, infoEnd);
    const tail = bytes.subarray(infoEnd);

    const out = new Uint8Array(head.length + idPart.length + newSizeVint.length + body.length + dur.length + tail.length);
    let p = 0;
    out.set(head, p); p += head.length;
    out.set(idPart, p); p += idPart.length;
    out.set(newSizeVint, p); p += newSizeVint.length;
    out.set(body, p); p += body.length;
    out.set(dur, p); p += dur.length;
    out.set(tail, p);

    // if Segment had a known size it just grew, and fixing that is more
    // surgery than this is worth — bail rather than emit something wrong
    if (!seg.unknown) return null;
    return out;
  } catch (e) {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════
   6. exports
   ══════════════════════════════════════════════════════════ */
