import type { Track, Group, DecodedItem } from './types';
import { SPEC_H, SPEC_H_DIFF, renderSpec, drawSpec, drawWaveform, getWaveformHeight } from './spectrogram';
import { TAG_CSS, stripExt, extractTag, groupByBaseName, getParentFolderName, parseNativeSampleRate } from './grouping';
import { playSource, stopSource, getPos, resumeAudio } from './audio';
import { runAnalysis, runAnalysisGroup } from './analysis';
import { fmt, fmtShort, esc } from './util';

const MIN_VIEW_SPAN = 0.05; // minimum visible span in seconds
const ZOOM_FACTOR = 1.25;

let tracks: Track[] = [];
let groups: Group[] = [];
let nextId = 1;
let nextGrpId = 1;
let activeTrackId: number | null = null;
let rafId: number | null = null;
let waveformVisible = false;

let tracksBox: HTMLElement;
let dropZone: HTMLElement;
let btnPlay: HTMLButtonElement;
let btnStop: HTMLButtonElement;
let btnAnalyzeAll: HTMLButtonElement;
let btnZoomIn: HTMLButtonElement;
let btnZoomOut: HTMLButtonElement;
let btnZoomFit: HTMLButtonElement;
let timeDisp: HTMLElement;
let playIcon: HTMLElement;
let playLabel: HTMLElement;

// Lazy loading observer with concurrency limit
const MAX_CONCURRENT_LOADS = 3;
let activeLoads = 0;
const loadQueue: Track[] = [];

function enqueueLoad(t: Track): void {
  if (t.loaded || t._loading) return;
  if (!loadQueue.some(q => q.id === t.id)) loadQueue.push(t);
  drainLoadQueue();
}

function drainLoadQueue(): void {
  while (activeLoads < MAX_CONCURRENT_LOADS && loadQueue.length > 0) {
    const t = loadQueue.shift()!;
    if (t.loaded || t._loading || !isTrackAlive(t)) continue;
    activeLoads++;
    loadTrack(t).finally(() => {
      // Guard: only decrement if still positive. After clearAll() force-resets
      // activeLoads to 0, stale in-flight completions must not push it negative.
      if (activeLoads > 0) activeLoads--;
      drainLoadQueue();
    });
  }
}

const lazyObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const card = entry.target as HTMLElement;
      lazyObserver.unobserve(card);
      const trackId = card.dataset.trackId;
      const groupId = card.dataset.groupId;
      if (trackId) {
        const t = tracks.find(tr => tr.id === Number(trackId));
        if (t && !t.loaded) enqueueLoad(t);
      } else if (groupId) {
        const g = groups.find(gr => gr.id === Number(groupId));
        if (g) {
          for (const tid of g.trackIds) {
            const t = tracks.find(tr => tr.id === tid);
            if (t && !t.loaded) enqueueLoad(t);
          }
        }
      }
    }
  },
  { rootMargin: '800px' }
);

export function getTracks(): Track[] { return tracks; }
export function getGroups(): Group[] { return groups; }
export function getActive(): Track | undefined {
  return activeTrackId ? tracks.find(t => t.id === activeTrackId) : tracks[0];
}

export function getSiblings(t: Track): Track[] {
  if (t.groupId == null) return [t];
  const g = groups.find(g => g.id === t.groupId);
  if (!g) return [t];
  return g.trackIds.map(id => tracks.find(tr => tr.id === id)).filter(Boolean) as Track[];
}

function isTrackAlive(t: Track): boolean {
  return tracks.some(tr => tr.id === t.id);
}

async function loadTrack(t: Track): Promise<void> {
  if (t.loaded || t._loading) return;
  t._loading = true;

  try {
    const loading = t.el?.querySelector('.loading-overlay') as HTMLElement;
    if (loading) {
      loading.style.display = 'flex';
      loading.innerHTML = '<div class="spinner"></div>Loading...';
    }

    // Lazy track: request data from extension host
    if (!t.buffer && t.lazyUri) {
      const requestFileData = (window as any).__requestFileData as (uri: string) => Promise<ArrayBuffer>;
      if (!requestFileData) { t._loading = false; return; }
      const raw = await requestFileData(t.lazyUri);
      // Check if track was removed during async gap
      if (!isTrackAlive(t)) return;
      const nativeSR = parseNativeSampleRate(raw) || null;
      const decoded = await (window as any).__audioCtx.decodeAudioData(raw.slice(0));
      // Check again after second async gap
      if (!isTrackAlive(t)) return;
      t.buffer = decoded;
      t.nativeSR = nativeSR || decoded.sampleRate;
    }

    if (!t.buffer || !isTrackAlive(t)) return;

    t.loaded = true;
    t.duration = t.buffer.duration;
    t.sr = t.nativeSR || t.buffer.sampleRate;
    t.nyquist = t.sr / 2;
    t.renderSR = t.buffer.sampleRate;
    t.viewEnd = t.duration;
    // Trigger render
    if (t._pendingRender) {
      t._pendingRender();
      t._pendingRender = null;
    } else if (t.canvas && t.wrapper) {
      const w = t.wrapper.clientWidth;
      if (w > 0) {
        t.canvas.width = w;
        if (t.waveformCanvas) t.waveformCanvas.width = w;
        renderSpec(t);
        if (waveformVisible && t.waveformCanvas) drawWaveform(t);
      }
    }
    if (loading && loading.parentNode) loading.remove();
    // Enable analyze button for lazy-loaded tracks (created with disabled attribute)
    if (t.analyzeBtn) (t.analyzeBtn as HTMLButtonElement).disabled = false;
    // Update card info text
    updateCardInfo(t);
    updateRuler(t);
  } catch (e) {
    console.error('Failed to load track:', t.name, e);
    const loading = t.el?.querySelector('.loading-overlay') as HTMLElement;
    if (loading) {
      loading.innerHTML = '<span style="color:#e74c3c">Load failed: ' + esc(String((e as Error).message || e)) + '</span>';
    }
  } finally {
    t._loading = false;
  }
}

