import type { Track, Group, DecodedItem } from './types';
import { SPEC_H, SPEC_H_DIFF, renderSpec } from './spectrogram';
import { TAG_CSS, stripExt, extractTag, groupByBaseName } from './grouping';
import { playSource, stopSource, getPos, resumeAudio } from './audio';
import { runAnalysis, runAnalysisGroup } from './analysis';
import { fmt, fmtShort, esc } from './util';

let tracks: Track[] = [];
let groups: Group[] = [];
let nextId = 1;
let nextGrpId = 1;
let activeTrackId: number | null = null;
let rafId: number | null = null;

let tracksBox: HTMLElement;
let dropZone: HTMLElement;
let btnPlay: HTMLButtonElement;
let btnStop: HTMLButtonElement;
let btnAnalyzeAll: HTMLButtonElement;
let timeDisp: HTMLElement;
let playIcon: HTMLElement;
let playLabel: HTMLElement;

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

function mkTrack(name: string, buffer: AudioBuffer, nativeSR: number): Track {
  const id = nextId++;
  const dur = buffer.duration;
  const displaySR = nativeSR || buffer.sampleRate;
  const ny = displaySR / 2;
  return {
    id, name, buffer, duration: dur, nyquist: ny, sr: displaySR, nativeSR: displaySR, renderSR: buffer.sampleRate,
    canvas: null, wrapper: null, ph: null, laneLabel: null, analysisStrip: null, analyzeBtn: null,
    playing: false, startTime: 0, offset: 0, source: null,
    groupId: null, el: null, analysisResults: null,
  };
}

function addFreqLabels(el: HTMLElement, ny: number): void {
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

function buildSpecBody(track: Track, h: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'track-body';
  el.style.flexDirection = 'column';
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

  track.wrapper!.addEventListener('click', e => {
    const rect = track.canvas!.getBoundingClientRect();
    const cx = (e as MouseEvent).clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, cx / rect.width));
    selectAndSeek(track, ratio * track.duration);
  });

  track._pendingRender = () => {
    const w = track.wrapper!.clientWidth;
    if (w > 0) {
      track.canvas!.width = w;
      setTimeout(() => {
        renderSpec(track);
        if (loading.parentNode) loading.remove();
      }, 0);
    } else {
      if (loading.parentNode) loading.remove();
    }
  };
  return el;
}

function niceStep(rawStep: number): number {
  const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const n of nice) {
    if (n >= rawStep * 0.8) return n;
  }
  return rawStep;
}

function buildRuler(dur: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'time-ruler';
  const step = niceStep(dur / 10);
  const n = Math.min(Math.ceil(dur / step), 20);
  for (let i = 0; i <= n; i++) {
    const t = i * step;
    if (t > dur + 0.01) break;
    const m = document.createElement('span');
    m.className = 'time-mark';
    m.textContent = fmtShort(t);
    m.style.width = (step / dur * 100) + '%';
    el.appendChild(m);
  }
  return el;
}

function selectAndSeek(track: Track, time: number): void {
  stopAllSources();
  setActive(track.id);
  time = Math.max(0, Math.min(time, track.duration));
  const sibs = getSiblings(track);
  for (const s of sibs) s.offset = Math.max(0, Math.min(time, s.duration));
  updatePlayheads();
  updateTimeDisplay();
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
    if (!t.canvas || !t.ph) continue;
    const pos = getPos(t);
    const pct = (pos / t.duration) * 100;
    t.ph.style.left = pct + '%';
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
}

export function stopAll(): void {
  stopAllSources();
  tracks.forEach(t => { t.offset = 0; });
  updatePlayheads();
  updateTimeDisplay();
  updatePlayBtn(false);
}

