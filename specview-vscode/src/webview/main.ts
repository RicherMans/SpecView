import { initAudio, setVolume, decodeToAudioBuffer } from './audio';
import {
  initUI, handleFiles, togglePlay, stopAll, clearAll, seek,
  getActive, switchLane, getTracks,
  zoomIn, zoomOut, zoomFit, setWaveformVisible, pauseAll,
  moveToNextCard, moveToPrevCard, deleteActiveTrack, handleFileURIs,
  receiveMetaData, receiveMetaURIs, setMetaVisible,
} from './ui';
import { getPos } from './audio';
import { runAnalysisAll } from './analysis';
import { parseNativeSampleRate } from './grouping';
import { STYLES } from './styles';
import type { DecodedItem } from './types';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(state: unknown): void; };

// Inject styles
const styleEl = document.createElement('style');
styleEl.textContent = STYLES;
document.head.appendChild(styleEl);

// Initialize audio
initAudio();

// Initialize UI
initUI();

// Diagnostic for the paired-JSON metadata feature.
console.log('[specview] meta-feature:', !!document.getElementById('chk-meta'));

// VS Code API
const vscode = acquireVsCodeApi();
(window as any).__vscodePostMessage = vscode.postMessage.bind(vscode);

// Listen for messages from extension host
const fileDataCallbacks = new Map<string, {
  resolve: (raw: ArrayBuffer) => void;
  reject: (e: Error) => void;
  buffer?: Uint8Array;
  received: number;
}>();

// Message handling: chunked lazy-load responses are resolved synchronously (fast
// path); everything else goes through a serial queue to preserve ordering.
let messageQueue = Promise.resolve();
// Bumped by Clear All so messages queued before it (fileURIs/metaData) and any
// in-flight lazy load cannot repopulate the view afterwards.
let clearEpoch = 0;

window.addEventListener('message', (event) => {
  const msg = event.data;

  // Fast path: chunked source assembly must bypass the serial UI queue.
  if (msg.type === 'fileDataStart' && msg.requestId) {
    const cb = fileDataCallbacks.get(msg.requestId);
    if (!cb) return;
    try {
      if (!Number.isSafeInteger(msg.size) || msg.size < 0) throw new Error('Invalid file data start');
      cb.buffer = new Uint8Array(msg.size);
      cb.received = 0;
    } catch (error) {
      fileDataCallbacks.delete(msg.requestId);
      cb.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return;
  }
  if (msg.type === 'fileDataChunk' && msg.requestId) {
    const cb = fileDataCallbacks.get(msg.requestId);
    if (!cb) return;
    try {
      if (!cb.buffer || msg.offset !== cb.received || typeof msg.base64 !== 'string') throw new Error('Invalid file data chunk');
      const chunk = decodeBase64Chunk(msg.base64);
      if (cb.received + chunk.byteLength > cb.buffer.byteLength) throw new Error('File data exceeds declared size');
      cb.buffer.set(chunk, cb.received);
      cb.received += chunk.byteLength;
    } catch (error) {
      fileDataCallbacks.delete(msg.requestId);
      cb.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return;
  }
  if (msg.type === 'fileDataEnd' && msg.requestId) {
    const cb = fileDataCallbacks.get(msg.requestId);
    if (!cb) return;
    fileDataCallbacks.delete(msg.requestId);
    if (!cb.buffer || cb.received !== cb.buffer.byteLength) cb.reject(new Error('Incomplete file data response'));
    else cb.resolve(cb.buffer.buffer as ArrayBuffer);
    return;
  }
  if (msg.type === 'fileDataError') {
    const cb = fileDataCallbacks.get(msg.requestId);
    if (cb) {
      fileDataCallbacks.delete(msg.requestId);
      cb.reject(new Error(msg.message));
    }
    return;
  }

  // Serial queue for everything else; drop messages that predate a Clear All.
  const epoch = clearEpoch;
  messageQueue = messageQueue
    .then(() => epoch === clearEpoch ? handleMessage(msg) : undefined)
    .catch(e => console.error('Message handler error:', e));
});

async function handleMessage(msg: any): Promise<void> {
  if (msg.type === 'fileData') {
    const raw = await base64ToArrayBuffer(msg.base64);
    await decodeAndAddFile(msg.name, msg.filePath, raw);
  } else if (msg.type === 'filesData') {
    await decodeAndAddBatch(msg.files);
  } else if (msg.type === 'archiveFiles') {
    await decodeAndAddBatch(msg.files);
  } else if (msg.type === 'fileURIs') {
    handleFileURIs(msg.files);
  } else if (msg.type === 'metaData') {
    receiveMetaData(msg.items || []);
  } else if (msg.type === 'metaURIs') {
    receiveMetaURIs(msg.files || []);
  } else if (msg.type === 'error') {
    console.error('Extension error:', msg.message);
  }
}

/**
 * Request file data from extension host for a lazy-loaded track.
 * Returns decoded ArrayBuffer when the chunked response completes.
 */
export function requestFileData(sourceId: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      fileDataCallbacks.delete(requestId);
      reject(new Error('Timeout requesting file data: ' + sourceId));
    }, 120000);
    fileDataCallbacks.set(requestId, {
      received: 0,
      resolve: (raw: ArrayBuffer) => { clearTimeout(timeout); resolve(raw); },
      reject: (e: Error) => { clearTimeout(timeout); reject(e); },
    });
    vscode.postMessage({ type: 'requestFileData', sourceId, requestId });
  });
}

