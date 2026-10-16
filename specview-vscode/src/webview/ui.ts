import type { Track, Group, DecodedItem, GroupResult, AnalysisSpan } from './types';
import { SPEC_H, SPEC_H_DIFF, renderSpec, drawSpec, drawWaveform, getWaveformHeight, channelSpecHeight } from './spectrogram';
import { TAG_CSS, stripExt, extractTag, groupByBaseName, getParentFolderName, parseNativeSampleRate } from './grouping';
import { decodeMetaPathSegment, displayMetaPath, joinMetaPath, metaPathSegments } from './metaPath';
import { playSource, stopSource, getPos, resumeAudio, decodeToAudioBuffer, applyChannelListen } from './audio';
import { runAnalysis, runAnalysisGroup, renderAnalysisStrip } from './analysis';
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
let autoGroup = true;
let groupingBusy = false;   // guards the async regroup/split chunk loop

let tracksBox: HTMLElement;
let dropZone: HTMLElement;
let btnPlay: HTMLButtonElement;
let btnStop: HTMLButtonElement;
let btnAnalyzeAll: HTMLButtonElement;
let btnGrouping: HTMLButtonElement;
let btnZoomIn: HTMLButtonElement;
let btnZoomOut: HTMLButtonElement;
let btnZoomFit: HTMLButtonElement;
let timeDisp: HTMLElement;
let playIcon: HTMLElement;
let playLabel: HTMLElement;

// ========== PAIRED JSON METADATA ==========
let metaVisible = false;
const META_SHOW_MAX = 120000;   // cap displayed JSON length (chars)
// Cap tree-rendered DOM lines per metadata panel (large arrays would create
// 100k+ nodes and freeze the panel render).
const META_TREE_MAX_LINES = 4000;
const META_WIDTH_DEFAULT = 300;
const META_WIDTH_MIN = 180;
let metaSelPaths = new Set<string>();
const metaMap = new Map<string, string>();  // metaKeyOf(name, filePath) -> raw text
const metaSource = new Map<string, string>(); // metaKey -> source filePath (for cleanup)
const metaTreeCache = new Map<string, string>();
const metaLeafCache = new Map<string, Map<string, boolean>>();
// Lazy JSON: descriptors received from the host, fetched only when needed.
interface PendingMeta { name: string; filePath?: string; sourceId: string }
const pendingMeta = new Map<string, PendingMeta>();
const metaLoading = new Set<string>();
// Keys of every known audio item (rendered, pending or recycled), so a JSON is
// only treated as "unpaired" when no audio with that stem exists at all.
const allAudioMetaKeys = new Set<string>();
// Keys of audio items that have actually been decoded (loaded), including ones
// that were later recycled. Used to pair a JSON once its audio has loaded.
const loadedAudioKeys = new Set<string>();
let metaUnpairedTimer: number | undefined;

/** Paired-JSON key, mirroring the web implementation. */
function metaKeyOf(name: string, filePath?: string): string {
  let dir = '';
  if (filePath) {
    const parts = String(filePath).replace(/\\/g, '/').split('/');
    parts.pop();
    dir = parts.join('/');
  }
  return (dir ? dir.toLowerCase() + '/' : '') + String(name).replace(/\.[^.]+$/, '').toLowerCase();
}

function metaKeyName(t: { name: string; filePath?: string }): string {
  return metaKeyOf(t.name, t.filePath);
}

/** Ingest meta items from the extension host: store by key, then attach to any
 *  loaded track / group lane with the same stem. Unpaired .json files (no audio
 *  with the same stem) become standalone JSON cards, visible while the JSON
 *  toggle is on. */
export function receiveMetaData(items: { name: string; filePath?: string; text: string }[]): void {
  let changed = false;
  const updates: { old: string | undefined; text: string }[] = [];
  for (const it of items) {
    const key = metaKeyOf(it.name, it.filePath);
    if (key && it.text !== undefined) {
      const old = metaMap.get(key);
      if (old !== it.text) { metaMap.set(key, it.text); updates.push({ old, text: it.text }); changed = true; }
      if (it.filePath) metaSource.set(key, it.filePath);
    }
  }
  if (!changed) return;
  metaTreeCache.clear();
  metaLeafCache.clear();
  updateFieldCounts(updates);
  for (const t of tracks) {
    const m = metaMap.get(metaKeyOf(t.name, t.filePath)) || metaMap.get(metaKeyOf(t.name)) || null;
    t.meta = m;
    if (t.metaPanel) setMetaBody(t.metaPanel.body, t.meta);
  }
  for (const g of groups) {
    const active = getActiveLaneOfGroup(g) || (g.trackIds.map(id => tracks.find(x => x.id === id)).find(Boolean));
    if (g.metaPanel) setMetaBody(g.metaPanel.body, active ? active.meta : null);
  }
  ensureStandaloneJsonCards();
  scheduleReflow();
}

export function setMetaVisible(v: boolean): void {
  metaVisible = v;
  for (const t of tracks) {
    if (t.metaPanel) t.metaPanel.aside.classList.toggle('show', v);
  }
  for (const g of groups) {
    if (g.metaPanel) g.metaPanel.aside.classList.toggle('show', v);
  }
  if (v) { ensureStandaloneJsonCards(); markUnpairedMeta(); }
  setStandaloneJsonCardVisibility(v);
  scheduleReflow();
}

/** List of standalone JSON cards (unpaired .json metadata). */
interface JsonCard { key: string; filePath?: string; name: string; card: HTMLElement; panel: { aside: HTMLElement; body: HTMLElement; head: HTMLElement }; }
const jsonCards: JsonCard[] = [];

/** A meta key that is already "paired" to a loaded audio track. */
function isMetaKeyPaired(key: string): boolean {
  if (allAudioMetaKeys.has(key)) return true;
  for (const t of tracks) {
    if (metaKeyOf(t.name, t.filePath) === key || metaKeyOf(t.name) === key) return true;
  }
  return false;
}

// Bound DOM growth for sessions containing many orphan .json files.
const JSON_CARD_CAP = 300;

/** Reconcile standalone JSON cards with the current tracks + metaMap: drop
 *  cards whose key now has matching audio (paired) or is gone from metaMap,
 *  then create cards for still-unpaired keys. Called after cards are created/
 *  removed and after metaData arrives, so a json that raced ahead of its audio
 *  does not linger as a duplicate once the audio track appears. */
function ensureStandaloneJsonCards(): void {
  for (let i = jsonCards.length - 1; i >= 0; i--) {
    const c = jsonCards[i];
    if (!metaMap.has(c.key) || isMetaKeyPaired(c.key)) {
      if (c.card) c.card.remove();
      jsonCards.splice(i, 1);
    }
  }
  const have = new Set(jsonCards.map(c => c.key));
  for (const [key, text] of metaMap) {
    if (have.has(key) || isMetaKeyPaired(key)) continue;
    if (jsonCards.length >= JSON_CARD_CAP) break;
    const filePath = metaSource.get(key) || undefined;
    const base = filePath ? filePath.replace(/\\/g, '/').split('/').pop() || key : key;
    const card = document.createElement('div');
    card.className = 'card json-card';
    const hdr = document.createElement('div');
    hdr.className = 'card-header';
    hdr.innerHTML =
      '<span class="card-title" title="' + esc(base) + '">' + esc(base) + '</span>' +
      '<button class="card-remove" title="Remove">&times;</button>';
    hdr.querySelector('.card-remove')!.addEventListener('click', e => { e.stopPropagation(); removeJsonCard(key); });
    card.appendChild(hdr);
    const panel = buildMetaPanel();
    panel.aside.classList.add('show');
    card.appendChild(panel.aside);
    setMetaBody(panel.body, text);
    tracksBox.appendChild(card);
    jsonCards.push({ key, filePath, name: base, card, panel });
  }
  setStandaloneJsonCardVisibility(metaVisible);
}

/** Register lazy JSON descriptors. Nothing is read until an audio track with
 *  the same stem finishes loading, or the unpaired pass runs. */
export function receiveMetaURIs(files: { name: string; filePath?: string; sourceId: string }[]): void {
  for (const file of files) {
    const key = metaKeyOf(file.name, file.filePath);
    if (!key || metaMap.has(key) || pendingMeta.has(key)) continue;
    pendingMeta.set(key, { name: file.name, filePath: file.filePath, sourceId: file.sourceId });
    // Already-decoded tracks never trigger loadTrack again — pair immediately.
    if (loadedAudioKeys.has(key) || tracks.some(t => t.loaded && metaKeyOf(t.name, t.filePath) === key)) {
      fetchPendingMeta(key);
    }
  }
  markUnpairedMeta();
}

function audioKeyOf(item: { name: string; filePath?: string }): string {
  return metaKeyOf(item.name, item.filePath);
}

/** Rebuild the sets of known / loaded audio keys from live + pending + recycled
 *  items. Called after audio is removed so its JSON can fall back to standalone. */
function refreshAudioMetaIndex(): void {
  allAudioMetaKeys.clear();
  loadedAudioKeys.clear();
  for (const item of collectAllItems()) {
    const key = audioKeyOf(item);
    allAudioMetaKeys.add(key);
    if (item.buffer) loadedAudioKeys.add(key);
  }
  ensureStandaloneJsonCards();
  markUnpairedMeta();
}

/** Fetch a pending JSON by key and fold its text into metaMap / the panels. */
function fetchPendingMeta(key: string): void {
  const file = pendingMeta.get(key);
  if (!file || metaLoading.has(key)) return;
  metaLoading.add(key);
  const requestFileData = (window as any).__requestFileData as ((sourceId: string) => Promise<ArrayBuffer>) | undefined;
  if (!requestFileData) { metaLoading.delete(key); return; }
  void requestFileData(file.sourceId).then(raw => {
    if (!pendingMeta.has(key)) return;
    pendingMeta.delete(key);
    const text = new TextDecoder('utf-8').decode(raw).replace(/\0+$/g, '');
    receiveMetaData([{ name: file.name, filePath: file.filePath, text }]);
  }).catch(error => {
    console.error('[SpecView] Failed to load JSON:', file.name, error);
  }).finally(() => {
    metaLoading.delete(key);
  });
}

/** Read the JSON paired with a just-loaded audio track. */
function requestMetaForTrack(t: Track): void {
  const key = metaKeyOf(t.name, t.filePath);
  if (key && pendingMeta.has(key)) fetchPendingMeta(key);
}

/** Record that a track's audio is decoded and pull its pending JSON. Safe to
 *  call repeatedly (e.g. on create and on recycle/restore). */
function markAudioLoaded(t: Track): void {
  const key = metaKeyOf(t.name, t.filePath);
  if (key) loadedAudioKeys.add(key);
  requestMetaForTrack(t);
}

/** Once audio loading settles, read JSON with no matching audio at all. */
function markUnpairedMeta(): void {
  if (metaUnpairedTimer !== undefined) clearTimeout(metaUnpairedTimer);
  metaUnpairedTimer = window.setTimeout(() => {
    metaUnpairedTimer = undefined;
    loadUnpairedMeta();
  }, 300);
}

function loadUnpairedMeta(): void {
  if (loadingInFlight()) { markUnpairedMeta(); return; }
  if (!metaVisible) return;
  let started = false;
  for (const key of pendingMeta.keys()) {
    if (allAudioMetaKeys.has(key) || metaLoading.has(key)) continue;
    fetchPendingMeta(key);
    started = true;
  }
  if (started) ensureStandaloneJsonCards();
}

/** True while any audio track is currently decoding/lazy-loading. */
function loadingInFlight(): boolean {
  return activeLoadTokens.size > 0 || loadQueue.length > 0 || tracks.some(t => t._loading);
}

/** Toggle standalone JSON card visibility (keep DOM, just hide like .meta-aside). */
function setStandaloneJsonCardVisibility(v: boolean): void {
  for (const jc of jsonCards) {
    jc.card.style.display = v ? '' : 'none';
  }
}

