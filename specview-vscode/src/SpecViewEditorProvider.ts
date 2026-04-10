import * as vscode from 'vscode';
import * as path from 'path';
import * as zlib from 'zlib';
import { getWebviewHtml } from './webviewHtml';

const ARCHIVE_EXT = /\.(tar|tar\.gz|tgz)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a|aac|webm|wma|aiff|opus)$/i;

interface TarEntry {
  name: string;
  offset: number;
  size: number;
}

interface TarCache {
  buffer: Buffer;
  entries: TarEntry[];
}

function isArchive(name: string): boolean {
  return ARCHIVE_EXT.test(name);
}

function isAudioFile(name: string): boolean {
  return AUDIO_EXT.test(name);
}

function uint8ToBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

/**
 * Decompress if needed and parse tar headers to build an index of audio file entries.
 * Does NOT extract file data — only records offset/size for on-demand extraction.
 */
async function parseTarIndex(archiveData: Uint8Array, archiveName: string): Promise<TarCache> {
  let tarBuffer: Buffer;
  if (/\.tar\.gz$/i.test(archiveName) || /\.tgz$/i.test(archiveName)) {
    tarBuffer = await new Promise<Buffer>((resolve, reject) => {
      zlib.gunzip(Buffer.from(archiveData), (err, result) => {
        if (err) reject(new Error(`Failed to decompress ${archiveName}: ${err.message}`));
        else resolve(result);
      });
    });
  } else {
    tarBuffer = Buffer.from(archiveData);
  }

  const entries: TarEntry[] = [];
  let pos = 0;
  while (pos + 512 <= tarBuffer.length) {
    if (tarBuffer[pos] === 0) break;
    const fileName = tarBuffer.toString('utf8', pos, pos + 100).replace(/\0/g, '');
    if (!fileName) break;
    const sizeStr = tarBuffer.toString('utf8', pos + 124, pos + 136).replace(/\0/g, '').trim();
    const fileSize = parseInt(sizeStr, 8) || 0;
    const typeFlag = tarBuffer[pos + 156];
    const baseName = fileName.split('/').pop() || fileName;
    if (typeFlag !== 0x35 && typeFlag !== 53 && fileSize > 0 && isAudioFile(baseName)) {
      // Store full tar-internal path for unique matching; UI will use basename
      entries.push({ name: fileName, offset: pos + 512, size: fileSize });
    }
    pos += 512 + Math.ceil(fileSize / 512) * 512;
  }
  return { buffer: tarBuffer, entries };
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
  private static loadedFiles = new Set<string>();
  private static tarCache = new Map<string, TarCache>();  // key: "archiveName" → cached tar index
  private static modelDownloading = false;
  private static modelDownloadCallbacks: { resolve: (uri: vscode.Uri) => void; reject: (e: Error) => void }[] = [];
  private static readonly LAZY_THRESHOLD = 10; // files above this count trigger lazy loading

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
    SpecViewEditorProvider.setupWebview(webviewPanel, this.context, async (panel) => {
      await SpecViewEditorProvider.sendFiles(panel, [document.uri], this.context);
    });
  }

  static async openPanel(
    context: vscode.ExtensionContext,
    files: vscode.Uri[]
  ): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.sendFiles(this.panel, files, context);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'specview.panel',
      'SpecView',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist'),
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          context.globalStorageUri,
          ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? []),
        ],
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = null;
      this.loadedFiles.clear();
      this.tarCache.clear();
    });
    this.setupWebview(this.panel, context, async (panel) => {
      await this.sendFiles(panel, files, context);
    });
  }

  private static setupWebview(
    webviewPanel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    onReady: (panel: vscode.WebviewPanel) => Promise<void>
  ): void {
    this.loadedFiles.clear();

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist'),
        vscode.Uri.joinPath(context.extensionUri, 'media'),
        context.globalStorageUri,
        ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? []),
      ],
    };

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        await onReady(webviewPanel);
      } else if (msg.type === 'openFile') {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          defaultUri: this.lastOpenDir ?? vscode.workspace.workspaceFolders?.[0]?.uri,
          filters: {
            'Audio & Archives': ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'wma', 'aiff', 'opus', 'tar', 'tar.gz', 'tgz'],
          },
        });
        if (picked) {
          await this.sendFiles(webviewPanel, picked, context);
        }
      } else if (msg.type === 'clearLoaded') {
        this.loadedFiles.clear();
        this.tarCache.clear();
      } else if (msg.type === 'removeFromLoaded') {
        if (msg.filePath) {
          this.loadedFiles.delete(msg.filePath);
        }
        if (msg.uri) {
          try { this.loadedFiles.delete(vscode.Uri.parse(msg.uri).fsPath); } catch { /* ignore */ }
        }
      } else if (msg.type === 'requestFileData') {
        // Lazy loading: webview requests decoded audio data for a specific file
        const uriStr: string = msg.uri;
        // Check if this is a tar-internal key (format: "tar:archiveName/fileName")
        if (uriStr.startsWith('tar:')) {
          const slashIdx = uriStr.indexOf('/', 4);
          const archiveName = uriStr.substring(4, slashIdx);
          const fileName = uriStr.substring(slashIdx + 1);
          const cached = this.tarCache.get(archiveName);
          if (cached) {
            const entry = cached.entries.find(e => e.name === fileName);
            if (entry) {
              const data = new Uint8Array(cached.buffer.subarray(entry.offset, entry.offset + entry.size));
              webviewPanel.webview.postMessage({
                type: 'fileData',
                name: (entry.name.split('/').pop() || entry.name),
                filePath: uriStr,
                base64: uint8ToBase64(data),
              });
            } else {
              webviewPanel.webview.postMessage({
                type: 'fileDataError', uri: uriStr,
                message: 'Entry not found in archive: ' + fileName,
              });
            }
          } else {
            webviewPanel.webview.postMessage({
              type: 'fileDataError', uri: uriStr,
              message: 'Archive cache expired: ' + archiveName,
            });
          }
        } else {
          // Regular file URI
          const fileUri = vscode.Uri.parse(uriStr);
          try {
            const data = await vscode.workspace.fs.readFile(fileUri);
            webviewPanel.webview.postMessage({
              type: 'fileData',
              name: path.basename(fileUri.fsPath),
              filePath: uriStr,
              base64: Buffer.from(data).toString('base64'),
            });
          } catch (e) {
            console.error('Failed to read file:', fileUri.fsPath, e);
            webviewPanel.webview.postMessage({
              type: 'fileDataError', uri: uriStr,
              message: String((e as Error).message || e),
            });
          }
        }
      } else if (msg.type === 'requestModel') {
        try {
          const modelUri = await this.ensureModel(context, (status, loaded, total) => {
            webviewPanel.webview.postMessage({ type: 'modelProgress', status, loaded, total });
          });
          const webviewModelUri = webviewPanel.webview.asWebviewUri(modelUri);
          webviewPanel.webview.postMessage({ type: 'modelReady', url: webviewModelUri.toString() });
        } catch (e) {
          webviewPanel.webview.postMessage({
            type: 'modelError',
            message: String((e as Error).message || e),
          });
        }
      }
    });

    webviewPanel.webview.html = getWebviewHtml(
      webviewPanel.webview,
      context.extensionUri
    );
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

    // Check disk cache
    try {
      const stat = await vscode.workspace.fs.stat(modelUri);
      if (stat.size > 1000000) {
        return modelUri;
      }
    } catch {
      // Not cached yet
    }

    // If another download is in progress, wait for it
    if (this.modelDownloading) {
      return new Promise<vscode.Uri>((resolve, reject) => {
        this.modelDownloadCallbacks.push({ resolve, reject });
      });
    }

    this.modelDownloading = true;

    try {
      // Ensure storage directory exists
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

  /**
   * Download from the first mirror that responds, with progress reporting.
   * Uses native fetch() which auto-follows redirects and handles HTTPS.
   */
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

  private static async sendFiles(
    webviewPanel: vscode.WebviewPanel,
    uris: vscode.Uri[],
    _context: vscode.ExtensionContext
  ): Promise<void> {
    const newUris = uris.filter(uri => !this.loadedFiles.has(uri.fsPath));
    if (newUris.length === 0) return;

    const archiveUris = newUris.filter(uri => isArchive(path.basename(uri.fsPath)));
    const audioUris = newUris.filter(uri => !isArchive(path.basename(uri.fsPath)));

    // Extract audio files from archives (lazy loading for large archives)
    for (const archiveUri of archiveUris) {
      try {
        const data = await vscode.workspace.fs.readFile(archiveUri);
        const archiveName = path.basename(archiveUri.fsPath);
        const cacheKey = archiveUri.fsPath;
        const { buffer, entries } = await parseTarIndex(new Uint8Array(data), archiveName);
        this.tarCache.set(cacheKey, { buffer, entries });
        this.loadedFiles.add(archiveUri.fsPath);

        const displayName = (n: string) => n.split('/').pop() || n;

        if (entries.length <= this.LAZY_THRESHOLD) {
          // Small archive: extract all at once
          const files = entries.map(e => ({
            name: displayName(e.name),
            filePath: 'tar:' + cacheKey + '/' + e.name,
            base64: uint8ToBase64(new Uint8Array(buffer.subarray(e.offset, e.offset + e.size))),
          }));
          webviewPanel.webview.postMessage({ type: 'archiveFiles', files });
        } else {
          // Large archive: send first batch decoded, rest as tar-internal keys
          const firstBatch = entries.slice(0, this.LAZY_THRESHOLD);
          const remaining = entries.slice(this.LAZY_THRESHOLD);
          const files = firstBatch.map(e => ({
            name: displayName(e.name),
            filePath: 'tar:' + cacheKey + '/' + e.name,
            base64: uint8ToBase64(new Uint8Array(buffer.subarray(e.offset, e.offset + e.size))),
          }));
          webviewPanel.webview.postMessage({ type: 'archiveFiles', files });
          if (remaining.length > 0) {
            const tarUris = remaining.map(e => ({
              name: displayName(e.name),
              uri: 'tar:' + cacheKey + '/' + e.name,
            }));
            webviewPanel.webview.postMessage({ type: 'fileURIs', files: tarUris });
          }
        }
      } catch (e) {
        console.error('Failed to extract archive:', archiveUri.fsPath, e);
      }
    }

    if (audioUris.length === 0) return;

    for (const uri of audioUris) this.loadedFiles.add(uri.fsPath);
    this.lastOpenDir = vscode.Uri.joinPath(audioUris[audioUris.length - 1], '..');

    // Lazy loading: if more than threshold, send first batch decoded + rest as URIs
    if (audioUris.length > this.LAZY_THRESHOLD) {
      const firstBatch = audioUris.slice(0, this.LAZY_THRESHOLD);
      const remainingUris = audioUris.slice(this.LAZY_THRESHOLD);

      // Send first batch decoded
      const firstFiles = await this.readAudioFiles(firstBatch);
      if (firstFiles.length === 1) {
        webviewPanel.webview.postMessage({ type: 'fileData', ...firstFiles[0] });
      } else if (firstFiles.length > 1) {
        webviewPanel.webview.postMessage({ type: 'filesData', files: firstFiles });
      }

      // Send remaining as original file URIs for on-demand loading
      // NOTE: we send the original file:// URI (not webview URI) because
      // the extension host needs to readFile() with it when the webview requests data.
      if (remainingUris.length > 0) {
        const fileUris = remainingUris.map(uri => ({
          name: path.basename(uri.fsPath),
          uri: uri.toString(),
        }));
        webviewPanel.webview.postMessage({ type: 'fileURIs', files: fileUris });
      }
    } else {
      // Small batch: send all decoded at once
      const files = await this.readAudioFiles(audioUris);
      if (files.length === 1) {
        webviewPanel.webview.postMessage({ type: 'fileData', ...files[0] });
      } else if (files.length > 1) {
        webviewPanel.webview.postMessage({ type: 'filesData', files });
      }
    }
  }

  private static async readAudioFiles(uris: vscode.Uri[]): Promise<{ name: string; filePath: string; base64: string }[]> {
    const filePromises = uris.map(async (uri) => {
      try {
        const data = await vscode.workspace.fs.readFile(uri);
        return {
          name: path.basename(uri.fsPath),
          filePath: uri.fsPath,
          base64: Buffer.from(data).toString('base64'),
        };
      } catch (e) {
        console.error('Failed to read file:', uri.fsPath, e);
        return null;
      }
    });
    return (await Promise.all(filePromises)).filter(Boolean) as { name: string; filePath: string; base64: string }[];
  }
}
