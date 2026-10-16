import type { Track, ChannelView } from './types';

export const FFT_SIZE = 2048;
export const SPEC_H = 220;
export const SPEC_H_DIFF = 180;
export const CH_SPEC_H = 150;   // per-channel lane height for multichannel display
export const HOP_DIV = 4;
export const DB_RANGE = 90;
// Absolute full-scale reference in this pipeline's dB units: a full-amplitude
// sine through a Hann window peaks at ~FFT_SIZE/4, i.e. 20*log10(FFT_SIZE/4).
// Used so a near-silent file is NOT normalized up to full brightness (which
// would amplify a few-LSB noise floor into a misleading full-scale spectrogram).
export const FULL_SCALE_DB = 20 * Math.log10(FFT_SIZE / 4);

const COLORMAP: [number, number, number][] = [
  [0, 0, 0],
  [2, 2, 20],
  [5, 5, 50],
  [15, 10, 90],
  [35, 15, 130],
  [70, 20, 150],
  [110, 15, 140],
  [150, 10, 110],
  [185, 20, 60],
  [210, 50, 20],
  [230, 90, 5],
  [245, 140, 0],
  [255, 185, 0],
  [255, 220, 40],
  [255, 245, 140],
  [255, 255, 220],
];

export const CMAP_LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const t = i / 255;
  const p = t * (COLORMAP.length - 1);
  const idx = Math.min(Math.floor(p), COLORMAP.length - 2);
  const f = p - idx;
  const a = COLORMAP[idx], b = COLORMAP[idx + 1];
  CMAP_LUT[i * 3] = Math.round(a[0] + (b[0] - a[0]) * f);
  CMAP_LUT[i * 3 + 1] = Math.round(a[1] + (b[1] - a[1]) * f);
  CMAP_LUT[i * 3 + 2] = Math.round(a[2] + (b[2] - a[2]) * f);
}

export function fftFwd(re: Float64Array, im: Float64Array, N: number): void {
  for (let i = 1, j = 0; i < N; i++) {
    let b = N >> 1;
    for (; j & b; b >>= 1) j ^= b;
    j ^= b;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const h = len >> 1;
    const ang = -2 * Math.PI / len;
    const wR = Math.cos(ang);
    const wI = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cR = 1, cI = 0;
      for (let j = 0; j < h; j++) {
        const a = i + j, bb = i + j + h;
        const tR = cR * re[bb] - cI * im[bb];
        const tI = cR * im[bb] + cI * re[bb];
        re[bb] = re[a] - tR;
        im[bb] = im[a] - tI;
        re[a] += tR;
        im[a] += tI;
        const nr = cR * wR - cI * wI;
        cI = cR * wI + cI * wR;
        cR = nr;
      }
    }
  }
}

function mixDown(buf: AudioBuffer): Float32Array {
  const out = new Float32Array(buf.getChannelData(0).length);
  const nC = buf.numberOfChannels;
  for (let c = 0; c < nC; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < ch.length; i++) out[i] += ch[i];
  }
  const s = 1 / nC;
  for (let i = 0; i < out.length; i++) out[i] *= s;
  return out;
}

/**
 * The subset of fields the spectrogram/waveform pipeline needs from a lane.
 * A mono/single-view lane is the Track itself; a channel lane is one entry of
 * track.chViews. Both expose these same-named fields.
 */
interface LaneSurface {
  canvas: HTMLCanvasElement | null;
  waveformCanvas: HTMLCanvasElement | null;
  specData: Float32Array | null;
  specFrames: number;
  specHop: number;
  specH: number;
  specMaxBin: number;
  specGlobalPeak: number;
}

/** A computed STFT that can be reused across rebuilds / lane-height changes. */
interface SpecCacheEntry {
  specData: Float32Array;
  specFrames: number;
  specHop: number;
  specH: number;
  specMaxBin: number;
  specGlobalPeak: number;
}

/**
 * Per-buffer spectrogram cache so that toggling grouping (which tears down and
 * rebuilds tracks) does not recompute the STFT every time. Weakly keyed by the
 * AudioBuffer: once a buffer is garbage-collected its cache disappears too.
 * The lane key is -1 for the single (mono/mixdown) view and the channel index
 * otherwise.
 */
const specCache = new WeakMap<AudioBuffer, Map<number, SpecCacheEntry>>();

function specCacheGet(buffer: AudioBuffer, chIndex: number): SpecCacheEntry | null {
  const byBuf = specCache.get(buffer);
  if (!byBuf) return null;
  return byBuf.get(chIndex) ?? null;
}

function specCacheSet(buffer: AudioBuffer, chIndex: number, entry: SpecCacheEntry): void {
  let byBuf = specCache.get(buffer);
  if (!byBuf) { byBuf = new Map(); specCache.set(buffer, byBuf); }
  byBuf.set(chIndex, entry);
}

/** Mono samples for a single-view lane, or the samples of one channel. */
export function rawSamples(track: Track, chIndex: number): Float32Array {
  const buf = track.buffer;
  if (chIndex >= 0) return buf.getChannelData(chIndex);
  return buf.numberOfChannels === 1 ? buf.getChannelData(0) : mixDown(buf);
}