/** Remove a standalone JSON card (and its metaMap entry). */
function removeJsonCard(key: string): void {
  const i = jsonCards.findIndex(c => c.key === key);
  if (i < 0) return;
  const c = jsonCards[i];
  if (c.card) c.card.remove();
  jsonCards.splice(i, 1);
  const text = metaMap.get(key);
  metaMap.delete(key);
  if (text !== undefined && fieldCounts) {
    bumpFieldsOf(text, fieldCounts, -1);
    invalidateFieldContent();
  }
  const filePath = c.filePath;
  if (filePath) (window as any).__vscodePostMessage?.({ type: 'removeFromLoaded', filePath });
}

/** Track captured by a group card's active lane (for showing that lane's JSON). */
function getActiveLaneOfGroup(g: Group): Track | undefined {
  if (activeTrackId != null) {
    const t = tracks.find(x => x.id === activeTrackId && x.groupId === g.id);
    if (t) return t;
  }
  for (const id of g.trackIds) {
    const t = tracks.find(x => x.id === id);
    if (t) return t;
  }
  return undefined;
}

// ========== JSON METADATA RENDERING ==========

function escMetaText(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s: string): string { return escMetaText(s).replace(/"/g, '&quot;'); }

function highlightJson(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  const isNumChar = (c: string) => (c >= '0' && c <= '9') || c === '-' || c === '+' || c === '.' || c === 'e' || c === 'E';
  while (i < n) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { out.push(ch); i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '"') { j++; break; }
        j++;
      }
      const lit = text.slice(i, j);
      let k = j;
      while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
      const isKey = text[k] === ':';
      const cls = isKey ? 'jv-key' : 'jv-str';
      out.push('<span class="' + cls + '">' + escMetaText(lit) + '</span>');
      i = j;
      continue;
    }
    if (isNumChar(ch)) {
      let j = i;
      while (j < n && isNumChar(text[j])) j++;
      out.push('<span class="jv-num">' + escMetaText(text.slice(i, j)) + '</span>');
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z]/.test(text[j])) j++;
      const word = text.slice(i, j);
      const cls = word === 'true' || word === 'false' ? 'jv-bool' : (word === 'null' ? 'jv-null' : 'jv-punc');
      out.push('<span class="' + cls + '">' + word + '</span>');
      i = j;
      continue;
    }
    if ('{}[],:'.indexOf(ch) >= 0) { out.push('<span class="jv-punc">' + ch + '</span>'); i++; continue; }
    out.push(escMetaText(ch)); i++;
  }
  return out.join('');
}

function renderJsonMeta(raw: string): string {
  if (!raw) return '<span class="meta-empty">No JSON</span>';
  let text: string;
  try {
    const parsed = JSON.parse(raw);
    text = (parsed !== null && typeof parsed === 'object')
      ? JSON.stringify(parsed, null, 2)
      : String(raw);
  } catch (e) {
    const em = e instanceof Error ? e.message : String(e);
    return '<div class="meta-err">Invalid JSON — ' + escMetaText(em) + '</div>' +
           '<pre class="meta-raw">' + escMetaText(raw) + '</pre>';
  }
  const truncated = text.length > META_SHOW_MAX;
  let html = highlightJson(truncated ? text.slice(0, META_SHOW_MAX) : text);
  if (truncated) html += '<div class="meta-trunc">… truncated (' + text.length.toLocaleString() + ' chars) — metadata only</div>';
  return html;
}

function buildMetaPanel(): { aside: HTMLElement; body: HTMLElement; head: HTMLElement } {
  const aside = document.createElement('div');
  aside.className = 'meta-aside';
  const head = document.createElement('div');
  head.className = 'meta-head';
  head.innerHTML =
    '<button class="meta-pill" title="Browse all fields across loaded files">fields</button>' +
    '<span class="meta-head-lbl">JSON metadata</span>' +
    '<button class="meta-clear" title="Clear field selection (show full JSON)">&times;</button>';
  head.querySelector('.meta-clear')!.addEventListener('click', clearMetaSel);
  head.querySelector('.meta-pill')!.addEventListener('click', e => { e.stopPropagation(); toggleMetaPop(e.currentTarget as HTMLElement); });
  const body = document.createElement('div');
  body.className = 'meta-body';
  aside.appendChild(head);
  aside.appendChild(body);
  return { aside, body, head };
}

function makeMetaResizer(row: HTMLElement, after: () => void): HTMLElement {
  const rz = document.createElement('div');
  rz.className = 'meta-resizer';
  rz.title = 'Drag to resize the JSON panel · double-click to reset to default';
  rz.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    rz.classList.add('dragging');
    const onMove = (ev: PointerEvent) => {
      const rect = row.getBoundingClientRect();
      const maxW = Math.max(META_WIDTH_MIN, rect.width - 220);
      const w = Math.max(META_WIDTH_MIN, Math.min(ev.clientX < rect.right ? (rect.right - ev.clientX) : maxW, maxW));
      document.documentElement.style.setProperty('--meta-width', w + 'px');
    };
    const onUp = () => {
      rz.classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try { localStorage.setItem('specview-meta-width', metaWidthNow()); } catch { /* ignore */ }
      after();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  rz.addEventListener('dblclick', e => {
    e.stopPropagation();
    document.documentElement.style.setProperty('--meta-width', '');
    try { localStorage.removeItem('specview-meta-width'); } catch { /* ignore */ }
    after();
  });
  return rz;
}

function metaWidthNow(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--meta-width').trim();
  return v || (META_WIDTH_DEFAULT + 'px');
}

function setMetaBody(body: HTMLElement | null | undefined, meta: string | null | undefined): void {
  if (!body) return;
  const html = metaBodyHtml(meta || '');
  if (body._metaLast === html) return;
  body._metaLast = html;
  body.innerHTML = html;
  body.scrollTop = 0;
}

declare global { interface HTMLElement { _metaLast?: string; } }

// ---- field selection ----
function refreshMetaBodies(): void {
  for (const t of tracks) {
    if (t.metaPanel && t.metaPanel.body) setMetaBody(t.metaPanel.body, t.meta);
  }
  for (const g of groups) {
    const active = getActiveLaneOfGroup(g);
    if (g.metaPanel) setMetaBody(g.metaPanel.body, active ? active.meta : null);
  }
  for (const jc of jsonCards) {
    setMetaBody(jc.panel.body, metaMap.get(jc.key) ?? null);
  }
  updateMetaHeads();
}

function selectedValue(parsed: unknown, path: string): unknown {
  let cur: any = parsed;
  for (const part of metaPathSegments(path)) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) { const i = Number(part); if (!Number.isNaN(i)) cur = cur[i]; else return undefined; }
    else if (typeof cur === 'object') cur = cur[part];
    else return undefined;
  }
  return cur;
}

function metaValueHtml(parsed: unknown, path: string): string {
  const v = selectedValue(parsed, path);
  if (v === undefined) return '<span class="meta-sel-missing">not present in this file</span>';
  if (v !== null && typeof v === 'object') {
    try { return highlightJson(JSON.stringify(v, null, 2).slice(0, META_SHOW_MAX)); }
    catch { return escMetaText(String(v)); }
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if ((t[0] === '{' || t[0] === '[') && t.length < 200000) {
      try { return highlightJson(JSON.stringify(JSON.parse(t), null, 2).slice(0, META_SHOW_MAX)); }
      catch { /* fallthrough */ }
    }
    return escMetaText(v.slice(0, 220));
  }
  return escMetaText(String(v));
}

function toggleMetaKey(path: string): void { toggleMetaField(path); }
function removeMetaKey(path: string): void { metaSelPaths.delete(path); commitMetaSel(); }
function clearMetaSel(): void { metaSelPaths.clear(); commitMetaSel(); }

/** Apply a field-selection change across every panel (tracks, groups and
 *  standalone JSON cards) and refresh the fields popup if it is open. */
function commitMetaSel(): void {
  invalidateFieldState();
  refreshMetaBodies();
  if (metaPopEl && metaPopEl.classList.contains('open')) buildMetaPopList(metaPopEl, metaPopFilter);
}

function updateMetaHeads(): void {
  const n = metaSelPaths.size;
  for (const t of tracks) { if (t.metaPanel && t.metaPanel.head) updateHead(t.metaPanel.head, n); }
  for (const g of groups) { if (g.metaPanel && g.metaPanel.head) updateHead(g.metaPanel.head, n); }
  for (const jc of jsonCards) { updateHead(jc.panel.head, n); }
}
function updateHead(head: HTMLElement, n: number): void {
  const lbl = head.querySelector('.meta-head-lbl');
  if (lbl) lbl.textContent = n ? (n + ' field' + (n === 1 ? '' : 's')) : 'JSON metadata';
  document.body.classList.toggle('meta-sel', n > 0);
}

function treePushDeep(v: unknown, depth: number, out: string[]): void { renderTreeInto(v, depth, out, ''); }

function renderTreeInto(v: unknown, depth: number, out: string[], prefix: string): void {
  if (out.length >= META_TREE_MAX_LINES) return;
  if (v === null || typeof v !== 'object') {
    out.push(lineHtml(depth, '<span class="jv-' + jsonScalarCls(v) + '">' + escMetaText(String(v)) + '</span>'));
    return;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) { out.push(lineHtml(depth, '<span class="jv-punc">[]</span>')); return; }
    for (let i = 0; i < v.length; i++) {
      const p = joinMetaPath(prefix, String(i));
      out.push(lineHtml(depth, '<span class="jv-punc">' + i + ':</span>'));
      renderTreeInto(v[i], depth + 1, out, p);
    }
    return;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) { out.push(lineHtml(depth, '<span class="jv-punc">{}</span>')); return; }
  for (const k of keys) {
    const p = joinMetaPath(prefix, k);
    const val = (v as Record<string, unknown>)[k];
    if (val !== null && typeof val === 'object' || (typeof val === 'string' && ((val as string).trim().startsWith('{') || (val as string).trim().startsWith('[')) && val.length < 200000)) {
      if (typeof val === 'string') {
        try { val && renderTreeInto(JSON.parse(val as string), depth, out, p); continue; }
        catch { /* fallthrough literal */ }
      }
      out.push(lineHtml(depth, '<span class="js-meta-key' + metaKeyStateCls(p) + '" data-path="' + escAttr(p) + '" title="Select field ' + escAttr(displayMetaPath(p)) + '">' + escMetaText(k) + '</span>' + ' <span class="jv-punc">{…}</span>'));
      renderTreeInto(val, depth + 1, out, p);
      continue;
    }
    const keyCls = 'jv-key js-meta-key' + metaKeyStateCls(p);
    out.push(lineHtml(depth,
      '<span class="' + keyCls + '" data-path="' + escAttr(p) + '" title="Select field ' + escAttr(displayMetaPath(p)) + '">' + escMetaText(k) + '</span>' +
      '<span class="jv-punc">:</span> <span class="jv-str-ish">' + jsonScalarHtml(val) + '</span>'));
  }
}
function lineHtml(depth: number, content: string): string {
  return '<div class="json-line" style="padding-left:' + (depth * 14) + 'px">' + content + '</div>';
}
function jsonScalarCls(v: unknown): string {
  if (typeof v === 'number') return 'num';
  if (typeof v === 'boolean') return 'bool';
  if (v === null) return 'null';
  return 'str';
}
function jsonScalarHtml(v: unknown): string {
  if (v === null) return '<span class="jv-null">null</span>';
  if (Array.isArray(v)) return '<span class="jv-punc">' + escMetaText(JSON.stringify(v)) + '</span>';
  if (typeof v === 'object') return '<span class="jv-punc">{…}</span>';
  if (typeof v === 'string') return '<span class="jv-str">' + escMetaText(v.length > 220 ? v.slice(0, 220) + '…' : v) + '</span>';
  return '<span class="jv-' + jsonScalarCls(v) + '">' + escMetaText(String(v)) + '</span>';
}

