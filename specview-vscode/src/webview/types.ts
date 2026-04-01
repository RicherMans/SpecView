export interface Track {
  id: number;
  name: string;
  buffer: AudioBuffer;
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
  playing: boolean;
  startTime: number;
  offset: number;
  source: AudioBufferSourceNode | null;
  groupId: number | null;
  el: HTMLElement | null;
  analysisResults: AnalysisSpan[] | null;
  _pendingRender?: (() => void) | null;
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
}

export interface GroupResult {
  baseName: string;
  items: DecodedItem[];
}
