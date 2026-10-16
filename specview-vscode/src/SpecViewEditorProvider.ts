import * as vscode from 'vscode';
import * as path from 'node:path';
import { open as openFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { extractGzipArchive } from './archive/gzipArchive';
import { indexTarFile } from './archive/tarIndex';
import type { TarEntry } from './archive/types';
import { lazySourceDescriptor, parseFileDataRequest } from './protocol';
import { PanelSession, type Source } from './session';
import { getWebviewHtml } from './webviewHtml';

const ARCHIVE_EXT = /\.(tar|tar\.gz|tgz)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a|aac|webm|wma|aiff|opus)$/i;
const LAZY_THRESHOLD = 10;
const EAGER_MAX_BYTES = 8 << 20;
const EAGER_TOTAL_MAX_BYTES = 32 << 20;
const MESSAGE_BATCH_SIZE = 500;
const FILE_CHUNK_BYTES = 1 << 20;

function isArchive(name: string): boolean {
  return ARCHIVE_EXT.test(name);
}

function isAudioFile(name: string): boolean {
  return AUDIO_EXT.test(name);
}

function uint8ToBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

async function readTarRegion(filePath: string, entry: TarEntry): Promise<Buffer> {
  const handle = await openFile(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (entry.offset < 0 || entry.size < 0 || entry.offset + entry.size > stat.size) {
      throw new Error('Tar entry exceeds current archive size');
    }
    const buffer = Buffer.allocUnsafe(entry.size);
    let read = 0;
    while (read < entry.size) {
      const result = await handle.read(buffer, read, entry.size - read, entry.offset + read);
      if (result.bytesRead === 0) throw new Error('Unexpected end of tar entry');
      read += result.bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

const CED_MODEL_FILE = 'ced-tiny.onnx';
const CED_MODEL_PATH = 'mispeech/ced-tiny/resolve/main/model.onnx';
const CED_MIRRORS = [
  'https://huggingface.co/',
  'https://hf-mirror.com/',
];

export class SpecViewEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'specview.editor';

  private static panel: vscode.WebviewPanel | null = null;
  private static lastOpenDir: vscode.Uri | undefined;
  private static readonly sessions = new WeakMap<vscode.WebviewPanel, PanelSession>();
  private static modelDownloading = false;
  private static modelDownloadCallbacks: { resolve: (uri: vscode.Uri) => void; reject: (e: Error) => void }[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  static getLastOpenDir(): vscode.Uri | undefined {
    return this.lastOpenDir ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    SpecViewEditorProvider.lastOpenDir = vscode.Uri.joinPath(document.uri, '..');
    SpecViewEditorProvider.setupWebview(webviewPanel, this.context, async (panel, session) => {
      await SpecViewEditorProvider.sendFiles(panel, session, [document.uri]);
    });
  }

  static async openPanel(
    context: vscode.ExtensionContext,
    files: vscode.Uri[]
  ): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      const session = this.sessions.get(this.panel);
      if (session) await this.sendFiles(this.panel, session, files);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'specview.panel',
      'SpecView',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: this.localResourceRoots(context),
      }
    );
    this.panel = panel;
    this.setupWebview(panel, context, async (readyPanel, session) => {
      await this.sendFiles(readyPanel, session, files);
    });
  }

  private static localResourceRoots(context: vscode.ExtensionContext): vscode.Uri[] {
    return [
      vscode.Uri.joinPath(context.extensionUri, 'dist'),
      vscode.Uri.joinPath(context.extensionUri, 'media'),
      context.globalStorageUri,
      ...(vscode.workspace.workspaceFolders?.map(folder => folder.uri) ?? []),
    ];
  }

  private static setupWebview(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    onReady: (panel: vscode.WebviewPanel, session: PanelSession) => Promise<void>,
  ): void {
    const session = new PanelSession(context.globalStorageUri.fsPath);
    let ready = false;
    this.sessions.set(panel, session);
    panel.webview.options = { enableScripts: true, localResourceRoots: this.localResourceRoots(context) };
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = null;
      this.sessions.delete(panel);
      void session.dispose().catch(error => console.error('[SpecView] Failed to clean session:', error));
    });

    panel.webview.onDidReceiveMessage((msg: unknown) => {
      void this.handleWebviewMessage(panel, session, context, msg, () => {
        const first = !ready;
        ready = true;
        return first;
      }, onReady).catch(error => console.error('[SpecView] Message handling failed:', error));
    });

    panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri);
  }

  private static async handleWebviewMessage(
    panel: vscode.WebviewPanel,
    session: PanelSession,
    context: vscode.ExtensionContext,
    msg: unknown,
    claimFirstReady: () => boolean,
    onReady: (panel: vscode.WebviewPanel, session: PanelSession) => Promise<void>,
  ): Promise<void> {
    const message = msg as Record<string, unknown>;
    if (message.type === 'ready') {
      if (claimFirstReady()) {
        session.ready = true;
        await onReady(panel, session);
        await this.sendFiles(panel, session, Array.from(session.rootUris.values()));
      } else {
        const roots = Array.from(session.rootUris.values());
        await session.resetForReload();
        session.ready = true;
        await this.sendFiles(panel, session, roots);
      }
    } else if (message.type === 'openFile') {
      const generation = session.generation;
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        defaultUri: this.lastOpenDir ?? vscode.workspace.workspaceFolders?.[0]?.uri,
        filters: {
          'Audio & Archives': ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'wma', 'aiff', 'opus', 'tar', 'tar.gz', 'tgz'],
          'JSON metadata': ['json'],
        },
      });
      if (!session.isCurrent(generation)) return;
      if (picked) await this.sendFiles(panel, session, picked);
    } else if (message.type === 'clearLoaded') {
      await session.clear();
    } else if (message.type === 'removeFromLoaded') {
      await this.removeFromSession(session, message);
    } else if (message.type === 'requestFileData') {
      await this.handleFileDataRequest(panel, session, message);
    } else if (message.type === 'requestModel') {
      try {
        const modelUri = await this.ensureModel(context, (status, loaded, total) => {
          void panel.webview.postMessage({ type: 'modelProgress', status, loaded, total });
        });
        void panel.webview.postMessage({ type: 'modelReady', url: panel.webview.asWebviewUri(modelUri).toString() });
      } catch (error) {
        void panel.webview.postMessage({ type: 'modelError', message: String((error as Error).message || error) });
      }
    }
  }

  private static async removeFromSession(session: PanelSession, message: Record<string, unknown>): Promise<void> {
    const identity = typeof message.sourceId === 'string' ? message.sourceId
      : typeof message.uri === 'string' ? message.uri
      : typeof message.filePath === 'string' ? message.filePath : undefined;
    if (!identity) return;
    const source = await session.unregisterSource(identity);
    if (source && source.kind === 'file') {
      session.loadedFiles.delete(source.filePath);
      session.removeRoot(source.filePath);
    } else if (!source) {
      session.loadedFiles.delete(identity);
      session.removeRoot(identity);
    }
  }

  private static async handleFileDataRequest(
    panel: vscode.WebviewPanel,
    session: PanelSession,
    message: Record<string, unknown>,
  ): Promise<void> {
    const request = parseFileDataRequest(message);
    const fallbackRequestId = typeof message.requestId === 'string' ? message.requestId : undefined;
    const respondError = (text: string) => {
      void panel.webview.postMessage({
        type: 'fileDataError', sourceId: request?.sourceId, requestId: request?.requestId ?? fallbackRequestId,
        uri: request?.sourceId, message: text,
      });
    };
    if (!request) return respondError('Invalid file data request');
    const source = session.sources.get(request.sourceId);
    if (!source) return respondError('Unknown or expired source');
    try {
      const data = await this.readSource(source);
      await panel.webview.postMessage({
        type: 'fileDataStart', name: source.name, filePath: request.sourceId,
        sourceId: request.sourceId, requestId: request.requestId, size: data.byteLength,
      });
      for (let offset = 0; offset < data.byteLength; offset += FILE_CHUNK_BYTES) {
        const chunk = data.subarray(offset, Math.min(offset + FILE_CHUNK_BYTES, data.byteLength));
        await panel.webview.postMessage({
          type: 'fileDataChunk', requestId: request.requestId, offset, base64: uint8ToBase64(chunk),
        });
      }
      await panel.webview.postMessage({ type: 'fileDataEnd', requestId: request.requestId });
    } catch (error) {
      respondError(String((error as Error).message || error));
    }
  }

  private static async readSource(source: Source): Promise<Buffer> {
    if (source.kind === 'tar') return readTarRegion(source.filePath, source.entry);
    const data = await readFile(source.filePath);
    if (source.kind === 'file' && data.byteLength !== source.size) throw new Error('Source file size changed');
    return data;
  }

  private static sendFiles(
    panel: vscode.WebviewPanel,
    session: PanelSession,
    uris: vscode.Uri[],
  ): Promise<void> {
    for (const uri of uris) session.rootUris.set(uri.toString(), uri);
    if (!session.ready) return Promise.resolve();
    const generation = session.generation;
    return session.run(async () => {
      if (!session.isCurrent(generation)) return;
      await this.sendFilesNow(panel, session, uris, generation);
    });
  }

  private static async sendFilesNow(
    panel: vscode.WebviewPanel,
    session: PanelSession,
    uris: vscode.Uri[],
    generation: number,
  ): Promise<void> {
    const newUris = uris.filter(uri => !session.loadedFiles.has(uri.fsPath));
    if (newUris.length === 0) return;
    const archiveUris = newUris.filter(uri => isArchive(path.basename(uri.fsPath)));
    const metaUris = newUris.filter(uri => !isArchive(path.basename(uri.fsPath)) && /\.json$/i.test(path.basename(uri.fsPath)));
    const audioUris = newUris.filter(uri => !isArchive(path.basename(uri.fsPath)) && isAudioFile(path.basename(uri.fsPath)));

    // JSON is delivered lazily as descriptors; the webview fetches each one only
    // when it needs it (paired to a loaded track, or as a standalone card).
    const metaSources: ReturnType<typeof lazySourceDescriptor>[] = [];
    for (const uri of metaUris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('Invalid JSON file size');
        const name = path.basename(uri.fsPath);
        const sourceId = session.register({ kind: 'file', name, filePath: uri.fsPath, size: stat.size });
        metaSources.push(lazySourceDescriptor(name, uri.fsPath, sourceId, generation));
        session.loadedFiles.add(uri.fsPath);
      } catch (error) {
        console.error('[SpecView] Failed to register JSON:', uri.fsPath, error);
      }
    }

    for (const archiveUri of archiveUris) {
      let tempDirectory: string | undefined;
      let cachedBytes = 0;
      const sourceIds: string[] = [];
      try {
        const compressed = /\.(tar\.gz|tgz)$/i.test(archiveUri.fsPath);
        if (compressed) {
          // Progressive: register each entry and post its descriptor as soon as
          // it is written, so cards appear while the archive is still extracting.
          tempDirectory = await session.createArchiveDirectory(generation);
          if (!session.isCurrent(generation)) return;
          const lazy: ReturnType<typeof lazySourceDescriptor>[] = [];
          let posted = 0;
          const flushLazy = async (): Promise<void> => {
            while (lazy.length - posted >= MESSAGE_BATCH_SIZE) {
              if (!session.isCurrent(generation)) throw new Error('Session was replaced');
              await panel.webview.postMessage({ type: 'fileURIs', files: lazy.slice(posted, posted + MESSAGE_BATCH_SIZE) });
              posted += MESSAGE_BATCH_SIZE;
            }
          };
          const contents = await extractGzipArchive(
            archiveUri.fsPath,
            tempDirectory,
            session.remainingCacheBytes,
            () => session.isCurrent(generation),
            async (kind, entry, index) => {
              const name = path.posix.basename(entry.name);
              const logicalPath = `${archiveUri.fsPath}\n${entry.name}`;
              const source: Source = {
                kind: 'temp', name,
                filePath: path.join(tempDirectory!, `${index}.${kind}`),
                size: entry.size,
              };
              const sourceId = session.register(source);
              sourceIds.push(sourceId);
              const descriptor = lazySourceDescriptor(name, logicalPath, sourceId, generation);
              if (kind === 'audio') {
                lazy.push(descriptor);
                await flushLazy();
              } else {
                metaSources.push(descriptor);
              }
            }
          );
          if (!session.isCurrent(generation)) return;
          session.addCachedBytes(contents.cachedBytes);
          cachedBytes = contents.cachedBytes;
          await flushLazy();
          const tail = lazy.slice(posted);
          if (tail.length && session.isCurrent(generation)) {
            await panel.webview.postMessage({ type: 'fileURIs', files: tail });
          }
          if (contents.audio.length === 0 && contents.json.length === 0) {
            console.warn('[SpecView] Archive has no supported audio or JSON:', archiveUri.fsPath);
          }
        } else {
          const contents = await indexTarFile(archiveUri.fsPath, () => session.isCurrent(generation));
          if (!session.isCurrent(generation)) return;
          const lazy: ReturnType<typeof lazySourceDescriptor>[] = [];
          for (let index = 0; index < contents.audio.length; index++) {
            const entry = contents.audio[index];
            const name = path.posix.basename(entry.name);
            const logicalPath = `${archiveUri.fsPath}\n${entry.name}`;
            const source: Source = { kind: 'tar', name, filePath: archiveUri.fsPath, entry };
            const sourceId = session.register(source);
            sourceIds.push(sourceId);
            lazy.push(lazySourceDescriptor(name, logicalPath, sourceId, generation));
          }
          if (contents.audio.length === 0 && contents.json.length === 0) {
            console.warn('[SpecView] Archive has no supported audio or JSON:', archiveUri.fsPath);
          }
          for (let index = 0; index < lazy.length; index += MESSAGE_BATCH_SIZE) {
            await panel.webview.postMessage({ type: 'fileURIs', files: lazy.slice(index, index + MESSAGE_BATCH_SIZE) });
          }
          // JSON inside archives is delivered lazily as descriptors.
          for (let index = 0; index < contents.json.length; index++) {
            const entry = contents.json[index];
            const name = path.posix.basename(entry.name);
            const logicalPath = `${archiveUri.fsPath}\n${entry.name}`;
            const source: Source = { kind: 'tar', name, filePath: archiveUri.fsPath, entry };
            const sourceId = session.register(source);
            sourceIds.push(sourceId);
            metaSources.push(lazySourceDescriptor(name, logicalPath, sourceId, generation));
          }
        }
        session.loadedFiles.add(archiveUri.fsPath);
      } catch (error) {
        if (!session.isCurrent(generation)) return;
        for (const sourceId of sourceIds) session.sources.delete(sourceId);
        session.releaseCachedBytes(cachedBytes);
        await session.discardArchiveDirectory(tempDirectory);
        const message = `Failed to load ${path.basename(archiveUri.fsPath)}: ${String((error as Error).message || error)}`;
        console.error('[SpecView] Failed to extract archive:', archiveUri.fsPath, error);
        void vscode.window.showErrorMessage(message);
        void panel.webview.postMessage({ type: 'error', message });
      }
    }

    let eagerBytes = 0;
    const lazyAudio: ReturnType<typeof lazySourceDescriptor>[] = [];
    for (let index = 0; index < audioUris.length; index++) {
      const uri = audioUris[index];
      const name = path.basename(uri.fsPath);
      let size = Number.POSITIVE_INFINITY;
      try { size = (await vscode.workspace.fs.stat(uri)).size; } catch { /* read below reports the error */ }
      if (!Number.isSafeInteger(size) || size < 0) {
        console.error(`[SpecView] Invalid audio file size: ${uri.fsPath}`);
        continue;
      }
      const sourceId = session.register({ kind: 'file', name, filePath: uri.fsPath, size });
      if (index < LAZY_THRESHOLD && size <= EAGER_MAX_BYTES && eagerBytes + size <= EAGER_TOTAL_MAX_BYTES) {
        try {
          const data = await readFile(uri.fsPath);
          if (!session.isCurrent(generation)) return;
          if (data.byteLength !== size) throw new Error('Audio file size changed while loading');
          eagerBytes += data.byteLength;
          session.loadedFiles.add(uri.fsPath);
          await panel.webview.postMessage({ type: 'fileData', name, filePath: uri.fsPath, sourceId, base64: uint8ToBase64(data) });
        } catch (error) {
          session.sources.delete(sourceId);
          console.error('[SpecView] Failed to read audio:', uri.fsPath, error);
        }
      } else {
        session.loadedFiles.add(uri.fsPath);
        lazyAudio.push(lazySourceDescriptor(name, uri.fsPath, sourceId, generation));
      }
    }
    for (let index = 0; index < lazyAudio.length; index += MESSAGE_BATCH_SIZE) {
      await panel.webview.postMessage({ type: 'fileURIs', files: lazyAudio.slice(index, index + MESSAGE_BATCH_SIZE) });
    }
    if (audioUris.length) this.lastOpenDir = vscode.Uri.joinPath(audioUris[audioUris.length - 1], '..');
    if (metaSources.length && session.isCurrent(generation)) {
      for (let index = 0; index < metaSources.length; index += MESSAGE_BATCH_SIZE) {
        await panel.webview.postMessage({ type: 'metaURIs', files: metaSources.slice(index, index + MESSAGE_BATCH_SIZE) });
      }
    }
  }

  /**
   * Ensure the CED-tiny model is cached on disk. Download if needed.
   * Shared across all webviews via static state.
   */
  private static async ensureModel(
    context: vscode.ExtensionContext,
    onProgress?: (status: string, loaded: number, total: number) => void
  ): Promise<vscode.Uri> {
    const modelUri = vscode.Uri.joinPath(context.globalStorageUri, CED_MODEL_FILE);

    try {
      const stat = await vscode.workspace.fs.stat(modelUri);
      if (stat.size > 1000000) {
        return modelUri;
      }
    } catch {
      // Not cached yet
    }

    if (this.modelDownloading) {
      return new Promise<vscode.Uri>((resolve, reject) => {
        this.modelDownloadCallbacks.push({ resolve, reject });
      });
    }

    this.modelDownloading = true;

    try {
      try {
        await vscode.workspace.fs.createDirectory(context.globalStorageUri);
      } catch { /* may already exist */ }

      if (onProgress) onProgress('downloading', 0, 0);

      const data = await this.downloadFromMirrors(
        CED_MIRRORS.map(m => m + CED_MODEL_PATH),
        (loaded, total) => {
          if (onProgress) onProgress('downloading', loaded, total);
        }
      );

      if (onProgress) onProgress('saving', 0, 0);
      await vscode.workspace.fs.writeFile(modelUri, new Uint8Array(data));

      this.modelDownloading = false;
      for (const cb of this.modelDownloadCallbacks) cb.resolve(modelUri);
      this.modelDownloadCallbacks = [];

      return modelUri;
    } catch (e) {
      this.modelDownloading = false;
      const err = e instanceof Error ? e : new Error(String(e));
      for (const cb of this.modelDownloadCallbacks) cb.reject(err);
      this.modelDownloadCallbacks = [];
      throw e;
    }
  }

  private static async downloadFromMirrors(
    urls: string[],
    onProgress: (loaded: number, total: number) => void
  ): Promise<ArrayBuffer> {
    for (const url of urls) {
      try {
        const resp = await fetch(url, { redirect: 'follow' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        if (!resp.body) throw new Error('Empty response body');
        const total = parseInt(resp.headers.get('content-length') || '0', 10);
        const reader = resp.body.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          onProgress(loaded, total || loaded);
        }
        const buf = new Uint8Array(loaded);
        let off = 0;
        for (const ch of chunks) { buf.set(ch, off); off += ch.length; }
        return buf.buffer;
      } catch (e) {
        console.error('[SpecView] Mirror failed:', url, (e as Error).message);
        continue;
      }
    }
    throw new Error('All mirrors failed');
  }
}