function metaBodyHtml(meta: string | null | undefined): string {
  if (!meta) return '<span class="meta-empty">No paired .json file</span>';
  if (metaSelPaths.size === 0) {
    let parsed: unknown;
    try { parsed = JSON.parse(meta); }
    catch { return renderJsonMeta(meta); }
    const out: string[] = [];
    renderTreeInto(parsed, 0, out, '');
    if (out.length >= META_TREE_MAX_LINES)
      out.push('<div class="json-line" style="color:#888">… truncated (' + META_TREE_MAX_LINES + ' line limit) …</div>');
    return out.join('');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(meta); } catch { parsed = null; }
  const parts: string[] = [];
  const paths = Array.from(metaSelPaths).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  for (const p of paths) {
    parts.push('<div class="meta-sel"><span class="meta-sel-lbl js-meta-key" data-path="' + escAttr(p) + '">' + escMetaText(displayMetaPath(p)) + '</span>' +
      '<div class="meta-sel-val">' + metaValueHtml(parsed, p) + '</div></div>');
  }
  return parts.join('');
}

function metaTreeCached(raw: string): string {
  const c = metaTreeCache.get(raw);
  if (c) return c;
  const h = metaBodyHtml(raw);
  if (metaTreeCache.size > 8000) metaTreeCache.clear();
  metaTreeCache.set(raw, h);
  return h;
}

// ---- fields popup ----
let metaPopEl: HTMLElement | null = null;
function ensureMetaPop(): HTMLElement {
  if (metaPopEl) return metaPopEl;
  const pop = document.createElement('div');
  pop.className = 'meta-pop';
  pop.innerHTML =
    '<div class="mpo-head"><span class="mpo-title">Select fields</span><button class="mpo-x" title="Close">&times;</button></div>' +
    '<input class="mpo-search" placeholder="Filter fields…" />' +
    '<div class="mpo-list"></div>' +
    '<div class="mpo-foot"><button class="mpo-clear">Clear all</button></div>';
  (pop.querySelector('.mpo-x') as HTMLElement).addEventListener('click', closeMetaPop);
  (pop.querySelector('.mpo-clear') as HTMLElement).addEventListener('click', clearMetaSel);
  const inp = pop.querySelector('.mpo-search') as HTMLInputElement;
  inp.addEventListener('input', () => buildMetaPopList(pop, inp.value));
  document.body.appendChild(pop);
  metaPopEl = pop;
  return pop;
}
function discoverMetaFields(): Map<string, number> {
  // Every loaded JSON — paired tracks/groups AND standalone JSON cards all live
  // in metaMap, so a lone .json with no audio still yields its fields.
  if (!fieldCounts) {
    fieldCounts = new Map<string, number>();
    for (const raw of metaMap.values()) bumpFieldsOf(raw, fieldCounts, +1);
  }
  return fieldCounts;
}

// ---- field tree (hierarchical, leaf-based selection) ----
interface FieldNode {
  name: string;           // display segment ("stats" / "[0]")
  path: string;           // full JSON Pointer path ('' for the root)
  count: number;          // number of loaded files containing this path
  children: FieldNode[];
  leaves: string[];       // all leaf paths beneath this node (self if leaf)
}

let fieldTreeCache: FieldNode | null = null;
let fieldStateCache: Map<string, 'on' | 'partial'> | null = null;
let metaPopFilter = '';
const metaCollapsed = new Set<string>(); // collapsed node paths in the popup

/** Drop the cached field tree — call when the loaded JSON content changes. */
function invalidateFieldContent(): void { fieldTreeCache = null; fieldStateCache = null; }
/** Drop only the cached selection state — call when the selection changes. */
function invalidateFieldState(): void { fieldStateCache = null; }

/** Persistent path -> file-count index. Kept across metadata batches and
    updated incrementally, so arriving batches do not re-parse every JSON. */
let fieldCounts: Map<string, number> | null = null;

function bumpFieldsOf(raw: string, m: Map<string, number>, delta: number): void {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return; }
  const walk = (v: unknown, prefix: string) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, joinMetaPath(prefix, String(i)))); return; }
    for (const k of Object.keys(v)) {
      const p = joinMetaPath(prefix, k);
      const next = (m.get(p) || 0) + delta;
      if (next > 0) m.set(p, next); else m.delete(p);
      walk((v as Record<string, unknown>)[k], p);
    }
  };
  walk(parsed, '');
}

/** Fold per-key content changes into the persistent field-count index. */
function updateFieldCounts(updates: { old: string | undefined; text: string }[]): void {
  if (!fieldCounts) return;   // not built yet — discoverMetaFields builds lazily from metaMap
  for (const u of updates) {
    if (u.old !== undefined) bumpFieldsOf(u.old, fieldCounts, -1);
    bumpFieldsOf(u.text, fieldCounts, +1);
  }
}

function buildFieldTree(): FieldNode {
  const fields = discoverMetaFields();
  const root: FieldNode = { name: '', path: '', count: 0, children: [], leaves: [] };
  const byPath = new Map<string, FieldNode>([['', root]]);
  const ensure = (path: string): FieldNode => {
    const hit = byPath.get(path);
    if (hit) return hit;
    const slash = path.lastIndexOf('/');
    const last = decodeMetaPathSegment(path.slice(slash + 1));
    const parent = ensure(slash > 0 ? path.slice(0, slash) : '');
    const node: FieldNode = {
      name: /^\d+$/.test(last) ? '[' + last + ']' : last,
      path, count: 0, children: [], leaves: [],
    };
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const p of fields.keys()) ensure(p);
  for (const [p, c] of fields) { const n = byPath.get(p); if (n) n.count = c; }
  const computeLeaves = (n: FieldNode): void => {
    if (n.children.length === 0) { n.leaves = n.path ? [n.path] : []; return; }
    n.leaves = [];
    n.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const c of n.children) { computeLeaves(c); n.leaves.push(...c.leaves); }
  };
  computeLeaves(root);
  return root;
}

function getFieldTree(): FieldNode {
  if (!fieldTreeCache) fieldTreeCache = buildFieldTree();
  return fieldTreeCache;
}

/** Selection state of a node derived from its leaf paths. */
function nodeLeafState(node: FieldNode): 'on' | 'off' | 'partial' {
  if (node.leaves.length === 0) return 'off';
  let on = 0;
  for (const p of node.leaves) if (metaSelPaths.has(p)) on++;
  if (on === 0) return 'off';
  return on === node.leaves.length ? 'on' : 'partial';
}

function setNodeLeaves(node: FieldNode, on: boolean): void {
  for (const p of node.leaves) { if (on) metaSelPaths.add(p); else metaSelPaths.delete(p); }
}

/** Cascade-toggle a node: fully-selected -> clear its leaves, else select them. */
function toggleFieldNode(node: FieldNode): void {
  setNodeLeaves(node, nodeLeafState(node) !== 'on');
  commitMetaSel();
}

function findFieldNode(root: FieldNode, path: string): FieldNode | null {
  if (root.path === path) return root;
  for (const child of root.children) {
    const found = findFieldNode(child, path);
    if (found) return found;
  }
  return null;
}

/** Toggle a field path (from a JSON body key). Non-leaf nodes cascade to their
 *  leaves; leaf paths toggle exactly. */
function toggleMetaField(path: string): void {
  const node = findFieldNode(getFieldTree(), path);
  if (node) toggleFieldNode(node);
  else if (metaSelPaths.has(path)) { metaSelPaths.delete(path); commitMetaSel(); }
  else { metaSelPaths.add(path); commitMetaSel(); }
}

/** Map of path -> 'on' | 'partial' for highlight in the JSON body. */
function getFieldStates(): Map<string, 'on' | 'partial'> {
  if (!fieldStateCache) {
    const m = new Map<string, 'on' | 'partial'>();
    const walk = (n: FieldNode): void => {
      if (n.path) { const st = nodeLeafState(n); if (st !== 'off') m.set(n.path, st); }
      for (const c of n.children) walk(c);
    };
    walk(getFieldTree());
    fieldStateCache = m;
  }
  return fieldStateCache;
}

/** Extra class for a JSON key based on its (possibly partial) selection state. */
function metaKeyStateCls(path: string): string {
  const st = getFieldStates().get(path);
  return st === 'on' ? ' meta-key-on' : st === 'partial' ? ' meta-key-partial' : '';
}

function fieldNodeMatches(node: FieldNode, q: string): boolean {
  if (!q) return true;
  if (node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)) return true;
  return node.children.some(c => fieldNodeMatches(c, q));
}

function renderFieldNode(node: FieldNode, depth: number, q: string): string {
  if (!fieldNodeMatches(node, q)) return '';
  const state = nodeLeafState(node);
  const hasKids = node.children.length > 0;
  const collapsed = metaCollapsed.has(node.path);
  const caret = hasKids
    ? '<span class="mpo-caret" data-caret="' + escAttr(node.path) + '">' + (collapsed ? '&#9654;' : '&#9660;') + '</span>'
    : '<span class="mpo-caret mpo-caret-empty"></span>';
  let html = '<div class="mpo-node" style="padding-left:' + (depth * 14) + 'px">' + caret +
    '<label class="mpo-lbl"><input type="checkbox" data-path="' + escAttr(node.path) + '"' +
    (state === 'on' ? ' checked' : '') + ' data-partial="' + (state === 'partial' ? '1' : '0') + '" />' +
    '<span class="mpo-name">' + escMetaText(node.name) + '</span></label>' +
    '<span class="mpo-count">' + node.count + '</span></div>';
  if (hasKids && !collapsed) {
    for (const c of node.children) html += renderFieldNode(c, depth + 1, q);
  }
  return html;
}

function buildMetaPopList(pop: HTMLElement, filter: string): void {
  metaPopFilter = filter;
  const list = pop.querySelector('.mpo-list') as HTMLElement;
  const root = getFieldTree();
  const q = filter.trim().toLowerCase();
  const allState = nodeLeafState(root);
  const allRow = '<label class="mpo-item mpo-all"><input type="checkbox" data-all="1"' +
    (allState === 'on' ? ' checked' : '') + ' data-partial="' + (allState === 'partial' ? '1' : '0') + '" />' +
    '<span class="mpo-name">All fields</span><span class="mpo-count">' + root.leaves.length + '</span></label>';
  let tree = '';
  for (const c of root.children) tree += renderFieldNode(c, 0, q);
  if (!tree) {
    list.innerHTML = allRow + '<div class="mpo-empty">' +
      (q ? 'No matching fields' : 'No JSON fields loaded — open a .json first.') + '</div>';
    return;
  }
  list.innerHTML = allRow + tree;
  list.querySelectorAll<HTMLInputElement>('input[data-partial="1"]').forEach(cb => { cb.indeterminate = true; });
  const allCb = list.querySelector<HTMLInputElement>('input[data-all]');
  if (allCb) allCb.addEventListener('change', () => {
    const on = nodeLeafState(root) === 'on';
    setNodeLeaves(root, !on);
    commitMetaSel();
  });
  list.querySelectorAll<HTMLInputElement>('input[data-path]').forEach(cb => {
    cb.addEventListener('change', () => {
      const node = findFieldNode(getFieldTree(), cb.dataset.path || '');
      if (node) toggleFieldNode(node);
    });
  });
  list.querySelectorAll('.mpo-caret[data-caret]').forEach(caret => {
    caret.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const p = (caret as HTMLElement).dataset.caret || '';
      if (metaCollapsed.has(p)) metaCollapsed.delete(p); else metaCollapsed.add(p);
      buildMetaPopList(pop, metaPopFilter);
    });
  });
}
function toggleMetaPop(anchor: HTMLElement): void {
  const pop = ensureMetaPop();
  pop.classList.toggle('open');
  buildMetaPopList(pop, '');
  if (pop.classList.contains('open')) {
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(4, r.right - 260) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
  }
}
function closeMetaPop(): void {
  if (metaPopEl) { metaPopEl.classList.remove('open'); }
}
function metaPanelsMarkStale(): void {
  for (const t of tracks) if (t.metaPanel) t.metaPanel.body._metaLast = undefined;
  for (const g of groups) if (g.metaPanel) g.metaPanel.body._metaLast = undefined;
}
function refreshMetaWindow(): void {
  for (const t of tracks) {
    if (!t.metaPanel) continue;
    if (metaElNearViewport(t.el)) setMetaBody(t.metaPanel.body, t.meta);
  }
  for (const g of groups) {
    if (!g.metaPanel) continue;
    if (metaElNearViewport(g.el)) {
      const active = getActiveLaneOfGroup(g);
      setMetaBody(g.metaPanel.body, active ? active.meta : null);
    }
  }
}
function metaElNearViewport(el: HTMLElement | null): boolean {
  if (!el) return true;
  const er = el.getBoundingClientRect();
  const box = tracksBox.getBoundingClientRect();
  return !(er.bottom < box.top - 600 || er.top > box.bottom + 600);
}

