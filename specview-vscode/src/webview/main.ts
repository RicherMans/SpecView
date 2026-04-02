import { initAudio, setVolume } from './audio';
import {
  initUI, handleFiles, togglePlay, stopAll, clearAll, seek,
  getActive, switchLane, getTracks,
  zoomIn, zoomOut, zoomFit, setWaveformVisible, pauseAll,
  moveToNextCard, moveToPrevCard,
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
window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (msg.type === 'fileData') {
    const raw = base64ToArrayBuffer(msg.base64);
    await decodeAndAddFile(msg.name, msg.filePath, raw);
  } else if (msg.type === 'filesData') {
    await decodeAndAddBatch(msg.files);
  } else if (msg.type === 'error') {
    console.error('Extension error:', msg.message);
  }
});

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
