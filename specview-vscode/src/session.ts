import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { ARCHIVE_LIMITS, type TarEntry } from './archive/types';

export type Source =
  | { kind: 'file'; name: string; filePath: string; size: number }
  | { kind: 'tar'; name: string; filePath: string; entry: TarEntry }
  | { kind: 'temp'; name: string; filePath: string; size: number };

const cleanupStarted = new Set<string>();

async function cleanupStaleSessions(storagePath: string): Promise<void> {
  const root = path.join(storagePath, 'sessions');
  await mkdir(root, { recursive: true });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    try {
      if ((await stat(directory)).mtimeMs < cutoff) await rm(directory, { recursive: true, force: true });
    } catch { /* another session may already have removed it */ }
  }
}

/** Per-WebviewPanel archive state: opaque source registry, temp extraction
 *  directory, cache accounting and serialized operations. */
export class PanelSession {
  readonly loadedFiles = new Set<string>();
  readonly rootUris = new Map<string, import('vscode').Uri>();
  readonly sources = new Map<string, Source>();
  generation = 1;
  ready = false;
  private tempDirectory: string | undefined;
  private cachedBytes = 0;
  private disposed = false;
  private operations: Promise<void> = Promise.resolve();

  constructor(private readonly storagePath: string) {
    if (!cleanupStarted.has(storagePath)) {
      cleanupStarted.add(storagePath);
      void cleanupStaleSessions(storagePath).catch(error => console.error('[SpecView] Cache cleanup failed:', error));
    }
  }

  isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  register(source: Source): string {
    const sourceId = `specview-source:${this.generation}:${randomUUID()}`;
    this.sources.set(sourceId, source);
    return sourceId;
  }

  removeRoot(filePath: string): void {
    for (const [key, uri] of this.rootUris) {
      if (uri.fsPath === filePath) this.rootUris.delete(key);
    }
  }

  async unregisterSource(sourceId: string): Promise<Source | undefined> {
    const source = this.sources.get(sourceId);
    if (!source) return undefined;
    this.sources.delete(sourceId);
    if (source.kind === 'temp') {
      await rm(source.filePath, { force: true });
      this.releaseCachedBytes(source.size);
    }
    return source;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }

  get remainingCacheBytes(): number {
    return ARCHIVE_LIMITS.maxCachedBytes - this.cachedBytes;
  }

  addCachedBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remainingCacheBytes) {
      throw new Error(`Session archive cache exceeds ${ARCHIVE_LIMITS.maxCachedBytes} bytes`);
    }
    this.cachedBytes += bytes;
  }

  releaseCachedBytes(bytes: number): void {
    this.cachedBytes = Math.max(0, this.cachedBytes - Math.max(0, bytes));
  }

  async discardArchiveDirectory(directory: string | undefined): Promise<void> {
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  async createArchiveDirectory(generation: number): Promise<string> {
    if (!this.tempDirectory) {
      this.tempDirectory = path.join(this.storagePath, 'sessions', randomUUID());
    }
    const root = this.tempDirectory;
    await mkdir(root, { recursive: true });
    if (!this.isCurrent(generation)) {
      if (this.tempDirectory === root) this.tempDirectory = undefined;
      await rm(root, { recursive: true, force: true });
      throw new Error('Stale session generation');
    }
    const directory = path.join(root, randomUUID());
    await mkdir(directory, { recursive: true });
    if (!this.isCurrent(generation)) {
      await rm(directory, { recursive: true, force: true });
      throw new Error('Stale session generation');
    }
    return directory;
  }

  async clear(): Promise<void> {
    await this.reset(false);
  }

  async resetForReload(): Promise<void> {
    await this.reset(true);
  }

  private async reset(preserveRoots: boolean): Promise<void> {
    this.generation++;
    this.loadedFiles.clear();
    if (!preserveRoots) this.rootUris.clear();
    this.sources.clear();
    this.cachedBytes = 0;
    const directory = this.tempDirectory;
    this.tempDirectory = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.reset(false);
  }
}