// Lazy loading: one decode at a time; cards are loaded only while visible.
const MAX_CONCURRENT_LOADS = 1;
const activeLoadTokens = new Set<symbol>();
const loadQueue: Track[] = [];
let lazyObserver: IntersectionObserver;

function isTrackVisible(t: Track): boolean {
  if (!t.el?.isConnected) return false;
  const card = t.el.getBoundingClientRect();
  const box = tracksBox.getBoundingClientRect();
  return card.bottom > box.top && card.top < box.bottom;
}

function enqueueLoad(t: Track): void {
  if (t.loaded || t._loading) return;
  if (!loadQueue.some(q => q.id === t.id)) loadQueue.push(t);
  drainLoadQueue();
}

function drainLoadQueue(): void {
  while (activeLoadTokens.size < MAX_CONCURRENT_LOADS && loadQueue.length > 0) {
    const t = loadQueue.shift()!;
    if (t.loaded || t._loading || !isTrackAlive(t)) continue;
    if (!isTrackVisible(t)) continue; // dropped; the observer re-queues on re-entry
    const token = Symbol('track-load');
    activeLoadTokens.add(token);
    loadTrack(t).finally(() => {
      activeLoadTokens.delete(token);
      drainLoadQueue();
      if (activeLoadTokens.size === 0 && loadQueue.length === 0) markUnpairedMeta();
    });
  }
}

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

/**
 * Lazy-created placeholder cards are single-view; once decoded, a multichannel
 * standalone must be re-rendered with one lane per channel. Rebuilds only the
 * .track-body inside the existing card (header/ruler stay).
 */
function rebuildBodyAsMulti(t: Track): void {
  const card = t.el;
  if (!card) return;
  const old = card.querySelector('.track-body') as HTMLElement | null;
  const ruler = card.querySelector('.time-ruler') as HTMLElement | null;
  t.isMulti = true;
  ensureChannelViews(t, expandChannelCount(t));
  const body = buildSpecBody(t, SPEC_H);
  if (old && old.parentNode) {
    const parent = old.parentNode;
    if (ruler && ruler.parentNode === parent) parent.insertBefore(body, ruler);
    else if (old.nextSibling) parent.insertBefore(body, old.nextSibling);
    else parent.appendChild(body);
    old.remove();
  } else if (ruler && ruler.parentNode === card) {
    card.insertBefore(body, ruler);
  } else {
    card.appendChild(body);
  }
  scheduleReflow(); // lane layout/height changed → re-fit JSON panel caps
}

/** Remove a now-multichannel member from its diff group (multichannel files are
 *  never allowed to stay in a group) and re-create the whole set as standalone
 *  cards at the same DOM position. Returns true if a split happened. */
function splitMultiOutOfGroup(t: Track): boolean {
  const g = groups.find(gr => gr.id === t.groupId);
  if (!g) return false;
  const windowRec = renderedCards.find(record => record.elements.includes(g.el));
  const placeholder = document.createElement('div');
  if (g.el && g.el.parentNode === tracksBox) tracksBox.insertBefore(placeholder, g.el);
  const gid = g.id;
  const members = g.trackIds
    .map(id => tracks.find(x => x.id === id))
    .filter((x): x is Track => !!x && x.id !== t.id);
  removeDiffGroupQuietly(gid);
  // Re-create remaining group members as individual standalone cards.
  const els: (HTMLElement | null)[] = [];
  for (const m of members) {
    els.push(createStandalone(m.name, m.buffer || null, m.nativeSR, m.filePath, m.lazyUri));
  }
  // Re-create the multichannel track itself as a standalone (builds channel lanes).
  const selfEl = createStandalone(t.name, t.buffer || null, t.nativeSR, t.filePath, t.lazyUri);
  els.push(selfEl);
  // Place all newly created cards at the group's original DOM position.
  for (const el of els) {
    if (el && placeholder.parentNode && el.parentNode === tracksBox) {
      tracksBox.insertBefore(el, placeholder);
    }
  }
  if (placeholder.parentNode) placeholder.remove();
  // Keep the windowed list in sync with the newly created cards.
  if (windowRec) updateWindowRecord(windowRec, els.filter((el): el is HTMLElement => !!el));
  else pruneRendered();
  fixActiveTrack();
  refreshUI();
  // Trigger render for a freshly created multichannel standalone.
  const self = tracks.find(x => x.el === selfEl);
  if (self && self.isMulti && self.loaded && self._pendingRender) {
    self._pendingRender();
    self._pendingRender = null;
  }
  return true;
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
      const decoded = await decodeToAudioBuffer(raw);
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
    // A lazy-created placeholder does not know the channel count until decoded.
    const nCh = t.buffer ? t.buffer.numberOfChannels : 0;
    const expandLanes = nCh >= 2 && nCh <= 8;   // render one lane per channel
    const noGroup = nCh > 1;                     // multichannel never stays grouped
    if (noGroup && !t.isMulti) {
      if (t.groupId != null) {
        // Multichannel files never stay in a diff group — split this member out.
        // splitMultiOutOfGroup re-creates fresh standalone cards and triggers
        // their renders, so nothing more should touch the (now removed) track.
        if (isTrackAlive(t)) splitMultiOutOfGroup(t);
        if (loading && loading.parentNode) loading.remove();
        t._loading = false;
        return;
      }
      t.isMulti = true;
      if (expandLanes) rebuildBodyAsMulti(t);
      // else: >8ch fallback keeps the existing single (mixed) view.
    }
    // Lazy placeholder was built with an unknown nyquist (no freq labels). Now
    // that the sample rate is known, fill any empty .freq-labels within this
    // track's own body. Multi lanes rebuilt by rebuildBodyAsMulti are already
    // labelled, so only empty containers are touched (no cross-lane bleed).
    if (t.nyquist > 0) {
      const bodies = new Set<HTMLElement>();
      if (t.canvas) {
        const b = t.canvas.closest('.track-body') as HTMLElement | null;
        if (b) bodies.add(b);
      }
      for (const ch of t.chViews) {
        if (ch.canvas) {
          const b = ch.canvas.closest('.track-body') as HTMLElement | null;
          if (b) bodies.add(b);
        }
      }
      for (const b of bodies) {
        b.querySelectorAll('.freq-labels').forEach(fl => {
          if (!fl.querySelector('.freq-tick')) addFreqLabels(fl as HTMLElement, t.nyquist);
        });
      }
    }
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
    markAudioLoaded(t);
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
    groupId: null, el: null, meta: null, metaPanel: null, analysisResults: null, analysisCollapsed: false, filePath, lazyUri,
    viewStart: 0, viewEnd: dur,
    specData: null, specFrames: 0, specHop: 0, specH: 0, specMaxBin: 0, specGlobalPeak: -Infinity,
    waveformCanvas: null, waveformWrapper: null, waveformRow: null, waveformPh: null,
    isMulti: false, chViews: [], mutedCh: new Set(), activeCh: null, muteBtn: [],
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

/** Number of channels to render as separate lanes, or 0 to keep single view
 *  (mono file, >8ch fallback, or a file inside a diff group). */
function expandChannelCount(track: Track): number {
  if (!track.buffer) return 0;
  if (track.groupId != null) return 0; // group lanes are never expanded
  const n = track.buffer.numberOfChannels;
  if (n < 2 || n > 8) return 0;
  return n;
}

function isMultiTrack(track: Track): boolean {
  return track.isMulti && track.chViews.length > 0;
}

/** Add a per-channel entry to a multichannel track's chViews. */
function ensureChannelViews(track: Track, n: number): void {
  if (!track.isMulti || track.chViews.length) return;
  track.chViews = [];
  for (let i = 0; i < n; i++) {
    track.chViews.push({
      chIndex: i,
      canvas: null, wrapper: null, ph: null,
      waveformCanvas: null, waveformWrapper: null, waveformRow: null, waveformPh: null,
      specData: null, specFrames: 0, specHop: 0, specH: 0, specMaxBin: 0, specGlobalPeak: -Infinity,
      labelEl: null,
    });
  }
}

function buildSpecBody(track: Track, h: number): HTMLElement {
  // A standalone multichannel file (any ch>1) is never grouped. Tracks created
  // inside a diff group stay single-view (mono lanes) even if the buffer later
  // turns out multichannel — such members are split out on decode instead.
  if (track.groupId == null && track.buffer && track.buffer.numberOfChannels > 1) track.isMulti = true;
  const chCount = expandChannelCount(track);
  if (chCount >= 2) {
    track.chViews = track.chViews.length ? track.chViews : [];
    ensureChannelViews(track, chCount);
    return buildMultiChannelBody(track, h);
  }
  track.chViews = [];
  return buildSingleLaneBody(track, h);
}

/**
 * Single-view body — waveform row + one spectrogram row + analysis strip.
 * Used for mono tracks, diff-group lanes and the multichannel fallback.
 */
function buildSingleLaneBody(track: Track, h: number): HTMLElement {
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
  specRow.className = 'spec-row';
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

  attachLaneInteractions(track, track.canvas, track.wrapper!, track.waveformWrapper!);
  wirePendingRender(track, el, loading);

  return el;
}

/**
 * Multichannel body — one channel lane (label + waveform + spectrogram) per
 * channel, sharing the track's time axis/ruler. One analysis strip at the end.
 */
function buildMultiChannelBody(track: Track, h: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'track-body';
  el.style.flexDirection = 'column';

  const loadings: HTMLElement[] = [];

  for (let i = 0; i < track.chViews.length; i++) {
    const ch = track.chViews[i];
    const chH = channelSpecHeight(track.chViews.length);

    const laneEl = document.createElement('div');
    laneEl.className = 'ch-lane';

    // Channel label row
    const lblRow = document.createElement('div');
    lblRow.className = 'ch-label';
    lblRow.innerHTML =
      '<span class="ch-tag">' + esc('Ch' + (i + 1)) + '</span>' +
      '<span class="ch-name">' + esc(channelName(i)) + '</span>' +
      '<button class="ch-mute" title="Mute this channel">Mute</button>' +
      '<span class="ch-spacer"></span>';
    const muteBtn = lblRow.querySelector('.ch-mute') as HTMLButtonElement;
    track.muteBtn[i] = muteBtn;
    lblRow.querySelector('.ch-name')!.addEventListener('click', e => {
      e.stopPropagation();
      selectChannel(track, i);
    });
    muteBtn.addEventListener('click', e => {
      e.stopPropagation();
      selectChannel(track, i);
      if (track.mutedCh.has(i)) track.mutedCh.delete(i);
      else track.mutedCh.add(i);
      updateChannelListenUI(track);
      applyChannelListen(track);
    });
    laneEl.appendChild(lblRow);
    ch.labelEl = lblRow;

    // Waveform row
    const wfH = getWaveformHeight(chH);
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
    laneEl.appendChild(waveRow);
    ch.waveformRow = waveRow;
    ch.waveformWrapper = waveRow.querySelector('.waveform-wrapper');
    ch.waveformCanvas = waveRow.querySelector('canvas');
    ch.waveformPh = waveRow.querySelector('.waveform-playhead');
    addWaveformLabels(waveRow.querySelector('.waveform-labels') as HTMLElement, wfH);

    // Spectrogram row
    const specRow = document.createElement('div');
    specRow.style.cssText = 'display:flex;min-height:0';
    specRow.innerHTML =
      '<div class="freq-labels" style="height:' + chH + 'px"></div>' +
      '<div class="spec-wrapper" style="height:' + chH + 'px">' +
      '<canvas height="' + chH + '"></canvas>' +
      '<div class="playhead" style="left:0"></div>' +
      '<div class="loading-overlay"><div class="spinner"></div>Rendering...</div>' +
      '</div>';
    laneEl.appendChild(specRow);

    el.appendChild(laneEl);

    ch.canvas = specRow.querySelector('canvas');
    ch.wrapper = specRow.querySelector('.spec-wrapper');
    ch.ph = specRow.querySelector('.playhead');
    addFreqLabels(specRow.querySelector('.freq-labels') as HTMLElement, track.nyquist);
    const loading = specRow.querySelector('.loading-overlay') as HTMLElement;

    attachLaneInteractions(track, ch.canvas, ch.wrapper!, ch.waveformWrapper!);
    loadings.push(loading);
  }

  const strip = document.createElement('div');
  strip.className = 'analysis-strip empty';
  strip.style.paddingLeft = '44px';
  el.appendChild(strip);
  track.analysisStrip = strip;

  // Aggregate pending render over all channel lanes.
  if (track.loaded) {
    track._pendingRender = () => {
      const first = track.chViews[0];
      const w = first && first.wrapper ? first.wrapper.clientWidth : 0;
      if (w > 0) {
        for (const ch of track.chViews) {
          if (ch.canvas) ch.canvas.width = w;
          if (ch.waveformCanvas) ch.waveformCanvas.width = w;
        }
        setTimeout(() => {
          for (let i = 0; i < track.chViews.length; i++) renderSpec(track, i);
          if (waveformVisible) for (let i = 0; i < track.chViews.length; i++) drawWaveform(track, i);
          for (const ld of loadings) if (ld.parentNode) ld.remove();
        }, 0);
      } else {
        for (const ld of loadings) if (ld.parentNode) ld.remove();
      }
    };
  } else {
    for (const ld of loadings) {
      ld.innerHTML = '<span style="color:#666;font-size:11px">Waiting to load…</span>';
    }
    track._pendingRender = null;
  }

  updateChannelListenUI(track);

  return el;
}

function channelName(i: number): string {
  if (i === 0) return 'Left';
  if (i === 1) return 'Right';
  return 'Channel ' + (i + 1);
}

/** Refresh mute button visual state for every lane of a multichannel track. */
function updateChannelListenUI(t: Track): void {
  const n = t.buffer.numberOfChannels;
  for (let c = 0; c < n; c++) {
    const mute = t.muteBtn[c];
    if (mute) mute.classList.toggle('on', t.mutedCh.has(c));
  }
}

/** Refresh the selected-channel highlight across lanes (activeCh). */
function updateChannelActiveUI(t: Track): void {
  for (let c = 0; c < t.chViews.length; c++) {
    const el = t.chViews[c].labelEl;
    if (!el) continue;
    el.classList.toggle('selected', t.activeCh === c);
  }
}

/** Point-select a channel lane: highlights it (does not alter audio routing). */
function selectChannel(t: Track, c: number): void {
  t.activeCh = c;
  updateChannelActiveUI(t);
}

/**
 * Bind seek / zoom / selection-drag interactions to one lane's canvas. All lanes
 * operate on the shared track time axis (viewStart/viewEnd) so the geometry
 * comes from the lane while zoom state lives on the track.
 */
function attachLaneInteractions(
  track: Track,
  canvas: HTMLCanvasElement | null,
  wrapper: HTMLElement,
  waveWrapper: HTMLElement
): void {
  if (!canvas) return;
  const rectCanvas = (): DOMRect => canvas!.getBoundingClientRect();

  const seekHandler = (e: MouseEvent) => {
    if ((wrapper as any)._wasDrag) { (wrapper as any)._wasDrag = false; return; }
    const rect = rectCanvas();
    const cx = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, cx / rect.width));
    const time = track.viewStart + ratio * (track.viewEnd - track.viewStart);
    selectAndSeek(track, time);
  };
  wrapper.addEventListener('click', seekHandler);
  waveWrapper.addEventListener('click', seekHandler);

  const wheelHandler = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = rectCanvas();
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
  wrapper.addEventListener('wheel', wheelHandler, { passive: false });
  waveWrapper.addEventListener('wheel', wheelHandler, { passive: false });

  // Shift+drag = selection zoom
  let dragStartX: number | null = null;
  let selBox: HTMLElement | null = null;

  const onMouseMove = (e: MouseEvent) => {
    if (dragStartX === null || !selBox || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const left = Math.max(0, Math.min(dragStartX, e.clientX) - rect.left);
    const right = Math.min(rect.width, Math.max(dragStartX, e.clientX) - rect.left);
    selBox.style.left = left + 'px';
    selBox.style.width = (right - left) + 'px';
  };

  const onMouseUp = (e: MouseEvent) => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    if (dragStartX === null) return;
    const rect = canvas!.getBoundingClientRect();
    const x1 = Math.max(0, (Math.min(dragStartX, e.clientX) - rect.left) / rect.width);
    const x2 = Math.min(1, (Math.max(dragStartX, e.clientX) - rect.left) / rect.width);
    if (selBox) selBox.remove();
    selBox = null;
    dragStartX = null;

    if (x2 - x1 < 0.01) return; // too small
    (wrapper as any)._wasDrag = true; // prevent click-to-seek

    const span = track.viewEnd - track.viewStart;
    const newStart = track.viewStart + x1 * span;
    const newEnd = track.viewStart + x2 * span;
    setTrackView(track, newStart, newEnd);
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
  };

  wrapper.addEventListener('mousedown', e => {
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      dragStartX = e.clientX;
      selBox = document.createElement('div');
      selBox.className = 'zoom-selection';
      selBox.style.height = '100%';
      wrapper.appendChild(selBox);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    }
  });
}