function updateCardInfo(t: Track): void {
  if (!t.el) return;
  const info = t.el.querySelector('.card-info');
  if (!info) return;
  if (t.loaded) {
    const ch = t.buffer.numberOfChannels === 1 ? 'Mono' : t.buffer.numberOfChannels === 2 ? 'Stereo' : t.buffer.numberOfChannels + 'ch';
    info.textContent = ch + ' ' + (t.sr / 1000).toFixed(1) + 'kHz | ' + fmt(t.duration);
  }
  // Update diff lane info too
  const laneInfo = t.laneLabel?.querySelector('.card-info');
  if (laneInfo && t.loaded) {
    laneInfo.textContent = (t.sr / 1000).toFixed(1) + 'kHz';
  }
}

function mkTrack(name: string, buffer: AudioBuffer | null, nativeSR: number, filePath?: string, lazyUri?: string): Track {
  const id = nextId++;
  const loaded = !!buffer;
  const dur = loaded ? buffer!.duration : 0;
  const displaySR = loaded ? (nativeSR || buffer!.sampleRate) : 0;
  const ny = displaySR / 2;
  return {
    id, name, buffer: buffer as AudioBuffer, loaded, duration: dur, nyquist: ny, sr: displaySR, nativeSR: displaySR, renderSR: loaded ? buffer!.sampleRate : 0,
    canvas: null, wrapper: null, ph: null, laneLabel: null, analysisStrip: null, analyzeBtn: null, rulerEl: null,
    playing: false, startTime: 0, offset: 0, source: null,
    groupId: null, el: null, analysisResults: null, filePath, lazyUri,
    viewStart: 0, viewEnd: dur,
    specData: null, specFrames: 0, specHop: 0, specH: 0, specMaxBin: 0, specGlobalPeak: -Infinity,
    waveformCanvas: null, waveformWrapper: null, waveformRow: null, waveformPh: null,
  };
}

function addFreqLabels(el: HTMLElement, ny: number): void {
  if (!ny || ny <= 0) return; // skip for unloaded tracks
  const allTicks = [200, 500, 1000, 2000, 4000, 8000, 12000, 16000, 20000, 24000];
  const h = parseInt(el.style.height) || 220;
  const MIN_GAP = 14;

  const candidates: { f: number; px: number; text: string; priority?: boolean }[] = [];
  const nyText = ny >= 1000 ? (ny / 1000).toFixed(ny % 1000 ? 1 : 0) + 'k' : String(ny);
  candidates.push({ f: ny, px: 5, text: nyText, priority: true });

  for (const f of allTicks) {
    if (f >= ny || f <= 0) continue;
    const frac = f / ny;
    const px = (1 - frac) * h;
    const text = f >= 1000 ? (f / 1000).toFixed(f % 1000 ? 1 : 0) + 'k' : String(f);
    candidates.push({ f, px, text });
  }

  const nyLabel = candidates.find(c => c.priority);
  const rest = candidates.filter(c => !c.priority);
  rest.sort((a, b) => b.px - a.px);

  const selected: typeof candidates = [];
  if (nyLabel) selected.push(nyLabel);
  let lastPx = nyLabel ? nyLabel.px : -Infinity;
  for (const c of rest) {
    if (c.px < h - 6 && c.px > 6 && Math.abs(c.px - lastPx) >= MIN_GAP) {
      selected.push(c);
      lastPx = c.px;
    }
  }

  for (const c of selected) {
    const pct = (c.px / h * 100) + '%';
    const tick = document.createElement('span');
    tick.className = 'freq-tick';
    tick.style.top = pct;
    el.appendChild(tick);
    const lbl = document.createElement('span');
    lbl.className = 'freq-label';
    lbl.style.top = pct;
    lbl.textContent = c.text;
    el.appendChild(lbl);
  }
}

function addWaveformLabels(el: HTMLElement, h: number): void {
  const labels = [
    { text: '1.0', top: 5 },
    { text: '0', top: h / 2 },
    { text: '-1.0', top: h - 5 },
  ];
  for (const l of labels) {
    const tick = document.createElement('span');
    tick.className = 'waveform-tick';
    tick.style.top = l.top + 'px';
    el.appendChild(tick);
    const lbl = document.createElement('span');
    lbl.className = 'waveform-label';
    lbl.style.top = l.top + 'px';
    lbl.textContent = l.text;
    el.appendChild(lbl);
  }
}

