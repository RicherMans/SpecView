import type { DecodedItem, GroupResult } from './types';

export const KNOWN_TAGS = [
  'orig', 'original', 'ref', 'reference', 'gt', 'ground_truth', 'target',
  'pred', 'predicted', 'gen', 'generated', 'synth', 'synthesized', 'output',
  'recon', 'reconstructed', 'enhanced', 'denoised', 'clean', 'noisy',
  'src', 'source', 'input', 'baseline', 'model',
  'v1', 'v2', 'v3', 'v4', 'a', 'b', 'c', 'd',
];
export const TAG_CSS = ['tag-a', 'tag-b', 'tag-c', 'tag-d'];

/* Sort longest first so 'ground_truth' beats 'gt', 'original' beats 'a', etc. */
const SORTED_TAGS = KNOWN_TAGS.slice().sort((a, b) => b.length - a.length);

export function stripExt(n: string): string {
  return n.replace(/\.[^.]+$/, '');
}

export interface TagResult {
  stem: string;
  tag: string;
  mode: 'suffix' | 'prefix' | 'none';
}

/**
 * Extract a known tag from a filename (without extension).
 * Checks suffix (_tag, -tag) then prefix (tag_, tag-) patterns,
 * using longest-match-first from KNOWN_TAGS.
 * Returns { stem, tag, mode }. If no known tag matches, tag is ''.
 */
export function extractTag(noExt: string): TagResult {
  const low = noExt.toLowerCase();

  for (const tag of SORTED_TAGS) {
    /* suffix: stem_tag  or  stem-tag */
    const sufPat1 = '_' + tag;
    const sufPat2 = '-' + tag;
    if (low.endsWith(sufPat1)) {
      return { stem: noExt.slice(0, -sufPat1.length), tag: noExt.slice(-tag.length), mode: 'suffix' };
    }
    if (low.endsWith(sufPat2)) {
      return { stem: noExt.slice(0, -sufPat2.length), tag: noExt.slice(-tag.length), mode: 'suffix' };
    }

    /* prefix: tag_stem  or  tag-stem */
    const prePat1 = tag + '_';
    const prePat2 = tag + '-';
    if (low.startsWith(prePat1)) {
      return { stem: noExt.slice(prePat1.length), tag: noExt.slice(0, tag.length), mode: 'prefix' };
    }
    if (low.startsWith(prePat2)) {
      return { stem: noExt.slice(prePat2.length), tag: noExt.slice(0, tag.length), mode: 'prefix' };
    }
  }

  return { stem: noExt, tag: '', mode: 'none' };
}

/**
 * Group items by their stem. Only forms a diff group when there are
 * at least 2 items with at least 2 distinct tags (including empty tag).
 */
export function groupByBaseName(items: DecodedItem[]): GroupResult[] {
  const m = new Map<string, { baseName: string; items: DecodedItem[] }>();
  for (const it of items) {
    const { stem, tag } = extractTag(stripExt(it.name));
    const key = stem.toLowerCase();
    if (!m.has(key)) m.set(key, { baseName: stem, items: [] });
    m.get(key)!.items.push({ ...it, suffix: tag });
  }
  const out: GroupResult[] = [];
  for (const [, val] of m) {
    const uniq = new Set(val.items.map(i => (i.suffix || '').toLowerCase()));
    if (val.items.length >= 2 && uniq.size >= 2) {
      out.push(val);
      continue;
    }
    for (const it of val.items) {
      out.push({ baseName: it.name, items: [it] });
    }
  }
  return out;
}

export function parseNativeSampleRate(arrayBuffer: ArrayBuffer): number | null {
  const view = new DataView(arrayBuffer);

  if (view.byteLength >= 28) {
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    if (riff === 'RIFF' && wave === 'WAVE') {
      return view.getUint32(24, true);
    }
  }

  if (view.byteLength >= 22) {
    const flac = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (flac === 'fLaC') {
      const byte10 = view.getUint8(18);
      const byte11 = view.getUint8(19);
      const byte12 = view.getUint8(20);
      return ((byte10 << 12) | (byte11 << 4) | (byte12 >> 4));
    }
  }

  return null;
}