/** Create the width-sync + deferred render callback shared by single & multi. */
function wirePendingRender(track: Track, el: HTMLElement, loading: HTMLElement): void {
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

// Coalesce high-frequency redraw requests (wheel zoom/pan) into one rAF frame:
// the last view window wins and each track is re-rasterized at most once.
const redrawQueue = new Set<Track>();
let redrawRafId = 0;
function scheduleTrackRedraw(track: Track): void {
  redrawQueue.add(track);
  if (!redrawRafId) redrawRafId = requestAnimationFrame(flushTrackRedraws);
}
function flushTrackRedraws(): void {
  redrawRafId = 0;
  const list = Array.from(redrawQueue);
  redrawQueue.clear();
  const done = new Set<Track>();
  for (const track of list) {
    if (!isTrackAlive(track) || done.has(track)) continue;
    redrawTrack(track);
    updateRuler(track);
    done.add(track);
    if (track.groupId != null) {
      for (const s of getSiblings(track)) {
        if (s.id === track.id || done.has(s)) continue;
        redrawTrack(s);
        updateRuler(s);
        done.add(s);
      }
    }
  }
  if (done.size) updatePlayheads();
}

function applyZoom(track: Track, anchorRatio: number, factor: number): void {
  const span = track.viewEnd - track.viewStart;
  const anchorTime = track.viewStart + anchorRatio * span;
  let newSpan = span * factor;
  newSpan = Math.max(MIN_VIEW_SPAN, Math.min(track.duration, newSpan));
  const newStart = anchorTime - anchorRatio * newSpan;
  setTrackView(track, newStart, newStart + newSpan);
  syncGroupZoom(track);
  scheduleTrackRedraw(track);
}

function applyPan(track: Track, shift: number): void {
  const span = track.viewEnd - track.viewStart;
  let newStart = track.viewStart + shift;
  newStart = Math.max(0, Math.min(track.duration - span, newStart));
  setTrackView(track, newStart, newStart + span);
  syncGroupZoom(track);
  scheduleTrackRedraw(track);
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
  if (!track.loaded) return;
  if (isMultiTrack(track)) {
    for (let i = 0; i < track.chViews.length; i++) {
      const ch = track.chViews[i];
      if (ch.canvas && ch.specData) drawSpec(track, i);
      if (waveformVisible && ch.waveformCanvas) drawWaveform(track, i);
    }
    return;
  }
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
  const cards = Array.from(tracksBox.children).filter(c => !c.classList.contains('scroll-sentinel')) as HTMLElement[];
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
  const cards = Array.from(tracksBox.children).filter(c => !c.classList.contains('scroll-sentinel')) as HTMLElement[];
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
    if (isMultiTrack(t)) {
      for (let i = 0; i < t.chViews.length; i++) {
        const ch = t.chViews[i];
        if (ch.waveformRow) ch.waveformRow.style.display = visible ? 'flex' : 'none';
        if (visible && ch.waveformCanvas && t.loaded) {
          const w = ch.wrapper!.clientWidth;
          if (w > 0) ch.waveformCanvas.width = w;
          drawWaveform(t, i);
        }
      }
      continue;
    }
    if (t.waveformRow) {
      t.waveformRow.style.display = visible ? 'flex' : 'none';
    }
    if (visible && t.waveformCanvas && t.loaded) {
      const w = t.wrapper!.clientWidth;
      if (w > 0) t.waveformCanvas.width = w;
      drawWaveform(t);
    }
  }
  scheduleReflow(); // audio height changed → re-fit JSON panel caps
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
  refreshMetaWindow(); // group JSON follows the active lane
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
  // Read phase: gather positions and widths first (single layout flush),
  // then write all styles — avoids interleaved read/write thrash.
  const jobs: { ph: HTMLElement; wf: HTMLElement | null; hide: boolean; px?: number; wfPx?: number }[] = [];
  for (const t of tracks) {
    if (!t.loaded) continue;
    const pos = getPos(t);
    const span = t.viewEnd - t.viewStart;
    const visible = !(pos < t.viewStart || pos > t.viewEnd);
    if (isMultiTrack(t)) {
      for (const ch of t.chViews) {
        if (!ch.canvas || !ch.ph) continue;
        if (!visible) { jobs.push({ ph: ch.ph, wf: ch.waveformPh ?? null, hide: true }); continue; }
        const frac = (pos - t.viewStart) / span;
        const px = frac * ch.wrapper!.clientWidth;
        const wfPx = ch.waveformPh ? (ch.waveformWrapper ? frac * ch.waveformWrapper.clientWidth : px) : 0;
        jobs.push({ ph: ch.ph, wf: ch.waveformPh ?? null, hide: false, px, wfPx });
      }
      continue;
    }
    if (!t.canvas || !t.ph) continue;
    if (!visible) { jobs.push({ ph: t.ph, wf: t.waveformPh ?? null, hide: true }); continue; }
    const frac = (pos - t.viewStart) / span;
    const px = frac * t.wrapper!.clientWidth;
    const wfPx = t.waveformPh ? (t.waveformWrapper ? frac * (t.waveformWrapper as HTMLElement).clientWidth : px) : 0;
    jobs.push({ ph: t.ph, wf: t.waveformPh ?? null, hide: false, px, wfPx });
  }
  for (const j of jobs) {
    if (j.hide) {
      j.ph.style.display = 'none';
      if (j.wf) j.wf.style.display = 'none';
      continue;
    }
    j.ph.style.display = '';
    j.ph.style.transform = 'translateX(' + j.px + 'px)';
    if (j.wf) {
      j.wf.style.display = '';
      j.wf.style.transform = 'translateX(' + j.wfPx + 'px)';
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
    if (t.isMulti) continue; // multichannel tracks never join groups
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

function createStandalone(name: string, buffer: AudioBuffer | null, nativeSR: number, filePath?: string, lazyUri?: string): HTMLElement {
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
  hdr.querySelector('.btn-analyze')!.addEventListener('click', e => { e.stopPropagation(); toggleAnalyze(t); });
  t.analyzeBtn = hdr.querySelector('.btn-analyze');
  card.appendChild(hdr);

  // Body row: audio (left) + paired JSON metadata (right, toggleable)
  const row = document.createElement('div');
  row.className = 'card-row';
  const left = document.createElement('div');
  left.className = 'card-left';
  left.appendChild(buildSpecBody(t, SPEC_H));
  left.appendChild(buildRuler(t));
  row.appendChild(left);
  const panel = buildMetaPanel();
  const resizer = makeMetaResizer(row, () => { refreshMetaWindow(); scheduleReflow(); });
  row.appendChild(resizer);
  row.appendChild(panel.aside);
  card.appendChild(row);
  t.metaPanel = panel;
  t.meta = metaMap.get(metaKeyOf(name, filePath)) || metaMap.get(metaKeyOf(name)) || null;
  setMetaBody(panel.body, t.meta);
  if (metaVisible) panel.aside.classList.add('show');

  tracksBox.appendChild(card);
  t.el = card;
  tracks.push(t);
  if (!activeTrackId) activeTrackId = t.id;

  if (t.loaded) {
    markAudioLoaded(t);
    requestAnimationFrame(() => { if (t._pendingRender) { t._pendingRender(); t._pendingRender = null; } });
  } else {
    lazyObserver.observe(card);
  }
  return card;
}

function createDiffGroup(baseName: string, items: DecodedItem[]): HTMLElement {
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
    lbl.querySelector('.btn-analyze')!.addEventListener('click', e => { e.stopPropagation(); toggleAnalyze(t); });
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

  // Body row: diff columns (left) + active-lane JSON metadata (right)
  const row = document.createElement('div');
  row.className = 'card-row';
  const left = document.createElement('div');
  left.className = 'card-left';
  left.appendChild(cols);
  row.appendChild(left);
  const panel = buildMetaPanel();
  const resizer = makeMetaResizer(row, () => { refreshMetaWindow(); scheduleReflow(); });
  row.appendChild(resizer);
  row.appendChild(panel.aside);
  card.appendChild(row);

  tracksBox.appendChild(card);
  groups.push({ id: gid, baseName, trackIds: grpTracks.map(t => t.id), el: card, metaPanel: panel });
  updateLaneHighlights();

  // Attach meta to each lane from the map (same stem matching), then show the
  // active lane's JSON in the shared panel.
  for (const t of grpTracks) {
    t.meta = metaMap.get(metaKeyOf(t.name, t.filePath)) || metaMap.get(metaKeyOf(t.name)) || null;
  }
  const activeLane = getActiveLaneOfGroup(groups[groups.length - 1]);
  setMetaBody(panel.body, activeLane ? activeLane.meta : null);
  if (metaVisible) panel.aside.classList.add('show');

  for (const t of grpTracks) if (t.loaded) markAudioLoaded(t);
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
  return card;
}

function addToDiffGroup(grp: Group, newItem: DecodedItem): HTMLElement {
  const existingItems = grp.trackIds.map(id => {
    const t = tracks.find(tr => tr.id === id);
    if (!t) return null;
    const tag = extractTag(stripExt(t.name)).tag;
    const suffix = tag || (t.filePath ? getParentFolderName(t.filePath) : t.name);
    return { name: t.name, buffer: t.buffer, suffix, nativeSR: t.nativeSR, filePath: t.filePath, lazyUri: t.lazyUri } as DecodedItem;
  }).filter(Boolean) as DecodedItem[];

  const windowRec = renderedCards.find(record => record.elements.includes(grp.el));
  const ph = insertPlaceholderBefore(grp.el);
  removeDiffGroupQuietly(grp.id);
  existingItems.push(newItem);
  const el = createDiffGroup(grp.baseName, existingItems);
  placeCardAtPosition(ph);
  if (windowRec) updateWindowRecord(windowRec, [el]);
  else pruneRendered();
  return el;
}

function notifyRemoveFromLoaded(t: Track): void {
  if (t.lazyUri) {
    (window as any).__vscodePostMessage({ type: 'removeFromLoaded', sourceId: t.lazyUri });
  } else if (t.filePath) {
    (window as any).__vscodePostMessage({ type: 'removeFromLoaded', filePath: t.filePath });
  }
}

function removeTrack(id: number): void {
  const i = tracks.findIndex(t => t.id === id);
  if (i < 0) return;
  const t = tracks[i];
  if (t.playing) stopSource(t);
  if (t.groupId != null) { removeDiffGroup(t.groupId); return; }
  notifyRemoveFromLoaded(t);
  if (t.el) { lazyObserver.unobserve(t.el); t.el.remove(); }
  tracks.splice(i, 1);
  pruneRendered();
  refreshAudioMetaIndex();
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
  lazyObserver.unobserve(grp.el);
  grp.el.remove();
  groups.splice(gi, 1);
  pruneRendered();
  refreshAudioMetaIndex();
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
  const windowRec = renderedCards.find(record => record.elements.includes(g.el));

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
  if (windowRec && newCard instanceof HTMLElement) updateWindowRecord(windowRec, [newCard]);
  else pruneRendered();
  refreshAudioMetaIndex();

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
  updateGroupingUI();
  highlightActive();
  updateLaneHighlights();
  updateTimeDisplay();
  ensureStandaloneJsonCards(); // prune/refresh standalone JSON cards against current tracks
  scheduleReflow();
}

/** Toggle a per-track analysis result strip between expanded / collapsed. If
 *  the track has no analysis yet, kicks off the classification run instead. */
function toggleAnalyze(t: Track): void {
  if (t.analysisResults) {
    t.analysisCollapsed = !t.analysisCollapsed;
    if (t.analysisStrip) t.analysisStrip.classList.toggle('empty', !!t.analysisCollapsed);
    if (t.analyzeBtn) t.analyzeBtn.textContent = t.analysisCollapsed ? 'Show Tags' : 'Hide Tags';
    if (!t.analysisCollapsed) renderAnalysisStrip(t);
  } else {
    runAnalysis(t);
  }
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

/** Partition incoming items for rendering: group by stem when auto-grouping is
 *  enabled, otherwise keep every file on its own (no diff groups are formed). */
function groupItems(items: DecodedItem[]): GroupResult[] {
  if (autoGroup) return groupByBaseName(items);
  return items.map(it => ({ baseName: it.name, items: [it] }));
}

export function handleFiles(items: DecodedItem[]): (HTMLElement | null)[] {
  for (const item of items) allAudioMetaKeys.add(audioKeyOf(item));
  const els: (HTMLElement | null)[] = [];
  const rest: DecodedItem[] = [];
  for (const it of items) {
    // Multichannel files (any ch>1) are never grouped — always standalone.
    if (it.buffer && it.buffer.numberOfChannels > 1) {
      els.push(createStandalone(it.name, it.buffer, it.nativeSR, it.filePath, it.lazyUri));
    } else {
      rest.push(it);
    }
  }
  if (rest.length === 0) { refreshUI(); return els; }

  const grouped = groupItems(rest);
  for (const grp of grouped) {
    let el: HTMLElement | null = null;
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
      el = createDiffGroup(grp.baseName, grp.items);
      if (ph) placeCardAtPosition(ph);
    } else {
      const newItem = grp.items[0];
      if (!autoGroup) {
        // Auto-grouping disabled: never merge, always a standalone card.
        el = createStandalone(newItem.name, newItem.buffer, newItem.nativeSR, newItem.filePath, newItem.lazyUri);
      } else {
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
          el = createDiffGroup(stem, mergeItems);
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
          el = createDiffGroup(stem, mergeItems);
          placeCardAtPosition(ph);
        } else {
          const existingGroup = findExistingGroupByStem(stem);
          if (existingGroup && tag) {
            // Known tag — add to existing group
            el = addToDiffGroup(existingGroup, { ...newItem, suffix: tag });
          } else if (existingGroup) {
            // No known tag — add with parent folder name as suffix
            el = addToDiffGroup(existingGroup, { ...newItem, suffix: newItem.filePath ? getParentFolderName(newItem.filePath) : undefined });
          } else {
            el = createStandalone(newItem.name, newItem.buffer, newItem.nativeSR, newItem.filePath, newItem.lazyUri);
          }
        }
      }
    }
    els.push(el);
  }
  refreshUI();
  return els;
}

/* ============================================================================
 * WINDOWED / VIRTUALIZED LAZY LOADING
 *
 * Lazy file URIs (sent by the extension host for large sets) are never all
 * materialized as cards at once. They sit in `pendingGroups` (grouped by stem
 * so A/B diff pairs are kept together) and are rendered through a bounded
 * window: a bottom sentinel reveals more on scroll-down, and cards that scroll
 * far above the viewport are recycled (released) and restored on scroll-up, so
 * the DOM stays small regardless of how many files the user scrolls through.
 * ========================================================================== */
const INITIAL_RENDER = 4;
const SCROLL_BATCH = 4;
const MAX_RENDERED = 12;
const REGROUP_CHUNK = 4;      // diff-group cards materialized per frame during grouping toggle
const REGROUP_PAUSE = 0;      // ms between chunks (yields main thread)

interface WindowGroup { baseName: string; items: DecodedItem[]; }
interface WindowRec { group: WindowGroup; elements: HTMLElement[]; restoreBefore?: WindowRec; }

let pendingGroups: WindowGroup[] = [];
let renderedCards: WindowRec[] = [];
let releasedTop: WindowRec[] = [];
let sentinelEl: HTMLElement | null = null;
let topSentinelEl: HTMLElement | null = null;
let sentinelObserver: IntersectionObserver | null = null;
let topObserver: IntersectionObserver | null = null;

function makeSentinel(): HTMLElement {
  const d = document.createElement('div');
  d.className = 'scroll-sentinel';
  d.style.cssText = 'height:1px;width:1px;';
  return d;
}

function cardElConnected(el: HTMLElement | null): boolean {
  return !!el && el.isConnected;
}

function recTracks(r: WindowRec): Track[] {
  const result: Track[] = [];
  for (const el of r.elements) {
    const g = groups.find(gr => gr.el === el);
    if (g) {
      result.push(...(g.trackIds.map(id => tracks.find(t => t.id === id)).filter(Boolean) as Track[]));
      continue;
    }
    const t = tracks.find(tr => tr.el === el);
    if (t) result.push(t);
  }
  return result;
}

function isPinnedRec(r: WindowRec): boolean {
  return recTracks(r).some(t => t.playing || (t.analysisResults && t.analysisResults.length > 0));
}

/** Rebuild a window record's group metadata from its (live) cards. */
function itemFromTrack(t: Track): DecodedItem {
  return {
    name: itemBaseName(t), buffer: t.buffer || null, nativeSR: t.nativeSR,
    filePath: t.filePath, lazyUri: t.lazyUri,
  };
}

function updateWindowRecord(record: WindowRec, elements: HTMLElement[]): void {
  record.elements = Array.from(new Set(elements.filter(cardElConnected)));
  const recordTracks = recTracks(record);
  if (recordTracks.length) {
    record.group = {
      baseName: recordTracks.length === 1
        ? itemBaseName(recordTracks[0])
        : (groups.find(group => record.elements.includes(group.el))?.baseName || record.group.baseName),
      items: recordTracks.map(itemFromTrack),
    };
  }
}

function makeWindowRecord(group: WindowGroup, elements: (HTMLElement | null)[]): WindowRec {
  const record: WindowRec = { group, elements: elements.filter((el): el is HTMLElement => !!el) };
  updateWindowRecord(record, record.elements);
  return record;
}

function fixActiveTrack(): void {
  if (activeTrackId !== null && !tracks.some(t => t.id === activeTrackId)) activeTrackId = null;
}

function removeCardByEl(el: HTMLElement): void {
  const g = groups.find(gr => gr.el === el);
  if (g) { removeDiffGroupQuietly(g.id); return; }
  const t = tracks.find(tr => tr.el === el && tr.groupId == null);
  if (t) removeTrackQuietly(t.id);
}

/* Drop window records whose card was merged away into another card. */
function pruneRendered(): void {
  for (const record of renderedCards) updateWindowRecord(record, record.elements);
  renderedCards = renderedCards.filter(record => record.elements.length > 0);
}

function renderedElementCount(): number {
  return renderedCards.reduce((count, record) => count + record.elements.length, 0);
}

/** Drop the decoded PCM a window record's descriptors hold onto. Only items
    that can re-decode from their lazy source release their buffer; on restore
    the cards re-fetch via lazyUri, so long scrolling sessions no longer pin
    every buffer ever rendered. */
function releaseRecordBuffers(rec: WindowRec): void {
  for (const it of rec.group.items) {
    if (it.buffer && it.lazyUri) it.buffer = null;
  }
}

function recycleTop(): void {
  while (renderedElementCount() > MAX_RENDERED) {
    const index = renderedCards.findIndex(record => !isPinnedRec(record));
    if (index < 0) break;
    const [r] = renderedCards.splice(index, 1);
    r.restoreBefore = renderedCards[index];
    for (const el of r.elements.slice()) removeCardByEl(el);
    r.elements = [];
    releaseRecordBuffers(r);
    releasedTop.push(r);
  }
  fixActiveTrack();
}

/** Keep restoring while the recycled boundary stays near the top, so parking
    at the very top fully restores the list instead of leaving a gap. */
let drainTopRunning = false;
function drainTop(): void {
  drainTopRunning = false;
  if (!releasedTop.length || !topSentinelEl || !topSentinelEl.isConnected) return;
  const box = tracksBox.getBoundingClientRect();
  const sent = topSentinelEl.getBoundingClientRect();
  if (sent.top < box.top - 2500 || sent.bottom > box.bottom + 2500) return;
  restoreTop(SCROLL_BATCH);
  if (!drainTopRunning) {
    drainTopRunning = true;
    requestAnimationFrame(drainTop);
  }
}

function updateSentinels(): void {
  if (pendingGroups.length) {
    if (!sentinelEl) { sentinelEl = makeSentinel(); sentinelObserver!.observe(sentinelEl); }
    tracksBox.appendChild(sentinelEl);
  } else if (sentinelEl) {
    sentinelObserver!.unobserve(sentinelEl);
    sentinelEl.remove();
    sentinelEl = null;
  }
  if (releasedTop.length) {
    if (!topSentinelEl) { topSentinelEl = makeSentinel(); topObserver!.observe(topSentinelEl); }
    const firstCard = renderedCards.flatMap(record => record.elements).find(cardElConnected);
    const anchor = firstCard || (tracksBox.firstChild as HTMLElement | null);
    if (!anchor || anchor.parentNode === tracksBox) tracksBox.insertBefore(topSentinelEl, anchor);
  } else if (topSentinelEl) {
    topObserver!.unobserve(topSentinelEl);
    topSentinelEl.remove();
    topSentinelEl = null;
  }
}

/** Materialize up to `count` groups from the head of the pending queue. */
function renderWindow(count: number): void {
  while (count-- > 0 && pendingGroups.length) {
    const g = pendingGroups.shift()!;
    const els = handleFiles(g.items);
    renderedCards.push(makeWindowRecord(g, els));
  }
  pruneRendered();
  recycleTop();
  updateSentinels();
}

/** Restore recycled cards at the top when the user scrolls back up. */
function restoreTop(count: number): void {
  while (count-- > 0 && releasedTop.length) {
    const r = releasedTop.pop()!;
    const insertionIndex = r.restoreBefore ? renderedCards.indexOf(r.restoreBefore) : renderedCards.length;
    const safeIndex = insertionIndex >= 0 ? insertionIndex : renderedCards.length;
    const anchor = renderedCards[safeIndex]?.elements.find(cardElConnected) || null;
    const els = handleFiles(r.group.items);
    updateWindowRecord(r, els.filter((el): el is HTMLElement => !!el));
    renderedCards.splice(safeIndex, 0, r);
    r.restoreBefore = undefined;
    if (anchor && cardElConnected(anchor) && anchor.parentNode === tracksBox) {
      for (const el of r.elements) {
        if (el !== anchor && el.parentNode === tracksBox) tracksBox.insertBefore(el, anchor);
      }
    }
  }
  pruneRendered();
  /* keep the window bounded: overflow at the bottom is re-queued */
  while (renderedElementCount() > MAX_RENDERED) {
    let index = renderedCards.length - 1;
    while (index >= 0 && isPinnedRec(renderedCards[index])) index--;
    if (index < 0) break;
    const [r] = renderedCards.splice(index, 1);
    for (const el of r.elements.slice()) if (el.isConnected) removeCardByEl(el);
    r.elements = [];
    releaseRecordBuffers(r);
    pendingGroups.unshift(r.group);
  }
  fixActiveTrack();
  updateSentinels();
}

export function handleFileURIs(files: { name: string; filePath?: string; sourceId?: string; uri?: string }[]): void {
  // Convert lazy sources to DecodedItems, then (re)group the whole pending set
  // so A/B pairs that share a stem are kept together for diff grouping.
  const newItems: DecodedItem[] = files.map(f => ({
    name: f.name,
    buffer: null,
    nativeSR: 0,
    filePath: f.filePath ?? f.uri,   // full path for directory-based grouping
    lazyUri: f.sourceId ?? f.uri,    // opaque source ID for on-demand loading
  }));
  if (autoGroup) {
    const combined = pendingGroups.flatMap(g => g.items).concat(newItems);
    pendingGroups = groupByBaseName(combined).map(g => ({ baseName: g.baseName, items: g.items }));
  } else {
    // Auto-grouping disabled: each lazy file becomes its own group so nothing
    // ever merges into a diff group.
    pendingGroups = pendingGroups.concat(newItems.map(f => ({ baseName: f.name, items: [f] })));
  }
  for (const item of newItems) allAudioMetaKeys.add(audioKeyOf(item));
  if (renderedCards.length === 0) renderWindow(INITIAL_RENDER);
  else updateSentinels();
  ensureStandaloneJsonCards();
  markUnpairedMeta();
}

export function clearAll(): void {
  stopAll();
  tracks.forEach(t => { if (t.el) t.el.remove(); });
  groups.forEach(g => { if (g.el) g.el.remove(); });
  tracks = [];
  groups = [];
  activeTrackId = null;
  pendingGroups = [];
  renderedCards = [];
  releasedTop = [];
  // standalone JSON cards are cleared too
  for (const c of jsonCards) if (c.card) c.card.remove();
  jsonCards.length = 0;
  metaMap.clear();
  metaSource.clear();
  metaTreeCache.clear();
  metaLeafCache.clear();
  fieldCounts = null;
  pendingMeta.clear();
  metaLoading.clear();
  allAudioMetaKeys.clear();
  loadedAudioKeys.clear();
  if (metaUnpairedTimer !== undefined) { clearTimeout(metaUnpairedTimer); metaUnpairedTimer = undefined; }
  invalidateFieldContent();
  loadQueue.length = 0;
  activeLoadTokens.clear();
  lazyObserver.disconnect();
  if (sentinelEl) { sentinelObserver!.unobserve(sentinelEl); sentinelEl = null; }
  if (topSentinelEl) { topObserver!.unobserve(topSentinelEl); topSentinelEl = null; }
  tracksBox.innerHTML = '';
  refreshUI();
}

/** Restore the original basename for a track, since computeDisplayNames() may
 *  have rewritten t.name to a relative path for cross-directory display. */
function itemBaseName(t: Track): string {
  if (!t.filePath) return t.name;
  // Archive logical paths are `${archivePath}\n${entry}`; the basename is the
  // last path segment of the entry, not of the archive path.
  const nlIdx = t.filePath.indexOf('\n');
  const logical = nlIdx >= 0 ? t.filePath.slice(nlIdx + 1) : t.filePath;
  const normalized = logical.replace(/\\/g, '/');
  return normalized.substring(normalized.lastIndexOf('/') + 1) || t.name;
}

/** Restore the analysis state captured before a rebuild/split onto a track
 *  that was just re-created, so the classification tags survive regrouping. */
function restoreTrackAnalysis(
  t: Track,
  backup: Map<string, { results: AnalysisSpan[]; collapsed: boolean }>
): void {
  const key = t.lazyUri || t.filePath || t.name;
  const snap = backup.get(key);
  if (!snap || !t.analysisStrip) return;
  t.analysisResults = snap.results;
  t.analysisCollapsed = snap.collapsed;
  if (snap.collapsed) {
    t.analysisStrip.classList.add('empty');
    if (t.analyzeBtn) t.analyzeBtn.textContent = 'Show Tags';
  } else {
    renderAnalysisStrip(t);
    if (t.analyzeBtn) t.analyzeBtn.textContent = 'Hide Tags';
  }
}

/** Snapshot per-track analysis results keyed by lazyUri/filePath/name so that
 *  a clearAll + rebuild (which recreates tracks) can restore the tags. */
function snapshotAnalysis(): Map<string, { results: AnalysisSpan[]; collapsed: boolean }> {
  const m = new Map<string, { results: AnalysisSpan[]; collapsed: boolean }>();
  for (const t of tracks) {
    if (!t.analysisResults || !t.analysisResults.length) continue;
    const key = t.lazyUri || t.filePath || t.name;
    m.set(key, { results: t.analysisResults, collapsed: !!t.analysisCollapsed });
  }
  return m;
}

/** Collect every source of data — live tracks plus pending/recycled window
 *  groups (whose cards have been removed from tracks[]) — de-duplicated by
 *  lazyUri/filePath/name. */
function collectAllItems(): DecodedItem[] {
  const byKey = new Map<string, DecodedItem>();
  const addItem = (item: DecodedItem): void => {
    const key = item.lazyUri || item.filePath || item.name;
    if (key && !byKey.has(key)) byKey.set(key, item);
  };
  for (const t of tracks) {
    addItem({
      name: itemBaseName(t),
      buffer: t.buffer || null,
      nativeSR: t.nativeSR,
      filePath: t.filePath,
      lazyUri: t.lazyUri,
    });
  }
  for (const g of pendingGroups) for (const it of g.items) addItem(it);
  for (const r of releasedTop) for (const it of r.group.items) addItem(it);
  return Array.from(byKey.values());
}

function sortItems(items: DecodedItem[]): DecodedItem[] {
  return items.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/** Rebuild window records from the current DOM after an in-place regrouping that
 *  replaced cards, so recycling/restoring keeps mapping to live elements. */
function syncRenderedWindowRecords(): void {
  const managed = new Set(renderedCards.flatMap(record => record.group.items)
    .map(item => item.lazyUri || item.filePath || item.name));
  if (!managed.size) return;
  const records: WindowRec[] = [];
  for (const node of Array.from(tracksBox.children)) {
    const el = node as HTMLElement;
    if (!el.classList.contains('card') || el.classList.contains('json-card')) continue;
    const cardTracks = (() => {
      const group = groups.find(candidate => candidate.el === el);
      if (group) return group.trackIds.map(id => tracks.find(track => track.id === id)).filter(Boolean) as Track[];
      const track = tracks.find(candidate => candidate.el === el);
      return track ? [track] : [];
    })();
    if (!cardTracks.length) continue;
    if (!cardTracks.some(track => managed.has(track.lazyUri || track.filePath || track.name))) continue;
    const group = groups.find(candidate => candidate.el === el);
    records.push(makeWindowRecord({
      baseName: group?.baseName || itemBaseName(cardTracks[0]),
      items: cardTracks.map(itemFromTrack),
    }, [el]));
  }
  renderedCards = records;
}

/** off → on: re-join currently-visible standalone cards into diff groups *in
 *  place* (the mirror of splitAllGroups). Cards are never cleared or rebuilt as
 *  a whole: only members of a stem that forms a group are removed from their
 *  standalone card and re-created as one group card at the same DOM position.
 *  Because the same AudioBuffer objects are reused, renderSpec hits the
 *  per-buffer spec cache and no FFT is recomputed — the spectrum does not
 *  disappear and the UI never blocks on a full rebuild.
 */
function rebuildAll(): void {
  // Multichannel files never join diff groups, so they are excluded both from
  // the standalone pool and from grouping below.
  const standalones = tracks.filter(t => t.groupId == null && !!t.buffer && !t.isMulti);
  if (standalones.length === 0) { groupingBusy = false; updateGroupingUI(); return; }
  const backup = snapshotAnalysis();

  // Index each current standalone card by its dedup key so we can map the
  // grouped items back onto the exact DOM cards they came from.
  const byKey = new Map<string, Track>();
  for (const t of standalones) {
    const key = t.lazyUri || t.filePath || t.name;
    if (key) byKey.set(key, t);
  }

  const items: DecodedItem[] = standalones.map(t => ({
    name: itemBaseName(t), buffer: t.buffer, nativeSR: t.nativeSR,
    filePath: t.filePath, lazyUri: t.lazyUri,
  }));
  const plans: { stem: string; items: DecodedItem[]; cardEls: HTMLElement[] }[] = [];
  for (const g of groupByBaseName(items)) {
    if (g.items.length < 2) continue; // single-file stem stays as-is
    const cardEls: HTMLElement[] = [];
    let ok = true;
    for (const it of g.items) {
      const key = it.lazyUri || it.filePath || it.name;
      const tr = key ? byKey.get(key) : undefined;
      if (!tr || !tr.el) { ok = false; break; }
      cardEls.push(tr.el);
    }
    if (!ok) continue; // be conservative: skip stems we cannot fully map
    plans.push({ stem: g.baseName, items: g.items, cardEls });
  }
  if (plans.length === 0) { groupingBusy = false; updateGroupingUI(); return; }

  let idx = 0;
  let alive = true;
  const finish = (): void => {
    alive = false;
    groupingBusy = false;
    syncRenderedWindowRecords();
    recycleTop();
    updateSentinels();
    refreshUI();
    updateGroupingUI();
  };
  const step = (): void => {
    if (!alive) return;
    try {
      let done = 0;
      while (idx < plans.length && done < REGROUP_CHUNK) {
        const plan = plans[idx++];
        done++;
        const anchor = insertPlaceholderBefore(plan.cardEls[0]);
        for (const el of plan.cardEls) {
          const tr = tracks.find(x => x.el === el);
          if (tr) removeTrackQuietly(tr.id);
        }
        const el = createDiffGroup(plan.stem, plan.items);
        placeCardAtPosition(anchor);
        const g = groups.find(x => x.el === el);
        if (g) {
          for (const tid of g.trackIds) {
            const t = tracks.find(x => x.id === tid);
            if (t) restoreTrackAnalysis(t, backup);
          }
        }
      }
      if (idx < plans.length && groupingBusy) {
        window.setTimeout(step, REGROUP_PAUSE);
        return;
      }
    } catch (e) {
      console.error('rebuildAll chunk error:', e);
    }
    finish();
  };
  groupingBusy = true;
  window.setTimeout(step, REGROUP_PAUSE);
}

/** on → off: split every existing diff-group card into individual standalone
 *  cards, in place (the member cards stay at the group's original position).
 *  Standalone cards that were never grouped are left untouched. Chunked the same
 *  way as rebuildAll so splitting many groups does not block the UI. */
function splitAllGroups(): void {
  if (groups.length === 0) { groupingBusy = false; updateGroupingUI(); return; }
  const backup = snapshotAnalysis();
  const gs = groups.slice();
  let idx = 0;
  let alive = true;
  const finish = (): void => {
    alive = false;
    groupingBusy = false;
    syncRenderedWindowRecords();
    recycleTop();
    updateSentinels();
    refreshUI();
    updateGroupingUI();
  };
  const step = (): void => {
    if (!alive) return;
    try {
      let done = 0;
      while (idx < gs.length && done < REGROUP_CHUNK) {
        const grp = gs[idx++];
        if (!groups.some(g => g.id === grp.id)) continue; // already removed meanwhile
        done++;
        const members = grp.trackIds
          .map(id => tracks.find(t => t.id === id))
          .filter((t): t is Track => !!t)
          .map(t => ({ name: itemBaseName(t), buffer: t.buffer || null, nativeSR: t.nativeSR, filePath: t.filePath, lazyUri: t.lazyUri }));
        const anchor = grp.el.nextSibling;
        removeDiffGroupQuietly(grp.id);
        for (const it of members) {
          const card = createStandalone(it.name, it.buffer, it.nativeSR, it.filePath, it.lazyUri);
          const t = tracks.find(x => x.el === card);
          if (t) restoreTrackAnalysis(t, backup);
          if (anchor && anchor.parentNode === tracksBox) tracksBox.insertBefore(card, anchor);
        }
      }
      if (idx < gs.length && groupingBusy) {
        window.setTimeout(step, REGROUP_PAUSE);
        return;
      }
    } catch (e) {
      console.error('splitAllGroups chunk error:', e);
    }
    finish();
  };
  groupingBusy = true;
  window.setTimeout(step, REGROUP_PAUSE);
}

/** Toggle auto-grouping. Switching back on rebuilds all groupings; switching
 *  off splits current groups in place. */
export function toggleAutoGroup(): void {
  if (groupingBusy) return; // ignore clicks while a regroup/split is running
  autoGroup = !autoGroup;
  updateGroupingUI();
  if (autoGroup) rebuildAll();
  else splitAllGroups();
}

function updateGroupingUI(): void {
  if (!btnGrouping) return;
  btnGrouping.disabled = tracks.length === 0 || groupingBusy;
  btnGrouping.textContent = groupingBusy ? 'Working…' : (autoGroup ? 'Grouping: On' : 'Grouping: Off');
  btnGrouping.classList.toggle('active', autoGroup);
}

export function initUI(): void {
  dropZone = document.getElementById('drop-zone')!;
  tracksBox = document.getElementById('tracks-container')!;
  btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
  btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
  btnAnalyzeAll = document.getElementById('btn-analyze-all') as HTMLButtonElement;
  btnGrouping = document.getElementById('btn-grouping') as HTMLButtonElement;
  btnZoomIn = document.getElementById('btn-zoom-in') as HTMLButtonElement;
  btnZoomOut = document.getElementById('btn-zoom-out') as HTMLButtonElement;
  btnZoomFit = document.getElementById('btn-zoom-fit') as HTMLButtonElement;
  timeDisp = document.getElementById('time-display')!;
  playIcon = document.getElementById('play-icon')!;
  playLabel = document.getElementById('play-label')!;

  btnGrouping.addEventListener('click', toggleAutoGroup);

  // Lazy audio is loaded only while its card is inside the scroll viewport.
  lazyObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const card = entry.target as HTMLElement;
      const trackId = card.dataset.trackId;
      const groupId = card.dataset.groupId;
      const cardTracks = trackId
        ? tracks.filter(track => track.id === Number(trackId))
        : groups.find(group => group.id === Number(groupId))?.trackIds
          .map(id => tracks.find(track => track.id === id)).filter(Boolean) as Track[] | undefined;
      if (!cardTracks) continue;
      if (entry.isIntersecting) {
        for (const track of cardTracks) if (!track.loaded) enqueueLoad(track);
      } else {
        for (const track of cardTracks) {
          if (!track._loading) {
            const index = loadQueue.findIndex(queued => queued.id === track.id);
            if (index >= 0) loadQueue.splice(index, 1);
          }
        }
      }
    }
  }, { root: tracksBox, rootMargin: '0px', threshold: 0.01 });

  sentinelObserver = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) renderWindow(SCROLL_BATCH);
  }, { root: tracksBox, rootMargin: '0px' });
  topObserver = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) drainTop();
  }, { root: tracksBox, rootMargin: '0px' });

  // Meta width restore + interactions
  try { const saved = localStorage.getItem('specview-meta-width'); if (saved) document.documentElement.style.setProperty('--meta-width', saved); } catch { /* ignore */ }
  document.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('js-meta-key') || target.classList.contains('meta-sel-lbl')) {
      const p = target.getAttribute('data-path');
      if (p) toggleMetaKey(p);
      return;
    }
    if (metaPopEl && !metaPopEl.contains(target) && !target.classList.contains('meta-pill')) closeMetaPop();
  });
  tracksBox.addEventListener('scroll', () => { requestAnimationFrame(refreshMetaWindow); }, { passive: true });

  refreshUI();

  // Window resize: debounced reflow keeps canvas backing widths in sync with
  // the layout, redrawing from the cached spec data (no FFT recompute). Both
  // single-view tracks and multichannel lane tracks are handled.
  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(reflowSpectrograms, 150);
  });
}

