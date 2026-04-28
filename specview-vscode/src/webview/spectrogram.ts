import type { Track } from './types';

export const FFT_SIZE = 2048;
export const SPEC_H = 220;
export const SPEC_H_DIFF = 180;
export const HOP_DIV = 4;
export const DB_RANGE = 90;

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
 * Compute full STFT for a track and cache the results.
 * Call this once when the track is first loaded.
 */
export function computeSpec(track: Track, H: number): void {
  if (!track.buffer) return;
  const { buffer, nyquist } = track;
  const sr = buffer.sampleRate;
  const raw = buffer.numberOfChannels === 1 ? buffer.getChannelData(0) : mixDown(buffer);
  const nS = raw.length;

  const win = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));

  const nBins = (FFT_SIZE >> 1) + 1;
  const binHz = sr / FFT_SIZE;
  const maxBin = Math.min(nBins - 1, Math.ceil(nyquist / binHz));

  // Adaptive hop: use smaller hop for short files to fill the canvas width
  const W = track.canvas ? track.canvas.width : 1000;
  const defaultHop = FFT_SIZE / HOP_DIV;
  const defaultFrames = Math.max(1, Math.floor((nS - FFT_SIZE) / defaultHop) + 1);
  let hop: number;
  if (defaultFrames < W && nS > FFT_SIZE) {
    hop = Math.max(1, Math.floor((nS - FFT_SIZE) / (W - 1)));
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

  // Cache results on the track
  let globalPeak = -Infinity;
  for (let i = 0; i < colDb.length; i++) {
    if (colDb[i] > globalPeak) globalPeak = colDb[i];
  }
  track.specData = colDb;
  track.specFrames = nF;
  track.specHop = hop;
  track.specH = H;
  track.specMaxBin = maxBin;
  track.specGlobalPeak = globalPeak;
}

/**
 * Draw the visible portion [viewStart, viewEnd] of the cached STFT data to the canvas.
 * Fast operation — no FFT, just pixel mapping from cached data.
 */
export function drawSpec(track: Track): void {
  if (!track.buffer) return;
  const { canvas, specData, specFrames, specHop, specH } = track;
  if (!canvas || !specData || !specFrames) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  if (W === 0 || H === 0) return;

  const sr = track.buffer.sampleRate;
  const nS = track.buffer.length;
  const nF = specFrames;
  const hop = specHop;

  // Map viewStart/viewEnd to frame indices
  const startSample = Math.max(0, Math.floor(track.viewStart * sr));
  const endSample = Math.min(nS, Math.ceil(track.viewEnd * sr));
  const startFrame = Math.max(0, Math.floor((startSample - FFT_SIZE / 2) / hop));
  const endFrame = Math.min(nF - 1, Math.ceil((endSample - FFT_SIZE / 2) / hop));
  const visibleFrames = Math.max(1, endFrame - startFrame + 1);

  // Use global peak for consistent normalization regardless of zoom level
  // This prevents silent regions from suddenly appearing bright when zoomed in
  let peak = track.specGlobalPeak;
  if (peak < -120) peak = -50; // fallback for entirely silent files
  const floor = peak - DB_RANGE;
  const invRange = 1 / DB_RANGE;

  const img = ctx.createImageData(W, H);
  const px = img.data;
  const px32 = new Uint32Array(px.buffer);
  const isLE = new Uint8Array(new Uint32Array([0x0A0B0C0D]).buffer)[0] === 0x0D;

  for (let x = 0; x < W; x++) {
    // Map pixel x to a frame in the visible range
    const col = Math.min(startFrame + Math.round(x * visibleFrames / W), endFrame);
    const base = col * H;
    for (let y = 0; y < H; y++) {
      const db = specData[base + y];
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
 * Backward-compatible entry point.
 */
export function renderSpec(track: Track): void {
  const H = track.canvas ? track.canvas.height : SPEC_H;
  if (!track.specData) {
    computeSpec(track, H);
  }
  drawSpec(track);
}

/**
 * Draw time-domain waveform for the visible region [viewStart, viewEnd].
 * Shows amplitude envelope as min/max vertical bars per pixel column.
 */
export function drawWaveform(track: Track): void {
  if (!track.buffer) return;
  const canvas = track.waveformCanvas;
  if (!canvas) return;

  // Sync canvas width with spectrogram canvas for time alignment
  const refW = track.canvas ? track.canvas.width : 0;
  if (refW > 0 && canvas.width !== refW) {
    canvas.width = refW;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  if (W === 0 || H === 0) return;

  // Get audio data (mix down to mono)
  const buf = track.buffer;
  const raw = buf.numberOfChannels === 1 ? buf.getChannelData(0) : (() => {
    const out = new Float32Array(buf.getChannelData(0).length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < ch.length; i++) out[i] += ch[i];
    }
    for (let i = 0; i < out.length; i++) out[i] /= buf.numberOfChannels;
    return out;
  })();

  const sr = buf.sampleRate;
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
    ctx.beginPath();
    ctx.moveTo(x, yMin);
    ctx.lineTo(x, yMax);
    ctx.stroke();
  }
}

/**
 * Compute waveform height for a given spec height.
 */
export function getWaveformHeight(specH: number): number {
  return Math.round(specH / 3);
}