function buildSpecBody(track: Track, h: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'track-body';
  el.style.flexDirection = 'column';

  // Waveform row (height = 1/3 of spectrogram height)
  const wfH = getWaveformHeight(h);
  const waveRow = document.createElement('div');
  waveRow.className = 'waveform-row';
  waveRow.style.height = wfH + 'px';
  waveRow.style.display = waveformVisible ? 'flex' : 'none';
  waveRow.innerHTML =
    '<div class="waveform-labels" style="height:' + wfH + 'px"></div>' +
    '<div class="waveform-wrapper" style="flex:1;position:relative;overflow:hidden;cursor:crosshair">' +
    '<canvas height="' + wfH + '"></canvas>' +
    '<div class="waveform-playhead" style="position:absolute;top:0;left:0;width:2px;height:100%;background:#ff3333;pointer-events:none;z-index:10;will-change:transform"></div>' +
    '</div>';
  el.appendChild(waveRow);
  track.waveformRow = waveRow;
  track.waveformWrapper = waveRow.querySelector('.waveform-wrapper');
  track.waveformCanvas = waveRow.querySelector('canvas');
  track.waveformPh = waveRow.querySelector('.waveform-playhead');
  addWaveformLabels(waveRow.querySelector('.waveform-labels') as HTMLElement, wfH);

  // Spectrogram row
  const specRow = document.createElement('div');
  specRow.style.cssText = 'display:flex;flex:1;min-height:0';
  specRow.innerHTML =
    '<div class="freq-labels" style="height:' + h + 'px"></div>' +
    '<div class="spec-wrapper" style="height:' + h + 'px">' +
    '<canvas height="' + h + '"></canvas>' +
    '<div class="playhead" style="left:0"></div>' +
    '<div class="loading-overlay"><div class="spinner"></div>Rendering...</div>' +
    '</div>';
  el.appendChild(specRow);

  const strip = document.createElement('div');
  strip.className = 'analysis-strip empty';
  strip.style.paddingLeft = '44px';
  el.appendChild(strip);
  track.analysisStrip = strip;

  track.canvas = specRow.querySelector('canvas');
  track.wrapper = specRow.querySelector('.spec-wrapper');
  track.ph = specRow.querySelector('.playhead');
  addFreqLabels(specRow.querySelector('.freq-labels') as HTMLElement, track.nyquist);
  const loading = specRow.querySelector('.loading-overlay') as HTMLElement;

  // Click to seek (zoom-aware) — also on waveform wrapper
  const seekHandler = (e: MouseEvent) => {
    if ((track.wrapper as any)._wasDrag) { (track.wrapper as any)._wasDrag = false; return; }
    const rect = track.canvas!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, cx / rect.width));
    const time = track.viewStart + ratio * (track.viewEnd - track.viewStart);
    selectAndSeek(track, time);
  };
  track.wrapper!.addEventListener('click', seekHandler);
  track.waveformWrapper!.addEventListener('click', seekHandler);

  // Ctrl+wheel = zoom, plain wheel = horizontal scroll (when zoomed)
  const wheelHandler = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = track.canvas!.getBoundingClientRect();
      const mouseX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const factor = e.deltaY > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      applyZoom(track, mouseX, factor);
    } else {
      const span = track.viewEnd - track.viewStart;
      if (span >= track.duration - 0.001) return; // not zoomed, let default scroll
      e.preventDefault();
      const shift = (e.deltaY / 500) * span;
      applyPan(track, shift);
    }
  };
  track.wrapper!.addEventListener('wheel', wheelHandler, { passive: false });
  track.waveformWrapper!.addEventListener('wheel', wheelHandler, { passive: false });

  // Shift+drag = selection zoom
  let dragStartX: number | null = null;
  let selBox: HTMLElement | null = null;

  track.wrapper!.addEventListener('mousedown', e => {
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      dragStartX = e.clientX;
      selBox = document.createElement('div');
      selBox.className = 'zoom-selection';
      selBox.style.height = '100%';
      track.wrapper!.appendChild(selBox);
      // Register document listeners only during active drag
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    }
  });

  const onMouseMove = (e: MouseEvent) => {
    if (dragStartX === null || !selBox || !track.canvas) return;
    const rect = track.canvas.getBoundingClientRect();
    const left = Math.max(0, Math.min(dragStartX, e.clientX) - rect.left);
    const right = Math.min(rect.width, Math.max(dragStartX, e.clientX) - rect.left);
    selBox.style.left = left + 'px';
    selBox.style.width = (right - left) + 'px';
  };

  const onMouseUp = (e: MouseEvent) => {
    // Always clean up listeners on mouseup to prevent leaks
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    if (dragStartX === null) return;
    const rect = track.canvas!.getBoundingClientRect();
    const x1 = Math.max(0, (Math.min(dragStartX, e.clientX) - rect.left) / rect.width);
    const x2 = Math.min(1, (Math.max(dragStartX, e.clientX) - rect.left) / rect.width);
    if (selBox) selBox.remove();
    selBox = null;
    dragStartX = null;

    if (x2 - x1 < 0.01) return; // too small
    (track.wrapper as any)._wasDrag = true; // prevent click-to-seek

    const span = track.viewEnd - track.viewStart;
    const newStart = track.viewStart + x1 * span;
    const newEnd = track.viewStart + x2 * span;
    setTrackView(track, newStart, newEnd);
    syncGroupZoom(track);
    redrawTrack(track);
    updateRuler(track);
    // Redraw siblings in group
    if (track.groupId != null) {
      const sibs = getSiblings(track);
      for (const s of sibs) {
        if (s.id !== track.id) { redrawTrack(s); updateRuler(s); }
      }
    }
    updatePlayheads();
  };

  if (track.loaded) {
    track._pendingRender = () => {
      const w = track.wrapper!.clientWidth;
      if (w > 0) {
        track.canvas!.width = w;
        if (track.waveformCanvas) {
          track.waveformCanvas.width = w;
        }
        setTimeout(() => {
          renderSpec(track);
          if (waveformVisible && track.waveformCanvas) {
            drawWaveform(track);
          }
          if (loading && loading.parentNode) loading.remove();
        }, 0);
      } else {
        if (loading && loading.parentNode) loading.remove();
      }
    };
  } else {
    // Lazy track: show placeholder
    const loadingEl = el.querySelector('.loading-overlay') as HTMLElement;
    if (loadingEl) {
      loadingEl.innerHTML = '<span style="color:#666;font-size:11px">Waiting to load…</span>';
    }
    track._pendingRender = null;
  }
  return el;
}

function niceStep(rawStep: number): number {
  const nice = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const n of nice) {
    if (n >= rawStep * 0.8) return n;
  }
  return rawStep;
}

function buildRuler(track: Track): HTMLElement {
  const el = document.createElement('div');
  el.className = 'time-ruler';
  track.rulerEl = el;
  populateRuler(el, track.viewStart, track.viewEnd);
  return el;
}

function populateRuler(el: HTMLElement, viewStart: number, viewEnd: number): void {
  el.innerHTML = '';
  const viewSpan = viewEnd - viewStart;
  if (viewSpan <= 0) return;
  const step = niceStep(viewSpan / 10);
  // Start at the first nice-aligned tick >= viewStart
  const firstTick = Math.ceil(viewStart / step) * step;
  for (let t = firstTick; t <= viewEnd + 0.001; t += step) {
    const pct = ((t - viewStart) / viewSpan) * 100;
    if (pct < -1 || pct > 101) continue;
    const m = document.createElement('span');
    m.className = 'time-mark';
    m.textContent = fmtShort(t);
    m.style.position = 'absolute';
    m.style.left = pct + '%';
    el.appendChild(m);
  }
}

function updateRuler(track: Track): void {
  if (!track.rulerEl) return;
  populateRuler(track.rulerEl, track.viewStart, track.viewEnd);
}

// ========== ZOOM FUNCTIONS ==========

function setTrackView(track: Track, start: number, end: number): void {
  const span = Math.max(MIN_VIEW_SPAN, end - start);
  track.viewStart = Math.max(0, start);
  track.viewEnd = Math.min(track.duration, track.viewStart + span);
  // Adjust start if end was clamped
  if (track.viewEnd - track.viewStart < span && track.viewStart > 0) {
    track.viewStart = Math.max(0, track.viewEnd - span);
  }
}