/** Compute the full STFT for one lane of a track. When `chIndex >= 0` the lane
 *  is a channel view (raw samples + spec cache from track.chViews[chIndex]);
 *  otherwise it is the single (mono/mixdown) view stored directly on the track.
 */
export function computeSpec(track: Track, H: number, chIndex = -1): void {
  const lane: LaneSurface = chIndex >= 0 ? track.chViews[chIndex] : track;
  if (!track.buffer) return;
  const { buffer, nyquist } = track;
  const sr = buffer.sampleRate;
  const raw = rawSamples(track, chIndex);
  const nS = raw.length;

  const win = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));

  const nBins = (FFT_SIZE >> 1) + 1;
  const binHz = sr / FFT_SIZE;
  const maxBin = Math.min(nBins - 1, Math.ceil(nyquist / binHz));

  const W = lane.canvas ? lane.canvas.width : 1000;
  const defaultHop = FFT_SIZE / HOP_DIV;
  let hop: number;
  if (nS > FFT_SIZE) {
    hop = Math.max(1, Math.floor((nS - FFT_SIZE) / Math.max(1, W - 1)));
  } else {
    hop = defaultHop;
  }
  const nF = Math.max(1, Math.floor((nS - FFT_SIZE) / hop) + 1);

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const colDb = new Float32Array(nF * H);

  const rowBin = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    rowBin[y] = (1 - y / (H - 1)) * maxBin;
  }

  for (let c = 0; c < nF; c++) {
    const off = c * hop;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = off + i;
      re[i] = idx < nS ? raw[idx] * win[i] : 0;
      im[i] = 0;
    }
    fftFwd(re, im, FFT_SIZE);

    const base = c * H;
    for (let y = 0; y < H; y++) {
      const fb = rowBin[y];
      const b0 = fb | 0;
      const b1 = b0 < maxBin ? b0 + 1 : b0;
      const t = fb - b0;
      const m0 = Math.sqrt(re[b0] * re[b0] + im[b0] * im[b0]);
      const m1 = Math.sqrt(re[b1] * re[b1] + im[b1] * im[b1]);
      const mag = m0 * (1 - t) + m1 * t;
      colDb[base + y] = mag > 1e-12 ? 20 * Math.log10(mag) : -140;
    }
  }

  // Cache results on the lane
  let globalPeak = -Infinity;
  for (let i = 0; i < colDb.length; i++) {
    if (colDb[i] > globalPeak) globalPeak = colDb[i];
  }
  lane.specData = colDb;
  lane.specFrames = nF;
  lane.specHop = hop;
  lane.specH = H;
  lane.specMaxBin = maxBin;
  lane.specGlobalPeak = globalPeak;
  if (track.buffer) {
    specCacheSet(track.buffer, chIndex, {
      specData: colDb, specFrames: nF, specHop: hop, specH: H, specMaxBin: maxBin, specGlobalPeak: globalPeak,
    });
  }
}

/**
 * Draw the visible portion [viewStart, viewEnd] of the cached STFT data to the
 * lane canvas. Fast operation — no FFT, just pixel mapping from cached data.
 */
