'use strict';
const path = require('node:path');
/** Content check: ID3v2 tag, or a valid MPEG audio frame header in the first 4 KiB. Extension and MIME are not trusted. */
function looksLikeMp3(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  const limit = Math.min(buf.length - 3, 4096);
  for (let i = 0; i < limit; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (buf[i + 1] >> 3) & 3;
    const layer = (buf[i + 1] >> 1) & 3;
    const bitrate = (buf[i + 2] >> 4) & 15;
    const sample = (buf[i + 2] >> 2) & 3;
    if (version !== 1 && layer !== 0 && bitrate !== 15 && bitrate !== 0 && sample !== 3) return true;
  }
  return false;
}
/** Display name only (never used as a filesystem path). Same rule as the original safeMp3Name. */
function safeMp3Name(name) {
  const base = path.basename(String(name || 'audio.mp3')).replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180);
  return /\.mp3$/i.test(base) ? base : `${base || 'audio'}.mp3`;
}

const BITRATES = {
  // MPEG version: 1 = V1, 2/0 = V2/V2.5; layer bits: 3 = L1, 2 = L2, 1 = L3
  V1L1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  V1L2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  V1L3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  V2L1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  V2L23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Locate the first valid MPEG audio frame header, skipping any ID3v2 tag. */
function firstFrame(buf) {
  let start = 0;
  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size;
  }
  const limit = Math.min(buf.length - 4, start + 100000);
  for (let i = start; i < limit; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const verBits = (buf[i + 1] >> 3) & 3;      // 0=V2.5, 2=V2, 3=V1
    const layerBits = (buf[i + 1] >> 1) & 3;    // 1=L3, 2=L2, 3=L1
    const bitrateIdx = (buf[i + 2] >> 4) & 15;
    const sampleIdx = (buf[i + 2] >> 2) & 3;
    if (verBits === 1 || layerBits === 0 || bitrateIdx === 15 || bitrateIdx === 0 || sampleIdx === 3) continue;
    const version = verBits === 3 ? 1 : 2;
    const layer = 4 - layerBits;
    const table = version === 1 ? (layer === 1 ? BITRATES.V1L1 : layer === 2 ? BITRATES.V1L2 : BITRATES.V1L3) : (layer === 1 ? BITRATES.V2L1 : BITRATES.V2L23);
    const bitrate = table[bitrateIdx];
    const sampleRate = SAMPLE_RATES[sampleIdx][version === 1 ? 0 : 1];
    if (!bitrate || !sampleRate) continue;
    return { offset: i, version, layer, bitrate, sampleRate };
  }
  return null;
}

/** Best-effort duration in whole seconds. Reads a Xing/Info VBR header when present, else estimates
 * from the first frame's bitrate and the file's total size. Returns null when nothing is parseable;
 * callers must treat that as "duration unknown", never as an upload failure. */
function estimateDuration(buf, fileSize) {
  try {
    const frame = firstFrame(buf);
    if (!frame) return null;
    const samplesPerFrame = frame.layer === 1 ? 384 : (frame.layer === 3 && frame.version !== 1 ? 576 : 1152);
    const sideInfo = frame.version === 1 ? 32 : 17;
    const xingAt = frame.offset + 4 + sideInfo;
    if (buf.length >= xingAt + 8) {
      const tag = buf.toString('latin1', xingAt, xingAt + 4);
      if ((tag === 'Xing' || tag === 'Info') && (buf.readUInt32BE(xingAt + 4) & 0x1)) {
        const frames = buf.readUInt32BE(xingAt + 8);
        if (frames > 0) return Math.round((frames * samplesPerFrame) / frame.sampleRate);
      }
    }
    const size = Number(fileSize) || buf.length;
    return Math.round((size * 8) / (frame.bitrate * 1000));
  } catch { return null; }
}

module.exports = { looksLikeMp3, safeMp3Name, estimateDuration };