function applyZoom(track: Track, anchorRatio: number, factor: number): void {
  const span = track.viewEnd - track.viewStart;
  const anchorTime = track.viewStart + anchorRatio * span;
  let newSpan = span * factor;
  newSpan = Math.max(MIN_VIEW_SPAN, Math.min(track.duration, newSpan));
  const newStart = anchorTime - anchorRatio * newSpan;
  setTrackView(track, newStart, newStart + newSpan);
  syncGroupZoom(track);
  redrawTrack(track);
  updateRuler(track);
  // Also redraw siblings
  if (track.groupId != null) {
    const sibs = getSiblings(track);
    for (const s of sibs) {
      if (s.id !== track.id) { redrawTrack(s); updateRuler(s); }
    }
  }
  updatePlayheads();
}

function applyPan(track: Track, shift: number): void {
  const span = track.viewEnd - track.viewStart;
  let newStart = track.viewStart + shift;
  newStart = Math.max(0, Math.min(track.duration - span, newStart));
  setTrackView(track, newStart, newStart + span);
  syncGroupZoom(track);
  redrawTrack(track);
  updateRuler(track);
  if (track.groupId != null) {
    const sibs = getSiblings(track);
    for (const s of sibs) {
      if (s.id !== track.id) { redrawTrack(s); updateRuler(s); }
    }
  }
  updatePlayheads();
}

function syncGroupZoom(track: Track): void {
  if (track.groupId == null) return;
  const sibs = getSiblings(track);
  for (const s of sibs) {
    if (s.id === track.id) continue;
    // Clamp both viewStart and viewEnd to the sibling's duration to prevent
    // inverted ranges (viewStart > viewEnd) when the sibling is shorter.
    s.viewEnd = Math.min(track.viewEnd, s.duration);
    s.viewStart = Math.min(track.viewStart, s.viewEnd);
    if (s.viewEnd - s.viewStart < MIN_VIEW_SPAN) {
      s.viewEnd = Math.min(s.duration, s.viewStart + MIN_VIEW_SPAN);
      if (s.viewEnd - s.viewStart < MIN_VIEW_SPAN) {
        s.viewStart = Math.max(0, s.viewEnd - MIN_VIEW_SPAN);
      }
    }
  }
}

function redrawTrack(track: Track): void {
  if (!track.canvas || !track.specData) return;
  drawSpec(track);
  if (waveformVisible && track.waveformCanvas) {
    drawWaveform(track);
  }
}

export function zoomIn(): void {
  const t = getActive();
  if (!t) return;
  applyZoom(t, 0.5, 1 / ZOOM_FACTOR);
}

export function zoomOut(): void {
  const t = getActive();
  if (!t) return;
  applyZoom(t, 0.5, ZOOM_FACTOR);
}

export function zoomFit(): void {
  const t = getActive();
  if (!t) return;
  setTrackView(t, 0, t.duration);
  syncGroupZoom(t);
  redrawTrack(t);
  updateRuler(t);
  if (t.groupId != null) {
    const sibs = getSiblings(t);
    for (const s of sibs) {
      if (s.id !== t.id) { redrawTrack(s); updateRuler(s); }
    }
  }
  updatePlayheads();
}

// ========== CARD NAVIGATION ==========