// Expose requestFileData globally for ui.ts to avoid circular dependency
(window as any).__requestFileData = requestFileData;

// Signal readiness to extension host
vscode.postMessage({ type: 'ready' });

function decodeBase64Chunk(base64: string): Uint8Array {
  const binary = atob(base64);
  const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
  return data;
}

async function base64ToArrayBuffer(base64: string): Promise<ArrayBuffer> {
  // Decode base64 in chunks to avoid data URI size limits and keep the UI responsive.
  const len = base64.length;
  const CHUNK = 1 << 20; // 1M chars per chunk
  const raw = new Uint8Array((len * 3) >> 2);
  let pos = 0;
  for (let i = 0; i < len; i += CHUNK) {
    const chunk = atob(base64.substring(i, Math.min(i + CHUNK, len)));
    for (let j = 0; j < chunk.length; j++) raw[pos++] = chunk.charCodeAt(j);
    if (i + CHUNK < len) await new Promise<void>(r => setTimeout(r, 0));
  }
  return raw.buffer;
}

async function decodeAndAddFile(name: string, filePath: string | undefined, arrayBuffer: ArrayBuffer): Promise<void> {
  try {
    const nativeSR = parseNativeSampleRate(arrayBuffer) || null;
    const decoded = await decodeToAudioBuffer(arrayBuffer);
    const item: DecodedItem = {
      name,
      filePath,
      buffer: decoded,
      nativeSR: nativeSR || decoded.sampleRate,
    };
    handleFiles([item]);
  } catch (e) {
    console.error('Decode error:', name, e);
  }
}

const DECODE_CONCURRENCY = 3;

async function decodeAndAddBatch(files: { name: string; filePath?: string; base64: string }[]): Promise<void> {
  // Process in chunks to limit concurrent memory usage.
  // Each chunk is decoded and rendered incrementally to avoid accumulating
  // all decoded AudioBuffers in memory before any UI update.
  for (let i = 0; i < files.length; i += DECODE_CONCURRENCY) {
    const chunk = files.slice(i, i + DECODE_CONCURRENCY);
    const promises = chunk.map(async (f) => {
      try {
        const raw = await base64ToArrayBuffer(f.base64);
        const nativeSR = parseNativeSampleRate(raw) || null;
        const decoded = await decodeToAudioBuffer(raw);
        return {
          name: f.name,
          filePath: f.filePath,
          buffer: decoded,
          nativeSR: nativeSR || decoded.sampleRate,
        } as DecodedItem;
      } catch (e) {
        console.error('Decode error:', f.name, e);
        return null;
      }
    });
    const results = (await Promise.all(promises)).filter(Boolean) as DecodedItem[];
    // Render incrementally: add each chunk to UI as soon as it's decoded
    if (results.length > 0) handleFiles(results);
  }
}

