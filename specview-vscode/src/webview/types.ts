export interface Track {
  id: number;
  name: string;
  buffer: AudioBuffer;
  loaded: boolean;             // false when track is a lazy placeholder
  duration: number;
  nyquist: number;
  sr: number;
  nativeSR: number;
  renderSR: number;
  canvas: HTMLCanvasElement | null;
  wrapper: HTMLElement | null;
  ph: HTMLElement | null;
  laneLabel: HTMLElement | null;
  analysisStrip: HTMLElement | null;
  analyzeBtn: HTMLButtonElement | null;
  rulerEl: HTMLElement | null;
  playing: boolean;
  startTime: number;
  offset: number;
  source: AudioBufferSourceNode | null;
  groupId: number | null;
  el: HTMLElement | null;
  analysisResults: AnalysisSpan[] | null;
  filePath?: string;   // full path, for same-name different-directory grouping
  lazyUri?: string;    // webview-accessible URI for lazy-loaded tracks
  _loading?: boolean;  // prevents concurrent load requests
  _pendingRender?: (() => void) | null;
  // Zoom state
  viewStart: number;   // visible region start (seconds), default 0
  viewEnd: number;     // visible region end (seconds), default duration
  // Cached STFT data for fast zoom/scroll redraws
  specData: Float32Array | null;   // column-major dB values [nFrames * specH]
  specFrames: number;              // number of STFT frames computed
  specHop: number;                 // hop size used for computation
  specH: number;                   // height (rows) of cached data
  specMaxBin: number;              // max frequency bin used
  specGlobalPeak: number;          // global peak dB across entire spectrogram
  // Waveform state
  waveformCanvas: HTMLCanvasElement | null;
  waveformWrapper: HTMLElement | null;
  waveformRow: HTMLElement | null;
  waveformPh: HTMLElement | null;
}

export interface Group {
  id: number;
  baseName: string;
  trackIds: number[];
  el: HTMLElement;
}

export interface AnalysisSpan {
  label: string;
  labelIdx: number;
  startSec: number;
  endSec: number;
  maxProb: number;
}

export interface DecodedItem {
  name: string;        // basename, used for grouping key
  filePath?: string;   // full path, used for cross-directory display
  buffer: AudioBuffer;
  nativeSR: number;
  suffix?: string;
  lazyUri?: string;    // for lazy tracks that haven't been loaded yet
}

export interface GroupResult {
  baseName: string;
  items: DecodedItem[];
}
