import type { Track } from './types';

let audioCtx: AudioContext;
let gainNode: GainNode;

/** Maximum master gain: 4.0 ≈ +12 dB, so quiet material can be boosted. */
const GAIN_MAX = 4;

/** Map a slider value in [0,1] to master gain (square curve).
 *  0 → 0, 0.5 → 1.0 (unity), 1 → GAIN_MAX (+12 dB). */
export function volumeGain(v: number): number {
  const x = Math.min(1, Math.max(0, v));
  return GAIN_MAX * x * x;
}

export function initAudio(): { audioCtx: AudioContext; gainNode: GainNode } {
  audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  gainNode = audioCtx.createGain();
  gainNode.connect(audioCtx.destination);
  gainNode.gain.value = volumeGain(0.5);
  (window as any).__audioCtx = audioCtx;
  return { audioCtx, gainNode };
}

export function getAudioContext(): AudioContext {
  return audioCtx;
}

export function setVolume(v: number): void {
  if (!gainNode) return;
  // Short time constant avoids clicks/zipper noise while dragging the slider.
  gainNode.gain.setTargetAtTime(volumeGain(v), audioCtx.currentTime, 0.01);
}

/** Routing nodes created for a per-channel mute play, so stopSource can
 *  disconnect them and prevent leaks. */
interface RouteNodes {
  split: ChannelSplitterNode;
  gains: GainNode[];
}

const activeRoutes = new WeakMap<AudioBufferSourceNode, RouteNodes>();

/** Per-channel gain (0/1) for a track, driven by mute state. Returns null only
 *  for mono buffers (direct connect is fine). 2+ channel buffers always go
 *  through the splitter/mixer route so every channel's samples sum into the
 *  mix (WebAudio's stereo up-mix duplicates mono to both ears) instead of a
 *  stereo buffer mapping L→L, R→R. */
function channelGains(t: Track): number[] | null {
  const n = t.buffer.numberOfChannels;
  if (n <= 1) return null;
  const g: number[] = [];
  for (let c = 0; c < n; c++) {
    g.push(t.mutedCh.has(c) ? 0 : 1);
  }
  return g;
}

export function playSource(t: Track, from: number): void {
  if (!t.buffer) return;
  if (t.playing) stopSource(t);
  t.offset = from;
  t.startTime = audioCtx.currentTime;
  const src = audioCtx.createBufferSource();
  src.buffer = t.buffer;

  const gains = channelGains(t);
  if (gains) {
    // Route each channel through its own GainNode so mute really changes
    // what is audible. ChannelSplitter outputs are mono; they sum at gainNode.
    const n = t.buffer.numberOfChannels;
    const split = audioCtx.createChannelSplitter(n);
    const chGains: GainNode[] = [];
    for (let c = 0; c < n; c++) {
      const g = audioCtx.createGain();
      g.gain.value = gains[c];
      split.connect(g, c);
      g.connect(gainNode);
      chGains.push(g);
    }
    src.connect(split);
    activeRoutes.set(src, { split, gains: chGains });
  } else {
    src.connect(gainNode);
  }

  src.start(0, from);
  t.source = src;
  t.playing = true;
  src.onended = () => {
    // Only clear state if this source is still the active one
    // (prevents stale onended from a previous source clearing the new source's state)
    if (t.source === src) {
      t.offset = t.duration;
      t.playing = false;
      t.source = null;
    }
    const route = activeRoutes.get(src);
    if (route) {
      activeRoutes.delete(src);
      try { src.disconnect(); } catch { /* ignore */ }
      try { route.split.disconnect(); } catch { /* ignore */ }
      for (const g of route.gains) { try { g.disconnect(); } catch { /* ignore */ } }
    }
  };
}

export function stopSource(t: Track): void {
  if (!t.playing) return;
  t.offset = Math.min(t.offset + audioCtx.currentTime - t.startTime, t.duration);
  try { t.source!.stop(); } catch { /* ignore */ }
  if (t.source) {
    const route = activeRoutes.get(t.source);
    if (route) {
      activeRoutes.delete(t.source);
      try { t.source.disconnect(); } catch { /* ignore */ }
      try { route.split.disconnect(); } catch { /* ignore */ }
      for (const g of route.gains) { try { g.disconnect(); } catch { /* ignore */ } }
    }
  }
  t.source = null;
  t.playing = false;
}

/** Rebuild the audio route when mute state changed during playback. */
export function applyChannelListen(t: Track): void {
  if (!t.buffer || t.buffer.numberOfChannels <= 1) return;
  if (t.playing) {
    const pos = Math.min(t.offset + audioCtx.currentTime - t.startTime, t.duration);
    playSource(t, pos);
  }
}