/** Defer a reflow to the next animation frame. Toggling the JSON panel only
 *  changes layout via a class change, so measuring width synchronously in the
 *  same task can still read the pre-toggle width; a frame boundary guarantees
 *  the new flex layout has been applied. Coalesces bursts into one reflow. */
let reflowRaf: number | null = null;
function scheduleReflow(): void {
  if (reflowRaf != null) return;
  reflowRaf = requestAnimationFrame(() => {
    reflowRaf = null;
    reflowSpectrograms();
  });
}

/** Content height of a standard single-view wav card's audio column, measured
 *  with its row un-stretched. Falls back to the fixed spec height. */
function standardCardContentHeight(): number {
  for (const t of tracks) {
    if (t.groupId != null || isMultiTrack(t) || !t.el) continue;
    const left = t.el.querySelector('.card-left') as HTMLElement | null;
    if (left && left.offsetHeight > 0) return left.offsetHeight;
  }
  return SPEC_H + 16; // spec row + time ruler
}

/** Cap JSON panel heights so they never exceed the audio content beside them:
 *  a paired panel matches its own card's audio column, and a standalone JSON
 *  card matches a standard wav card. Content beyond the cap scrolls inside
 *  .meta-body. Re-measured on every reflow (window resize / panel toggle).
 *
 *  `.card-row` stretches items, so a tall JSON panel would otherwise stretch
 *  `.card-left` too — making its offsetHeight useless as a cap. We momentarily
 *  un-stretch every panel row to read the audio column's natural height, then
 *  apply the caps. No paint happens between measure and restore. */
