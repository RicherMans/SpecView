import { initAudio, setVolume } from './audio';
import {
  initUI, handleFiles, togglePlay, stopAll, clearAll, seek,
  getActive, switchLane, getTracks,
  zoomIn, zoomOut, zoomFit, setWaveformVisible, pauseAll,
  moveToNextCard, moveToPrevCard, deleteActiveTrack, handleFileURIs,
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
const { audioCtx } = initAudio();

// Initialize UI
initUI();

// VS Code API
const vscode = acquireVsCodeApi();
(window as any).__vscodePostMessage = vscode.postMessage.bind(vscode);

// Listen for messages from extension host
const fileDataCallbacks = new Map<string, { resolve: (raw: ArrayBuffer) => void; reject: (e: Error) => void }>();

// Serial message queue — ensures filesData finishes decoding before fileURIs creates lazy cards.
// Without this, fileURIs (sync) would run before filesData (async decode) completes,
// causing lazy cards to appear before decoded cards in the DOM.
let messageQueue = Promise.resolve();

window.addEventListener('message', (event) => {
  const msg = event.data;
  messageQueue = messageQueue.then(() => handleMessage(msg)).catch(e => console.error('Message handler error:', e));
});

async function handleMessage(msg: any): Promise<void> {
  if (msg.type === 'fileData') {
    const raw = base64ToArrayBuffer(msg.base64);
    // Check if this is a response to a lazy load request
    if (msg.filePath) {
      const cb = fileDataCallbacks.get(msg.filePath);
      if (cb) {
        fileDataCallbacks.delete(msg.filePath);
        cb.resolve(raw);
        return;
      }
      // Late response after timeout — discard to avoid duplicate tracks
      if (msg.filePath.startsWith('file://') || msg.filePath.startsWith('tar:')) return;
    }
    await decodeAndAddFile(msg.name, msg.filePath, raw);
  } else if (msg.type === 'filesData') {
    await decodeAndAddBatch(msg.files);
  } else if (msg.type === 'archiveFiles') {
    await decodeAndAddBatch(msg.files);
  } else if (msg.type === 'fileURIs') {
    handleFileURIs(msg.files);
  } else if (msg.type === 'fileDataError') {
    const cb = fileDataCallbacks.get(msg.uri);
    if (cb) {
      fileDataCallbacks.delete(msg.uri);
      cb.reject(new Error(msg.message));
    }
  } else if (msg.type === 'error') {
    console.error('Extension error:', msg.message);
  }
}

/**
 * Request file data from extension host for lazy-loaded track.
 * Returns decoded ArrayBuffer when data arrives.
 */
export function requestFileData(uri: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      fileDataCallbacks.delete(uri);
      reject(new Error('Timeout requesting file data: ' + uri));
    }, 30000);
    fileDataCallbacks.set(uri, {
      resolve: (raw: ArrayBuffer) => { clearTimeout(timeout); resolve(raw); },
      reject: (e: Error) => { clearTimeout(timeout); reject(e); },
    });
    vscode.postMessage({ type: 'requestFileData', uri });
  });
}

// Expose requestFileData globally for ui.ts to avoid circular dependency
(window as any).__requestFileData = requestFileData;

// Signal readiness to extension host
vscode.postMessage({ type: 'ready' });

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function decodeAndAddFile(name: string, filePath: string | undefined, arrayBuffer: ArrayBuffer): Promise<void> {
  try {
    const nativeSR = parseNativeSampleRate(arrayBuffer) || null;
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
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

async function decodeAndAddBatch(files: { name: string; filePath?: string; base64: string }[]): Promise<void> {
  const promises = files.map(async (f) => {
    try {
      const raw = base64ToArrayBuffer(f.base64);
      const nativeSR = parseNativeSampleRate(raw) || null;
      const decoded = await audioCtx.decodeAudioData(raw.slice(0));
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
  const items = (await Promise.all(promises)).filter(Boolean) as DecodedItem[];
  if (items.length > 0) handleFiles(items);
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
  clearAll();
  vscode.postMessage({ type: 'clearLoaded' });
});
volSlider.addEventListener('input', () => { setVolume(volSlider.valueAsNumber / 100); });

// Waveform toggle
const chkWaveform = document.getElementById('chk-waveform') as HTMLInputElement;
chkWaveform.addEventListener('change', () => { setWaveformVisible(chkWaveform.checked); });

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

// Drag-and-drop for archives: send to extension host for extraction
const ARCHIVE_EXT = /\.(tar|tar\.gz|tgz)$/i;
let dragCounter = 0;

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as ArrayBuffer;
      const bytes = new Uint8Array(result);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      resolve(btoa(binary));
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  const overlay = document.getElementById('drop-overlay');
  if (overlay) overlay.classList.add('visible');
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    const overlay = document.getElementById('drop-overlay');
    if (overlay) overlay.classList.remove('visible');
  }
});

document.addEventListener('dragover', (e) => { e.preventDefault(); });

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  const overlay = document.getElementById('drop-overlay');
  if (overlay) overlay.classList.remove('visible');

  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const audioFiles: File[] = [];
  const archiveFiles: File[] = [];

  for (const f of Array.from(files)) {
    if (ARCHIVE_EXT.test(f.name)) {
      archiveFiles.push(f);
    } else {
      audioFiles.push(f);
    }
  }

  // Send archives to extension host for extraction
  for (const af of archiveFiles) {
    try {
      if (overlay) {
        overlay.classList.add('visible');
        overlay.querySelector('.drop-overlay-text')!.textContent = 'Extracting: ' + af.name + '...';
      }
      const base64 = await readFileAsBase64(af);
      vscode.postMessage({ type: 'archiveData', name: af.name, base64 });
    } catch (err) {
      console.error('Failed to read archive:', af.name, err);
    }
  }
  if (overlay) overlay.classList.remove('visible');
});
