import { initAudio, setVolume } from './audio';
import {
  initUI, handleFiles, togglePlay, stopAll, clearAll, seek,
  getActive, switchLane, getTracks,
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

btnPlay.addEventListener('click', togglePlay);
btnStop.addEventListener('click', stopAll);
btnAnalyzeAll.addEventListener('click', () => { runAnalysisAll(getTracks()); });
btnClear.addEventListener('click', () => {
  clearAll();
  vscode.postMessage({ type: 'clearLoaded' });
});
volSlider.addEventListener('input', () => { setVolume(volSlider.valueAsNumber / 100); });

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
  if (e.code === 'Space' && e.shiftKey) { e.preventDefault(); switchLane(); }
  else if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'Escape') { e.preventDefault(); stopAll(); }
  if (e.code === 'ArrowLeft') { e.preventDefault(); const t = getActive(); if (t) seek(getPos(t) - 2); }
  if (e.code === 'ArrowRight') { e.preventDefault(); const t = getActive(); if (t) seek(getPos(t) + 2); }
});