export function playActive(): void {
  const t = getActive();
  if (!t) return;
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

export function switchLane(): void {
  const t = getActive();
  if (!t || t.groupId == null) return;
  const g = groups.find(g => g.id === t.groupId);
  if (!g || g.trackIds.length < 2) return;

  const idx = g.trackIds.indexOf(t.id);
  const nextIdx = (idx + 1) % g.trackIds.length;
  const nextTrack = tracks.find(tr => tr.id === g.trackIds[nextIdx]);
  if (!nextTrack) return;

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

function createStandalone(name: string, buffer: AudioBuffer, nativeSR: number): void {
  const t = mkTrack(name, buffer, nativeSR);
  const chL = buffer.numberOfChannels === 1 ? 'Mono' : buffer.numberOfChannels === 2 ? 'Stereo' : buffer.numberOfChannels + 'ch';
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.trackId = String(t.id);
  const hdr = document.createElement('div');
  hdr.className = 'card-header';
  hdr.innerHTML =
    '<span class="card-title" title="' + esc(name) + '">' + esc(name) + '</span>' +
    '<button class="btn-analyze" title="Run audio classification">Analyze</button>' +
    '<span class="card-info">' + chL + ' ' + (t.sr / 1000).toFixed(1) + 'kHz | ' + fmt(t.duration) + '</span>' +
    '<button class="card-remove" title="Remove">&times;</button>';
  hdr.addEventListener('click', () => setActive(t.id));
  hdr.querySelector('.card-remove')!.addEventListener('click', e => { e.stopPropagation(); removeTrack(t.id); });
  hdr.querySelector('.btn-analyze')!.addEventListener('click', e => { e.stopPropagation(); runAnalysis(t); });
  t.analyzeBtn = hdr.querySelector('.btn-analyze');
  card.appendChild(hdr);
  card.appendChild(buildSpecBody(t, SPEC_H));
  card.appendChild(buildRuler(t.duration));
  tracksBox.appendChild(card);
  t.el = card;
  tracks.push(t);
  if (!activeTrackId) activeTrackId = t.id;
  requestAnimationFrame(() => { if (t._pendingRender) { t._pendingRender(); t._pendingRender = null; } });
}

function createDiffGroup(baseName: string, items: DecodedItem[]): void {
  const gid = nextGrpId++;
  const grpTracks: Track[] = [];
  const maxDur = Math.max(...items.map(i => i.buffer.duration));
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
    '<span class="card-info">' + fmt(maxDur) + '</span>' +
    '<button class="card-remove" title="Remove group">&times;</button>';
  hdr.addEventListener('click', () => { if (grpTracks.length) setActive(grpTracks[0].id); });
  hdr.querySelector('.card-remove')!.addEventListener('click', e => { e.stopPropagation(); removeDiffGroup(gid); });
  hdr.querySelector('.btn-analyze-group')!.addEventListener('click', e => { e.stopPropagation(); runAnalysisGroup(tracks, gid); });
  card.appendChild(hdr);

  const cols = document.createElement('div');
  cols.className = 'diff-columns';

  items.forEach((item, idx) => {
    const t = mkTrack(item.name, item.buffer, item.nativeSR);
    t.groupId = gid;
    const lane = document.createElement('div');
    lane.className = 'diff-lane';

    const lbl = document.createElement('div');
    lbl.className = 'diff-lane-label';
    const tagText = item.suffix ? item.suffix : ('Track ' + (idx + 1));
    const tagCls = TAG_CSS[idx % TAG_CSS.length];
    lbl.innerHTML =
      '<span class="diff-lane-tag ' + tagCls + '">' + esc(tagText) + '</span>' +
      '<span class="diff-lane-name">' + esc(item.name) + '</span>' +
      '<button class="btn-analyze" title="Run audio classification">Analyze</button>' +
      '<span class="card-info">' + (t.sr / 1000).toFixed(1) + 'kHz</span>' +
      '<span class="diff-lane-playing"></span>';
    lbl.addEventListener('click', () => { setActive(t.id); updateLaneHighlights(); });
    lbl.querySelector('.btn-analyze')!.addEventListener('click', e => { e.stopPropagation(); runAnalysis(t); });
    t.analyzeBtn = lbl.querySelector('.btn-analyze');
    lane.appendChild(lbl);
    t.laneLabel = lbl;

    lane.appendChild(buildSpecBody(t, SPEC_H_DIFF));
    cols.appendChild(lane);

    t.el = card;
    tracks.push(t);
    grpTracks.push(t);
    if (!activeTrackId) activeTrackId = t.id;
  });

  card.appendChild(cols);
  card.appendChild(buildRuler(maxDur));
  tracksBox.appendChild(card);
  groups.push({ id: gid, baseName, trackIds: grpTracks.map(t => t.id), el: card });
  updateLaneHighlights();
  requestAnimationFrame(() => {
    for (const t of grpTracks) {
      if (t._pendingRender) { t._pendingRender(); t._pendingRender = null; }
    }
  });
}

function addToDiffGroup(grp: Group, newItem: DecodedItem): void {
  const existingItems = grp.trackIds.map(id => {
    const t = tracks.find(tr => tr.id === id);
    if (!t) return null;
    const tag = extractTag(stripExt(t.name)).tag || t.name;
    return { name: t.name, buffer: t.buffer, suffix: tag, nativeSR: t.nativeSR } as DecodedItem;
  }).filter(Boolean) as DecodedItem[];

  removeDiffGroupQuietly(grp.id);
  existingItems.push(newItem);
  createDiffGroup(grp.baseName, existingItems);
}

function removeTrack(id: number): void {
  const i = tracks.findIndex(t => t.id === id);
  if (i < 0) return;
  const t = tracks[i];
  if (t.playing) stopSource(t);
  if (t.groupId != null) { removeDiffGroup(t.groupId); return; }
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

export function clearAll(): void {
  stopAll();
  tracks.forEach(t => { if (t.el) t.el.remove(); });
  groups.forEach(g => { if (g.el) g.el.remove(); });
  tracks = [];
  groups = [];
  activeTrackId = null;
  tracksBox.innerHTML = '';
  refreshUI();
}

export function refreshUI(): void {
  const has = tracks.length > 0;
  dropZone.className = has ? 'compact' : 'empty';
  dropZone.querySelector('.dz-text')!.textContent =
    has ? '+ Click to add more audio files' : 'Click to add audio files';
  btnPlay.disabled = !has;
  btnStop.disabled = !has;
  btnAnalyzeAll.disabled = !has;
  highlightActive();
  updateLaneHighlights();
  updateTimeDisplay();
}

/**
 * Compute display names for a group of items from different directories.
 * If all files are in the same directory, names stay as basenames.
 * If files are in different directories, names become relative paths
 * from their common parent directory.
 */
function computeDisplayNames(items: DecodedItem[]): void {
  const paths = items.map(i => i.filePath).filter(Boolean) as string[];
  if (paths.length < 2) return;

  // Normalize separators to /
  const normalized = paths.map(p => p.replace(/\\/g, '/'));
  const dirs = normalized.map(p => p.substring(0, p.lastIndexOf('/') + 1));

  // All files in same directory → keep basenames
  if (dirs.every(d => d === dirs[0])) return;

  // Compute common directory prefix
  let common = dirs[0];
  for (let i = 1; i < dirs.length; i++) {
    while (common && !dirs[i].startsWith(common)) {
      const idx = common.lastIndexOf('/', common.length - 2);
      common = idx >= 0 ? common.substring(0, idx + 1) : '';
    }
  }

  // Replace name with relative path from common prefix
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
      if (existingMatch) {
        const oldTrack = existingMatch;
        const oldTag = extractTag(stripExt(oldTrack.name)).tag || oldTrack.name;
        removeTrackQuietly(oldTrack.id);
        grp.items.push({ name: oldTrack.name, buffer: oldTrack.buffer, suffix: oldTag, nativeSR: oldTrack.nativeSR });
      }
      computeDisplayNames(grp.items);
      createDiffGroup(grp.baseName, grp.items);
    } else {
      const newItem = grp.items[0];
      const { stem, tag } = extractTag(stripExt(newItem.name));
      const existingMatch = findExistingStandaloneByStem(stem);

      if (existingMatch && tag) {
        const oldTrack = existingMatch;
        const oldTag = extractTag(stripExt(oldTrack.name)).tag || oldTrack.name;
        removeTrackQuietly(oldTrack.id);
        const mergeItems: DecodedItem[] = [
          { name: oldTrack.name, buffer: oldTrack.buffer, suffix: oldTag, nativeSR: oldTrack.nativeSR },
          { ...newItem, suffix: tag },
        ];
        computeDisplayNames(mergeItems);
        createDiffGroup(stem, mergeItems);
      } else {
        const existingGroup = findExistingGroupByStem(stem);
        if (existingGroup && tag) {
          addToDiffGroup(existingGroup, { ...newItem, suffix: tag });
        } else {
          createStandalone(newItem.name, newItem.buffer, newItem.nativeSR);
        }
      }
    }
  }
  refreshUI();
}

export function initUI(): void {
  dropZone = document.getElementById('drop-zone')!;
  tracksBox = document.getElementById('tracks-container')!;
  btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
  btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
  btnAnalyzeAll = document.getElementById('btn-analyze-all') as HTMLButtonElement;
  timeDisp = document.getElementById('time-display')!;
  playIcon = document.getElementById('play-icon')!;
  playLabel = document.getElementById('play-label')!;

  refreshUI();
}