export function moveToNextCard(): void {
  const cards = Array.from(tracksBox.children) as HTMLElement[];
  if (cards.length === 0) return;
  const active = getActive();
  if (!active || !active.el) { if (tracks.length) setActive(tracks[0].id); return; }
  const idx = cards.indexOf(active.el);
  if (idx < 0) return;
  const nextIdx = (idx + 1) % cards.length;
  const nextCard = cards[nextIdx];
  const firstTrack = tracks.find(t => t.el === nextCard);
  if (firstTrack) {
    setActive(firstTrack.id);
    nextCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

export function moveToPrevCard(): void {
  const cards = Array.from(tracksBox.children) as HTMLElement[];
  if (cards.length === 0) return;
  const active = getActive();
  if (!active || !active.el) { if (tracks.length) setActive(tracks[0].id); return; }
  const idx = cards.indexOf(active.el);
  if (idx < 0) return;
  const prevIdx = (idx - 1 + cards.length) % cards.length;
  const prevCard = cards[prevIdx];
  const firstTrack = tracks.find(t => t.el === prevCard);
  if (firstTrack) {
    setActive(firstTrack.id);
    prevCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ========== WAVEFORM TOGGLE ==========

export function setWaveformVisible(visible: boolean): void {
  waveformVisible = visible;
  for (const t of tracks) {
    if (t.waveformRow) {
      t.waveformRow.style.display = visible ? 'flex' : 'none';
    }
    if (visible && t.waveformCanvas && t.loaded) {
      const w = t.wrapper!.clientWidth;
      if (w > 0) t.waveformCanvas.width = w;
      drawWaveform(t);
    }
  }
}

export function isWaveformVisible(): boolean {
  return waveformVisible;
}

// ========== PLAYBACK + SEEK ==========

function selectAndSeek(track: Track, time: number): void {
  if (!track.buffer) { setActive(track.id); return; }
  const was = track.playing;
  stopAllSources();
  setActive(track.id);
  time = Math.max(0, Math.min(time, track.duration));
  const sibs = getSiblings(track);
  for (const s of sibs) s.offset = Math.max(0, Math.min(time, s.duration));
  updatePlayheads();
  updateTimeDisplay();
  if (was) { playSource(track, track.offset); startAnim(); }
}

function setActive(id: number): void {
  activeTrackId = id;
  highlightActive();
  updateLaneHighlights();
  updateTimeDisplay();
}

export function highlightActive(): void {
  document.querySelectorAll('.card.active').forEach(e => e.classList.remove('active'));
  if (!activeTrackId && tracks.length) activeTrackId = tracks[0].id;
  const t = getActive();
  if (t && t.el) t.el.classList.add('active');
}

export function updateLaneHighlights(): void {
  for (const t of tracks) {
    if (!t.laneLabel) continue;
    const sel = t.id === activeTrackId;
    t.laneLabel.classList.toggle('selected', sel);
    const badge = t.laneLabel.querySelector('.diff-lane-playing');
    if (badge) badge.textContent = sel ? 'ACTIVE' : '';
  }
}

export function updatePlayheads(): void {
  for (const t of tracks) {
    if (!t.canvas || !t.ph || !t.loaded) continue;
    const pos = getPos(t);
    const span = t.viewEnd - t.viewStart;
    if (pos < t.viewStart || pos > t.viewEnd) {
      t.ph.style.display = 'none';
      if (t.waveformPh) t.waveformPh.style.display = 'none';
    } else {
      t.ph.style.display = '';
      const frac = (pos - t.viewStart) / span;
      const px = frac * t.wrapper!.clientWidth;
      t.ph.style.transform = 'translateX(' + px + 'px)';
      if (t.waveformPh) {
        t.waveformPh.style.display = '';
        const wfPx = t.waveformWrapper ? frac * (t.waveformWrapper as HTMLElement).clientWidth : px;
        t.waveformPh.style.transform = 'translateX(' + wfPx + 'px)';
      }
    }
  }
}

export function updateTimeDisplay(): void {
  const t = getActive();
  timeDisp.textContent = t ? fmt(getPos(t)) + ' / ' + fmt(t.duration) : '0:00.000 / 0:00.000';
}

export function updatePlayBtn(p: boolean): void {
  playIcon.innerHTML = p ? '&#10074;&#10074;' : '&#9654;';
  playLabel.textContent = p ? 'Pause' : 'Play';
}

export function stopAllSources(): void {
  tracks.forEach(stopSource);
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  updatePlayBtn(false);
}

export function stopAll(): void {
  stopAllSources();
  tracks.forEach(t => { t.offset = 0; });
  updatePlayheads();
  updateTimeDisplay();
  updatePlayBtn(false);
}

export function pauseAll(): void {
  for (const t of tracks) {
    if (t.playing) stopSource(t);
  }
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  updatePlayBtn(false);
  updatePlayheads();
  updateTimeDisplay();
}

export async function playActive(): Promise<void> {
  const t = getActive();
  if (!t) return;
  if (!t.buffer) {
    await loadTrack(t);
    if (!t.buffer) return;
    updateCardInfo(t);
    refreshUI();
  }
  resumeAudio();
  stopAllSources();
  if (t.offset >= t.duration - 0.01) t.offset = 0;
  playSource(t, t.offset);
  startAnim();
}

export function togglePlay(): void {
  if (!tracks.length) return;
  const t = getActive();
  if (!t) return;
  if (t.playing) {
    stopSource(t);
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    updatePlayBtn(false);
    updatePlayheads();
    updateTimeDisplay();
  } else {
    playActive();
  }
}

export async function switchLane(): Promise<void> {
  const t = getActive();
  if (!t || t.groupId == null) return;
  const g = groups.find(g => g.id === t.groupId);
  if (!g || g.trackIds.length < 2) return;

  const idx = g.trackIds.indexOf(t.id);
  const nextIdx = (idx + 1) % g.trackIds.length;
  const nextTrack = tracks.find(tr => tr.id === g.trackIds[nextIdx]);
  if (!nextTrack) return;

  // Auto-load lazy track before switching
  if (!nextTrack.buffer) {
    await loadTrack(nextTrack);
    if (!nextTrack.buffer) return;
    updateCardInfo(nextTrack);
  }

  const pos = getPos(t);
  if (t.playing) stopSource(t);

  const sibs = getSiblings(nextTrack);
  for (const s of sibs) s.offset = Math.max(0, Math.min(pos, s.duration));

  setActive(nextTrack.id);
  resumeAudio();
  playSource(nextTrack, nextTrack.offset);
  startAnim();
}

export function seek(time: number): void {
  const t = getActive();
  if (!t) return;
  time = Math.max(0, Math.min(time, t.duration));
  const was = t.playing;
  const sibs = getSiblings(t);
  for (const s of sibs) {
    if (s.playing) stopSource(s);
    s.offset = Math.max(0, Math.min(time, s.duration));
  }
  if (was) { playSource(t, t.offset); startAnim(); }
  updatePlayheads();
  updateTimeDisplay();
}

function startAnim(): void {
  if (rafId) cancelAnimationFrame(rafId);
  updatePlayBtn(true);
  (function tick() {
    updatePlayheads();
    updateTimeDisplay();
    if (tracks.some(t => t.playing)) {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = null;
      updatePlayBtn(false);
    }
  })();
}

// ========== TRACK MANAGEMENT ==========

function removeTrackQuietly(id: number): void {
  const i = tracks.findIndex(t => t.id === id);
  if (i < 0) return;
  const t = tracks[i];
  if (t.playing) stopSource(t);
  if (t.el) t.el.remove();
  tracks.splice(i, 1);
  if (activeTrackId === id) activeTrackId = null;
}

function removeDiffGroupQuietly(gid: number): void {
  const gi = groups.findIndex(g => g.id === gid);
  if (gi < 0) return;
  const grp = groups[gi];
  for (const tid of grp.trackIds) {
    const ti = tracks.findIndex(t => t.id === tid);
    if (ti >= 0) {
      if (tracks[ti].playing) stopSource(tracks[ti]);
      tracks.splice(ti, 1);
    }
  }
  grp.el.remove();
  groups.splice(gi, 1);
  if (activeTrackId && !tracks.find(t => t.id === activeTrackId)) activeTrackId = null;
}

function findExistingStandaloneByStem(stem: string): Track | null {
  const key = stem.toLowerCase();
  for (const t of tracks) {
    if (t.groupId != null) continue;
    const { stem: tStem } = extractTag(stripExt(t.name));
    if (tStem.toLowerCase() === key) return t;
  }
  return null;
}

function findExistingGroupByStem(stem: string): Group | null {
  const key = stem.toLowerCase();
  for (const g of groups) {
    if (g.baseName.toLowerCase() === key) return g;
  }
  return null;
}

// ========== POSITION HELPERS ==========

/** Insert a placeholder div before an element to mark its position in tracksBox */
function insertPlaceholderBefore(el: HTMLElement | null): HTMLElement {
  const ph = document.createElement('div');
  if (el && el.parentNode === tracksBox) {
    tracksBox.insertBefore(ph, el);
  }
  return ph;
}

/** Move the last child of tracksBox (newly created card) to the placeholder position */
function placeCardAtPosition(placeholder: HTMLElement): void {
  const newCard = tracksBox.lastElementChild;
  if (newCard && newCard !== placeholder && placeholder.parentNode) {
    tracksBox.insertBefore(newCard, placeholder);
  }
  placeholder.remove();
}

function createStandalone(name: string, buffer: AudioBuffer | null, nativeSR: number, filePath?: string, lazyUri?: string): void {
  const t = mkTrack(name, buffer, nativeSR, filePath, lazyUri);
  const infoText = t.loaded && buffer
    ? (function(){ const ch = buffer.numberOfChannels === 1 ? 'Mono' : buffer.numberOfChannels === 2 ? 'Stereo' : buffer.numberOfChannels + 'ch'; return ch + ' ' + (t.sr / 1000).toFixed(1) + 'kHz | ' + fmt(t.duration); })()
    : '…';
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.trackId = String(t.id);
  const hdr = document.createElement('div');
  hdr.className = 'card-header';
  hdr.innerHTML =
    '<span class="card-title" title="' + esc(name) + '">' + esc(name) + '</span>' +
    '<button class="btn-analyze" title="Run audio classification"' + (t.loaded ? '' : ' disabled') + '>Analyze</button>' +
    '<span class="card-info">' + esc(infoText) + '</span>' +
    '<button class="card-remove" title="Remove">&times;</button>';
  hdr.addEventListener('click', () => setActive(t.id));
  hdr.querySelector('.card-remove')!.addEventListener('click', e => { e.stopPropagation(); removeTrack(t.id); });
  hdr.querySelector('.btn-analyze')!.addEventListener('click', e => { e.stopPropagation(); runAnalysis(t); });
  t.analyzeBtn = hdr.querySelector('.btn-analyze');
  card.appendChild(hdr);
  card.appendChild(buildSpecBody(t, SPEC_H));
  card.appendChild(buildRuler(t));
  tracksBox.appendChild(card);
  t.el = card;
  tracks.push(t);
  if (!activeTrackId) activeTrackId = t.id;

  if (t.loaded) {
    requestAnimationFrame(() => { if (t._pendingRender) { t._pendingRender(); t._pendingRender = null; } });
  } else {
    lazyObserver.observe(card);
  }
}

function createDiffGroup(baseName: string, items: DecodedItem[]): void {
  const gid = nextGrpId++;
  const grpTracks: Track[] = [];
  const anyLoaded = items.some(i => !!i.buffer);
  const maxDur = anyLoaded ? Math.max(...items.filter(i => i.buffer).map(i => i.buffer!.duration)) : 0;
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.groupId = String(gid);

  const hdr = document.createElement('div');
  hdr.className = 'card-header';
  const display = baseName || items[0].name;
  hdr.innerHTML =
    '<span class="card-title" title="' + esc(display) + '">' + esc(display) + '</span>' +
    '<span class="diff-badge">DIFF ' + items.length + '</span>' +
    '<button class="btn-analyze-group" title="Analyze all tracks in this group">Analyze Group</button>' +
    '<span class="card-info">' + (anyLoaded ? fmt(maxDur) : '…') + '</span>' +
    '<button class="card-remove" title="Remove group">&times;</button>';
  hdr.addEventListener('click', () => { if (grpTracks.length) setActive(grpTracks[0].id); });
  hdr.querySelector('.card-remove')!.addEventListener('click', e => { e.stopPropagation(); removeDiffGroup(gid); });
  hdr.querySelector('.btn-analyze-group')!.addEventListener('click', e => { e.stopPropagation(); runAnalysisGroup(tracks, gid); });
  card.appendChild(hdr);

  const cols = document.createElement('div');
  cols.className = 'diff-columns';

  items.forEach((item, idx) => {
    const t = mkTrack(item.name, item.buffer, item.nativeSR, item.filePath, item.lazyUri);
    t.groupId = gid;
    const lane = document.createElement('div');
    lane.className = 'diff-lane';

    const lbl = document.createElement('div');
    lbl.className = 'diff-lane-label';
    const tagText = item.suffix ? item.suffix : ('Track ' + (idx + 1));
    const tagCls = TAG_CSS[idx % TAG_CSS.length];
    const srText = t.loaded ? (t.sr / 1000).toFixed(1) + 'kHz' : '…';
    lbl.innerHTML =
      '<span class="diff-lane-tag ' + tagCls + '">' + esc(tagText) + '</span>' +
      '<span class="diff-lane-name">' + esc(item.name) + '</span>' +
      '<button class="btn-analyze" title="Run audio classification"' + (t.loaded ? '' : ' disabled') + '>Analyze</button>' +
      '<span class="card-info">' + esc(srText) + '</span>' +
      '<span class="diff-lane-playing"></span>' +
      '<button class="lane-remove" title="Remove this track">&times;</button>';
    lbl.addEventListener('click', () => { setActive(t.id); updateLaneHighlights(); });
    lbl.querySelector('.btn-analyze')!.addEventListener('click', e => { e.stopPropagation(); runAnalysis(t); });
    lbl.querySelector('.lane-remove')!.addEventListener('click', e => { e.stopPropagation(); deleteTrackFromGroup(t.id); });
    t.analyzeBtn = lbl.querySelector('.btn-analyze');
    lane.appendChild(lbl);
    t.laneLabel = lbl;

    lane.appendChild(buildSpecBody(t, SPEC_H_DIFF));
    lane.appendChild(buildRuler(t));
    cols.appendChild(lane);

    t.el = card;
    tracks.push(t);
    grpTracks.push(t);
    if (!activeTrackId) activeTrackId = t.id;
  });

  card.appendChild(cols);

  tracksBox.appendChild(card);
  groups.push({ id: gid, baseName, trackIds: grpTracks.map(t => t.id), el: card });
  updateLaneHighlights();

  if (grpTracks.some(t => t.loaded)) {
    requestAnimationFrame(() => {
      for (const t of grpTracks) {
        if (t._pendingRender) { t._pendingRender(); t._pendingRender = null; }
      }
    });
  }
  if (grpTracks.some(t => !t.loaded)) {
    lazyObserver.observe(card);
  }
}

function addToDiffGroup(grp: Group, newItem: DecodedItem): void {
  const existingItems = grp.trackIds.map(id => {
    const t = tracks.find(tr => tr.id === id);
    if (!t) return null;
    const tag = extractTag(stripExt(t.name)).tag;
    const suffix = tag || (t.filePath ? getParentFolderName(t.filePath) : t.name);
    return { name: t.name, buffer: t.buffer, suffix, nativeSR: t.nativeSR, filePath: t.filePath, lazyUri: t.lazyUri } as DecodedItem;
  }).filter(Boolean) as DecodedItem[];

  const ph = insertPlaceholderBefore(grp.el);
  removeDiffGroupQuietly(grp.id);
  existingItems.push(newItem);
  createDiffGroup(grp.baseName, existingItems);
  placeCardAtPosition(ph);
}

function notifyRemoveFromLoaded(t: Track): void {
  if (t.filePath) {
    (window as any).__vscodePostMessage({ type: 'removeFromLoaded', filePath: t.filePath });
  } else if (t.lazyUri && !t.lazyUri.startsWith('tar:')) {
    (window as any).__vscodePostMessage({ type: 'removeFromLoaded', uri: t.lazyUri });
  }
}

function removeTrack(id: number): void {
  const i = tracks.findIndex(t => t.id === id);
  if (i < 0) return;
  const t = tracks[i];
  if (t.playing) stopSource(t);
  if (t.groupId != null) { removeDiffGroup(t.groupId); return; }
  notifyRemoveFromLoaded(t);
  if (t.el) t.el.remove();
  tracks.splice(i, 1);
  if (activeTrackId === id) activeTrackId = tracks.length ? tracks[0].id : null;
  refreshUI();
}

function removeDiffGroup(gid: number): void {
  const gi = groups.findIndex(g => g.id === gid);
  if (gi < 0) return;
  const grp = groups[gi];
  for (const tid of grp.trackIds) {
    const ti = tracks.findIndex(t => t.id === tid);
    if (ti >= 0) {
      notifyRemoveFromLoaded(tracks[ti]);
      if (tracks[ti].playing) stopSource(tracks[ti]);
      tracks.splice(ti, 1);
    }
  }
  grp.el.remove();
  groups.splice(gi, 1);
  if (activeTrackId && !tracks.find(t => t.id === activeTrackId))
    activeTrackId = tracks.length ? tracks[0].id : null;
  refreshUI();
}

function deleteTrackFromGroup(trackId: number): void {
  const t = tracks.find(tr => tr.id === trackId);
  if (!t) return;
  if (t.playing) stopSource(t);

  notifyRemoveFromLoaded(t);

  if (t.groupId == null) {
    // Standalone track — just remove it
    removeTrack(t.id);
    return;
  }

  const g = groups.find(gr => gr.id === t.groupId);
  if (!g) { removeTrack(t.id); return; }

  // Use placeholder to preserve card position in DOM
  const placeholder = document.createElement('div');
  tracksBox.insertBefore(placeholder, g.el);

  if (g.trackIds.length <= 2) {
    // Group has 2 lanes — remove current, convert remaining to standalone
    const remainingId = g.trackIds.find(id => id !== t.id);
    const remaining = tracks.find(tr => tr.id === remainingId);
    if (remaining) {
      const { name, buffer, nativeSR, filePath, lazyUri } = remaining;
      if (remaining.playing) stopSource(remaining);
      removeDiffGroupQuietly(g.id);
      createStandalone(name, buffer, nativeSR, filePath, lazyUri);
    } else {
      removeDiffGroupQuietly(g.id);
    }
  } else {
    // Group has 3+ lanes — remove current lane, rebuild group with remaining
    const baseName = g.baseName;
    const remainingItems = g.trackIds
      .filter(id => id !== t.id)
      .map(id => {
        const tr = tracks.find(x => x.id === id);
        if (!tr) return null;
        const tag = extractTag(stripExt(tr.name)).tag;
        const suffix = tag || (tr.filePath ? getParentFolderName(tr.filePath) : tr.name);
        return { name: tr.name, buffer: tr.buffer, suffix, nativeSR: tr.nativeSR, filePath: tr.filePath, lazyUri: tr.lazyUri } as DecodedItem;
      })
      .filter(Boolean) as DecodedItem[];

    removeDiffGroupQuietly(g.id);
    if (remainingItems.length >= 2) {
      createDiffGroup(baseName, remainingItems);
    } else if (remainingItems.length === 1) {
      const it = remainingItems[0];
      createStandalone(it.name, it.buffer, it.nativeSR, it.filePath, it.lazyUri);
    }
  }

  // Move newly created card (at end of tracksBox) to placeholder position
  const newCard = tracksBox.lastElementChild;
  if (newCard && newCard !== placeholder && placeholder.parentNode) {
    tracksBox.insertBefore(newCard, placeholder);
  }
  placeholder.remove();

  refreshUI();
}

export function deleteActiveTrack(): void {
  const t = getActive();
  if (!t) return;
  deleteTrackFromGroup(t.id);
}

export function refreshUI(): void {
  const has = tracks.length > 0;
  dropZone.className = has ? 'compact' : 'empty';
  dropZone.querySelector('.dz-text')!.textContent =
    has ? '+ Click to add more audio files or archives' : 'Click to add audio files or archives';
  btnPlay.disabled = !has;
  btnStop.disabled = !has;
  btnZoomIn.disabled = !has;
  btnZoomOut.disabled = !has;
  btnZoomFit.disabled = !has;
  btnAnalyzeAll.disabled = !has;
  highlightActive();
  updateLaneHighlights();
  updateTimeDisplay();
}

function computeDisplayNames(items: DecodedItem[]): void {
  const paths = items.map(i => i.filePath).filter(Boolean) as string[];
  if (paths.length < 2) return;
  const normalized = paths.map(p => p.replace(/\\/g, '/'));
  const dirs = normalized.map(p => p.substring(0, p.lastIndexOf('/') + 1));
  if (dirs.every(d => d === dirs[0])) return;
  let common = dirs[0];
  for (let i = 1; i < dirs.length; i++) {
    while (common && !dirs[i].startsWith(common)) {
      const idx = common.lastIndexOf('/', common.length - 2);
      common = idx >= 0 ? common.substring(0, idx + 1) : '';
    }
  }
  for (const item of items) {
    if (item.filePath) {
      const rel = item.filePath.replace(/\\/g, '/').substring(common.length);
      item.name = rel;
    }
  }
}

export function handleFiles(items: DecodedItem[]): void {
  const grouped = groupByBaseName(items);

  for (const grp of grouped) {
    if (grp.items.length >= 2) {
      const existingMatch = findExistingStandaloneByStem(grp.baseName);
      let ph: HTMLElement | null = null;
      if (existingMatch) {
        const oldTrack = existingMatch;
        const oldTag = extractTag(stripExt(oldTrack.name)).tag || oldTrack.name;
        ph = insertPlaceholderBefore(oldTrack.el);
        removeTrackQuietly(oldTrack.id);
        grp.items.push({ name: oldTrack.name, buffer: oldTrack.buffer, suffix: oldTag, nativeSR: oldTrack.nativeSR, filePath: oldTrack.filePath, lazyUri: oldTrack.lazyUri });
      }
      // For same-name same-tag files from different directories, set suffix to parent folder
      const hasFilePath = grp.items.some(i => i.filePath);
      if (hasFilePath) {
        const nameCounts = new Map<string, number>();
        for (const item of grp.items) {
          const n = item.name.toLowerCase();
          nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
        }
        const hasDupes = Array.from(nameCounts.values()).some(v => v > 1);
        if (hasDupes) {
          for (const item of grp.items) {
            if (!item.suffix && item.filePath) {
              item.suffix = getParentFolderName(item.filePath);
            }
          }
        }
      }
      computeDisplayNames(grp.items);
      createDiffGroup(grp.baseName, grp.items);
      if (ph) placeCardAtPosition(ph);
    } else {
      const newItem = grp.items[0];
      const { stem, tag } = extractTag(stripExt(newItem.name));
      const existingMatch = findExistingStandaloneByStem(stem);

      if (existingMatch && tag) {
        // Known tag: merge with existing standalone
        const oldTrack = existingMatch;
        const oldTag = extractTag(stripExt(oldTrack.name)).tag || oldTrack.name;
        const ph = insertPlaceholderBefore(oldTrack.el);
        removeTrackQuietly(oldTrack.id);
        const mergeItems: DecodedItem[] = [
          { name: oldTrack.name, buffer: oldTrack.buffer, suffix: oldTag, nativeSR: oldTrack.nativeSR, filePath: oldTrack.filePath, lazyUri: oldTrack.lazyUri },
          { ...newItem, suffix: tag },
        ];
        computeDisplayNames(mergeItems);
        createDiffGroup(stem, mergeItems);
        placeCardAtPosition(ph);
      } else if (existingMatch && newItem.filePath && existingMatch.filePath !== newItem.filePath) {
        // No known tag, but same stem and different directories — same-name different-dir merge
        const oldTrack = existingMatch;
        const ph = insertPlaceholderBefore(oldTrack.el);
        removeTrackQuietly(oldTrack.id);
        const mergeItems: DecodedItem[] = [
          { name: oldTrack.name, buffer: oldTrack.buffer, suffix: getParentFolderName(oldTrack.filePath || ''), nativeSR: oldTrack.nativeSR, filePath: oldTrack.filePath, lazyUri: oldTrack.lazyUri },
          { ...newItem, suffix: getParentFolderName(newItem.filePath) },
        ];
        computeDisplayNames(mergeItems);
        createDiffGroup(stem, mergeItems);
        placeCardAtPosition(ph);
      } else {
        const existingGroup = findExistingGroupByStem(stem);
        if (existingGroup && tag) {
          // Known tag — add to existing group
          addToDiffGroup(existingGroup, { ...newItem, suffix: tag });
        } else if (existingGroup) {
          // No known tag — add with parent folder name as suffix
          addToDiffGroup(existingGroup, { ...newItem, suffix: newItem.filePath ? getParentFolderName(newItem.filePath) : undefined });
        } else {
          createStandalone(newItem.name, newItem.buffer, newItem.nativeSR, newItem.filePath, newItem.lazyUri);
        }
      }
    }
  }
  refreshUI();
}

/**
 * Create lazy placeholder tracks from file URIs (sent by extension host for on-demand loading).
 * Tracks are created in batches (100 at a time) with a "Load More" button.
 */
const LOAD_MORE_BATCH = 100;
let fileURIsQueue: { name: string; uri: string }[] = [];
let loadMoreBtn: HTMLElement | null = null;

export function handleFileURIs(files: { name: string; uri: string }[]): void {
  fileURIsQueue = fileURIsQueue.concat(files);
  loadMoreFileURIs();
}

export function loadMoreFileURIs(): void {
  const batch = fileURIsQueue.splice(0, LOAD_MORE_BATCH);
  // Convert lazy URIs to DecodedItems so handleFiles can do proper grouping
  // (same stem → diff group, same name different dir → diff group, etc.)
  const items: DecodedItem[] = batch.map(f => ({
    name: f.name,
    buffer: null,
    nativeSR: 0,
    filePath: f.uri,   // URI string used for directory-based grouping
    lazyUri: f.uri,
  }));
  if (items.length > 0) handleFiles(items);
  updateLoadMoreBtn();
  // refreshUI already called by handleFiles, but ensure btn state is up to date
}

function updateLoadMoreBtn(): void {
  if (loadMoreBtn) { loadMoreBtn.remove(); loadMoreBtn = null; }
  if (fileURIsQueue.length > 0) {
    loadMoreBtn = document.createElement('div');
    loadMoreBtn.className = 'load-more-bar';
    loadMoreBtn.innerHTML = '<button class="btn load-more-btn">Load more (' + fileURIsQueue.length + ' remaining)</button>';
    loadMoreBtn.querySelector('.load-more-btn')!.addEventListener('click', loadMoreFileURIs);
    tracksBox.appendChild(loadMoreBtn);
  }
}

export function clearAll(): void {
  stopAll();
  tracks.forEach(t => { if (t.el) t.el.remove(); });
  groups.forEach(g => { if (g.el) g.el.remove(); });
  tracks = [];
  groups = [];
  activeTrackId = null;
  fileURIsQueue = [];
  loadQueue.length = 0;
  activeLoads = 0;
  lazyObserver.disconnect();
  if (loadMoreBtn) { loadMoreBtn.remove(); loadMoreBtn = null; }
  tracksBox.innerHTML = '';
  refreshUI();
}

export function initUI(): void {
  dropZone = document.getElementById('drop-zone')!;
  tracksBox = document.getElementById('tracks-container')!;
  btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
  btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
  btnAnalyzeAll = document.getElementById('btn-analyze-all') as HTMLButtonElement;
  btnZoomIn = document.getElementById('btn-zoom-in') as HTMLButtonElement;
  btnZoomOut = document.getElementById('btn-zoom-out') as HTMLButtonElement;
  btnZoomFit = document.getElementById('btn-zoom-fit') as HTMLButtonElement;
  timeDisp = document.getElementById('time-display')!;
  playIcon = document.getElementById('play-icon')!;
  playLabel = document.getElementById('play-label')!;

  refreshUI();
}