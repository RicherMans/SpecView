export interface TarEntry {
  name: string;
  offset: number;
  size: number;
}

export interface ArchiveContents {
  audio: TarEntry[];
  json: TarEntry[];
  cachedBytes: number;
}

export const ARCHIVE_LIMITS = {
  maxEntries: 200_000,
  maxCachedBytes: 20 * 1024 * 1024 * 1024,
  maxExpandedBytes: 20 * 1024 * 1024 * 1024,
  maxPathBytes: 64 * 1024,
  maxPathTotalBytes: 64 * 1024 * 1024,
} as const;
