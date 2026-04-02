import type { Track } from './types';

let audioCtx: AudioContext;
let gainNode: GainNode;

export function initAudio(): { audioCtx: AudioContext; gainNode: GainNode } {
  audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  gainNode = audioCtx.createGain();
  gainNode.connect(audioCtx.destination);
  gainNode.gain.value = 0.8;
  return { audioCtx, gainNode };
}

export function getAudioContext(): AudioContext {
  return audioCtx;
}

export function setVolume(v: number): void {
  if (gainNode) gainNode.gain.value = v;
}

export function playSource(t: Track, from: number): void {
  if (t.playing) stopSource(t);
  t.offset = from;
  t.startTime = audioCtx.currentTime;
  const src = audioCtx.createBufferSource();
  src.buffer = t.buffer;
  src.connect(gainNode);
  src.start(0, from);
  t.source = src;
  t.playing = true;
  src.onended = () => {
    // Only clear state if this source is still the active one
    // (prevents stale onended from a previous source clearing the new source's state)
    if (t.source === src) {
      t.offset = t.duration;
      t.playing = false;
      t.source = null;
    }
  };
}

export function stopSource(t: Track): void {
  if (!t.playing) return;
  t.offset = Math.min(t.offset + audioCtx.currentTime - t.startTime, t.duration);
  try { t.source!.stop(); } catch { /* ignore */ }
  t.source = null;
  t.playing = false;
}

export function getPos(t: Track): number {
  if (!audioCtx) return t.offset;
  return t.playing ? Math.min(t.offset + audioCtx.currentTime - t.startTime, t.duration) : t.offset;
}

export function resumeAudio(): void {
  if (audioCtx) audioCtx.resume();
}