// Drop zone click → ask extension host to open file dialog
const dropZone = document.getElementById('drop-zone')!;
dropZone.addEventListener('click', () => {
  vscode.postMessage({ type: 'openFile' });
});

// Toolbar buttons
const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const btnAnalyzeAll = document.getElementById('btn-analyze-all') as HTMLButtonElement;
const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;
const volSlider = document.getElementById('vol-slider') as HTMLInputElement;

const btnZoomIn = document.getElementById('btn-zoom-in') as HTMLButtonElement;
const btnZoomOut = document.getElementById('btn-zoom-out') as HTMLButtonElement;
const btnZoomFit = document.getElementById('btn-zoom-fit') as HTMLButtonElement;

btnPlay.addEventListener('click', togglePlay);
btnStop.addEventListener('click', stopAll);
btnZoomIn.addEventListener('click', zoomIn);
btnZoomOut.addEventListener('click', zoomOut);
btnZoomFit.addEventListener('click', zoomFit);
btnAnalyzeAll.addEventListener('click', () => { runAnalysisAll(getTracks()); });
btnClear.addEventListener('click', () => {
  clearEpoch++;
  for (const [requestId, cb] of Array.from(fileDataCallbacks)) {
    fileDataCallbacks.delete(requestId);
    cb.reject(new Error('Cleared'));
  }
  clearAll();
  vscode.postMessage({ type: 'clearLoaded' });
});
volSlider.addEventListener('input', () => { setVolume(volSlider.valueAsNumber / 100); });

// Waveform toggle
const chkWaveform = document.getElementById('chk-waveform') as HTMLInputElement;
chkWaveform.addEventListener('change', () => { setWaveformVisible(chkWaveform.checked); });

// JSON metadata toggle
const chkMeta = document.getElementById('chk-meta') as HTMLInputElement;
if (chkMeta) chkMeta.addEventListener('change', () => { setMetaVisible(chkMeta.checked); });

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;

  // Zoom shortcuts: Shift+Up / Shift+Down / Shift+Left
  if (e.shiftKey && e.code === 'ArrowUp') { e.preventDefault(); zoomIn(); return; }
  if (e.shiftKey && e.code === 'ArrowDown') { e.preventDefault(); zoomOut(); return; }
  if (e.shiftKey && e.code === 'ArrowLeft') { e.preventDefault(); zoomFit(); return; }

  // Card navigation: Up / Down (no modifier)
  if (!e.shiftKey && e.code === 'ArrowUp') { e.preventDefault(); moveToPrevCard(); return; }
  if (!e.shiftKey && e.code === 'ArrowDown') { e.preventDefault(); moveToNextCard(); return; }

  // Delete active track
  if (e.code === 'Delete') { e.preventDefault(); deleteActiveTrack(); return; }

  if (e.code === 'Space' && e.shiftKey) { e.preventDefault(); switchLane(); }
  else if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'Escape') { e.preventDefault(); stopAll(); }
  if (e.code === 'ArrowLeft' && !e.shiftKey) { e.preventDefault(); const t = getActive(); if (t) seek(getPos(t) - 2); }
  if (e.code === 'ArrowRight' && !e.shiftKey) { e.preventDefault(); const t = getActive(); if (t) seek(getPos(t) + 2); }
});

// Pause playback when webview loses visibility (user switches to another panel/tab)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pauseAll();
  }
});