function syncMetaHeights(): void {
  const entries: { aside: HTMLElement; left: HTMLElement | null; shown: boolean }[] = [];
  const collect = (panel: { aside: HTMLElement } | null | undefined): void => {
    if (!panel) return;
    const aside = panel.aside;
    const row = aside.parentElement;
    const left = row ? row.querySelector(':scope > .card-left') as HTMLElement | null : null;
    entries.push({ aside, left, shown: aside.classList.contains('show') });
  };
  for (const t of tracks) collect(t.metaPanel);
  for (const g of groups) collect(g.metaPanel);

  const rows = new Set<HTMLElement>();
  for (const e of entries) { const r = e.aside.parentElement; if (r) rows.add(r); }
  for (const r of rows) r.classList.add('no-stretch');
  const heights = new Map<HTMLElement, number>();
  for (const e of entries) if (e.left) heights.set(e.left, e.left.offsetHeight);
  const standaloneH = standardCardContentHeight();
  for (const r of rows) r.classList.remove('no-stretch');

  for (const e of entries) {
    const h = e.left ? (heights.get(e.left) || 0) : 0;
    e.aside.style.maxHeight = (e.shown && h > 0) ? h + 'px' : '';
  }
  for (const jc of jsonCards) {
    jc.panel.aside.style.maxHeight = standaloneH > 0 ? standaloneH + 'px' : '';
  }
}

/** Re-sync every loaded track's canvas backing width to its wrapper's current
 *  layout width, then re-draw from the cached spectrum (no FFT recompute).
 *  Used after the JSON panel toggles or is resized, since those layout changes
 *  do not fire a window resize event. */
function reflowSpectrograms(): void {
  for (const t of tracks) {
    if (!t.loaded) continue;
    if (isMultiTrack(t)) {
      for (const ch of t.chViews) {
        const w = ch.wrapper ? ch.wrapper.clientWidth : 0;
        if (w <= 0 || !ch.canvas || w === ch.canvas.width) continue;
        ch.canvas.width = w;
        if (ch.waveformCanvas) ch.waveformCanvas.width = w;
      }
      redrawTrack(t);
      updateRuler(t);
      continue;
    }
    const w = t.wrapper ? t.wrapper.clientWidth : 0;
    if (w <= 0 || !t.canvas || w === t.canvas.width) continue;
    t.canvas.width = w;
    if (t.waveformCanvas) t.waveformCanvas.width = w;
    if (t.specData) {
      drawSpec(t);
      if (waveformVisible && t.waveformCanvas) drawWaveform(t);
    }
    updateRuler(t);
  }
  updatePlayheads();
  syncMetaHeights();
}