export function getPos(t: Track): number {
  if (!audioCtx) return t.offset;
  return t.playing ? Math.min(t.offset + audioCtx.currentTime - t.startTime, t.duration) : t.offset;
}

export function resumeAudio(): void {
  if (audioCtx) audioCtx.resume();
}

/* Fast RIFF/WAVE PCM decoder → AudioBuffer, avoiding the much slower
   audioCtx.decodeAudioData() for plain PCM .wav files (common in webdataset /
   ACAV shards). Returns null for anything else so callers fall back to
   decodeAudioData. Keeps the file's native sample rate (no resampling). */
export function decodeWavBuffer(arrayBuffer: ArrayBuffer): AudioBuffer | null {
  const v = new DataView(arrayBuffer);
  if (v.byteLength < 12) return null;
  if (v.getUint32(0, true) !== 0x46464952) return null;   /* 'RIFF' */
  if (v.getUint32(8, true) !== 0x45564157) return null;   /* 'WAVE' */

  let fmt: { format: number; channels: number; sampleRate: number; blockAlign: number; bits: number } | null = null;
  let dataOff = -1, dataLen = 0;
  let off = 12;
  while (off + 8 <= v.byteLength) {
    const id = v.getUint32(off, true);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 0x20746D66) {                              /* 'fmt ' */
      if (body + 16 <= v.byteLength) {
        fmt = {
          format: v.getUint16(body, true),
          channels: v.getUint16(body + 2, true),
          sampleRate: v.getUint32(body + 4, true),
          blockAlign: v.getUint16(body + 12, true),
          bits: v.getUint16(body + 14, true),
        };
      }
    } else if (id === 0x61746164) {                       /* 'data' */
      dataOff = body; dataLen = size;
      break;
    }
    if (size === 0) break;
    off = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0 || fmt.channels < 1 || fmt.channels > 32 ||
      !(fmt.sampleRate > 0) || fmt.blockAlign < 1) return null;

  const isPcm = fmt.format === 1;
  const isFloat = fmt.format === 3 && fmt.bits === 32;
  if (!isPcm && !isFloat) return null;
  const bps = fmt.bits >> 3;
  if (bps < 1 || fmt.blockAlign !== bps * fmt.channels) return null;

  const usable = Math.min(dataLen, v.byteLength - dataOff);
  const frames = Math.floor(usable / fmt.blockAlign);
  if (frames < 1) return null;

  let buf: AudioBuffer;
  try { buf = audioCtx.createBuffer(fmt.channels, frames, fmt.sampleRate); }
  catch { return null; }
  const stride = fmt.blockAlign;

  if (isFloat) {
    for (let ch = 0; ch < fmt.channels; ch++) {
      const d = buf.getChannelData(ch);
      const base = ch * 4;
      for (let f = 0; f < frames; f++) d[f] = v.getFloat32(dataOff + f * stride + base, true);
    }
  } else if (fmt.bits === 8) {
    for (let ch = 0; ch < fmt.channels; ch++) {
      const d = buf.getChannelData(ch);
      for (let f = 0; f < frames; f++) d[f] = (v.getUint8(dataOff + f * stride + ch) - 128) / 128;
    }
  } else if (fmt.bits === 16) {
    for (let ch = 0; ch < fmt.channels; ch++) {
      const d = buf.getChannelData(ch);
      const base = ch * 2;
      for (let f = 0; f < frames; f++) d[f] = v.getInt16(dataOff + f * stride + base, true) / 32768;
    }
  } else if (fmt.bits === 24) {
    for (let ch = 0; ch < fmt.channels; ch++) {
      const d = buf.getChannelData(ch);
      const base = ch * 3;
      for (let f = 0; f < frames; f++) {
        const b = dataOff + f * stride + base;
        let s = v.getUint8(b) | (v.getUint8(b + 1) << 8) | (v.getUint8(b + 2) << 16);
        if (s & 0x800000) s |= ~0xFFFFFF;
        d[f] = s / 8388608;
      }
    }
  } else if (fmt.bits === 32) {
    for (let ch = 0; ch < fmt.channels; ch++) {
      const d = buf.getChannelData(ch);
      const base = ch * 4;
      for (let f = 0; f < frames; f++) d[f] = v.getInt32(dataOff + f * stride + base, true) / 2147483648;
    }
  } else {
    return null;
  }
  return buf;
}

/* Decode audio bytes to an AudioBuffer: fast path for PCM WAVs, otherwise
   the standard decodeAudioData (handles MP3/OGG/FLAC/…). */
export function decodeToAudioBuffer(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  const fast = decodeWavBuffer(arrayBuffer);
  if (fast) return Promise.resolve(fast);
  return audioCtx.decodeAudioData(arrayBuffer.slice(0));
}