export function drawSpec(track: Track, chIndex = -1): void {
  const lane: LaneSurface = chIndex >= 0 ? track.chViews[chIndex] : track;
  if (!track.buffer) return;
  const { canvas, specData, specFrames, specHop, specH } = lane;
  if (!canvas || !specData || !specFrames) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  if (W === 0 || H === 0) return;

  const sr = track.buffer.sampleRate;
  const nS = track.buffer.length;
  const nF = specFrames;
  const hop = specHop;

  // Absolute-reference normalization: the scale top is at least full scale
  // (0 dBFS) rather than the file's own peak, so quiet / near-silent files stay
  // dark instead of having their noise floor stretched to full brightness.
  let peak = lane.specGlobalPeak;
  if (peak < -120) peak = -50; // fallback for entirely silent files (renders black)
  peak = Math.max(peak, FULL_SCALE_DB);
  const floor = peak - DB_RANGE;
  const invRange = 1 / DB_RANGE;

  const halfFFT = FFT_SIZE / 2;
  const viewSpan = track.viewEnd - track.viewStart;

  const img = ctx.createImageData(W, H);
  const px = img.data;
  const px32 = new Uint32Array(px.buffer);
  const isLE = new Uint8Array(new Uint32Array([0x0A0B0C0D]).buffer)[0] === 0x0D;

  for (let x = 0; x < W; x++) {
    // Map pixel x directly to time, then find the nearest STFT frame.
    // Frame c represents audio centered at time (c * hop + FFT_SIZE/2) / sr,
    // so this keeps the spectrogram time axis aligned with the waveform and playhead.
    const t_x = track.viewStart + (x / W) * viewSpan;
    const col = Math.max(0, Math.min(nF - 1, Math.round((t_x * sr - halfFFT) / hop)));
    const base = col * specH;
    for (let y = 0; y < H; y++) {
      // Scale y from canvas height to cached specData height when they differ
      const srcY = H === specH ? y : Math.round(y * (specH - 1) / (H - 1));
      const db = specData[base + srcY];
      let norm = (db - floor) * invRange;
      if (norm < 0) norm = 0; else if (norm > 1) norm = 1;
      const li = (norm * 255 + 0.5) | 0;
      const ci = li * 3;
      const o = y * W + x;
      if (isLE) {
        px32[o] = 0xFF000000 | (CMAP_LUT[ci + 2] << 16) | (CMAP_LUT[ci + 1] << 8) | CMAP_LUT[ci];
      } else {
        px32[o] = (CMAP_LUT[ci] << 24) | (CMAP_LUT[ci + 1] << 16) | (CMAP_LUT[ci + 2] << 8) | 0xFF;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Full render: compute STFT (if not cached) then draw visible region.
 * Backward-compatible entry point for a single view (mono). For a channel lane
 * pass chIndex >= 0.
 *
 * The computed STFT is cached per buffer+channel. Regrouping/splitting tears
 * down and rebuilds tracks (which start with no spec data); on such re-renders
 * the cache is restored so no expensive FFT re-run happens. drawSpec already
 * re-samples vertically when the target canvas height differs (e.g. a standalone
 * card at SPEC_H vs a diff-group lane at SPEC_H_DIFF), so a cached spectrum is
 * reusable across those two layouts.
 */
export function renderSpec(track: Track, chIndex = -1): void {
  const lane: LaneSurface = chIndex >= 0 ? track.chViews[chIndex] : track;
  const H = lane.canvas ? lane.canvas.height : SPEC_H;
  const W = lane.canvas ? lane.canvas.width : 0;
  if (W === 0) return; // canvas not laid out yet — skip until it has a real width
  // Restore cached spectrum (if any) onto the lane before deciding to compute.
  if (!lane.specData && track.buffer) {
    const cached = specCacheGet(track.buffer, chIndex);
    if (cached) {
      lane.specData = cached.specData;
      lane.specFrames = cached.specFrames;
      lane.specHop = cached.specHop;
      lane.specH = cached.specH;
      lane.specMaxBin = cached.specMaxBin;
      lane.specGlobalPeak = cached.specGlobalPeak;
    }
  }
  if (!lane.specData ||
      (W > 1 && lane.specFrames <= 1 && track.buffer && track.buffer.length > FFT_SIZE)) {
    // Recompute if: no cached data, or only 1 frame was cached due to
    // canvas.width being 0 at compute time.
    computeSpec(track, H, chIndex);
  }
  drawSpec(track, chIndex);
}

/**
 * Draw the time-domain waveform for a lane. When chIndex >= 0 only that channel
 * is drawn; otherwise the mono mixdown envelope is used (current behavior).
 */
export function drawWaveform(track: Track, chIndex = -1): void {
  const lane: LaneSurface = chIndex >= 0 ? track.chViews[chIndex] : track;
  if (!track.buffer) return;
  const canvas = lane.waveformCanvas;
  if (!canvas) return;

  // Sync canvas width with the spectrogram canvas of the same lane
  const refW = lane.canvas ? lane.canvas.width : 0;
  if (refW > 0 && canvas.width !== refW) {
    canvas.width = refW;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  if (W === 0 || H === 0) return;

  const raw = rawSamples(track, chIndex);
  const sr = track.buffer.sampleRate;
  const nS = raw.length;
  const startSample = Math.max(0, Math.floor(track.viewStart * sr));
  const endSample = Math.min(nS, Math.ceil(track.viewEnd * sr));
  const visibleSamples = endSample - startSample;
  if (visibleSamples <= 0) return;

  const samplesPerPixel = visibleSamples / W;
  const mid = H / 2;

  // Clear and draw background
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, W, H);

  // Draw zero line
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(W, mid);
  ctx.stroke();

  // Draw waveform envelope (min/max per pixel column)
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let x = 0; x < W; x++) {
    const sStart = Math.floor(startSample + x * samplesPerPixel);
    const sEnd = Math.min(nS, Math.ceil(startSample + (x + 1) * samplesPerPixel));

    let min = 1, max = -1;
    for (let s = sStart; s < sEnd; s++) {
      const v = raw[s];
      if (v < min) min = v;
      if (v > max) max = v;
    }

    // Map amplitude [-1, 1] to pixel Y
    const yMin = mid - max * mid;
    const yMax = mid - min * mid;
    ctx.moveTo(x, yMin);
    ctx.lineTo(x, yMax);
  }
  ctx.stroke();
}

/**
 * Compute waveform height for a given spec height.
 */
export function getWaveformHeight(specH: number): number {
  return Math.round(specH / 3);
}

/** Per-channel spec height — scaled down as channel count grows. */
export function channelSpecHeight(chCount: number): number {
  if (chCount <= 2) return SPEC_H;
  if (chCount <= 4) return CH_SPEC_H;
  return Math.max(80, Math.round(CH_SPEC_H * 4 / chCount));
}

export type { ChannelView };
