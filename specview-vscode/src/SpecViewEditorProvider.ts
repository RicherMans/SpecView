import * as vscode from 'vscode';
import * as path from 'path';
import { getWebviewHtml } from './webviewHtml';

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
        ],
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = null;
      this.loadedFiles.clear();
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
            Audio: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'wma', 'aiff', 'opus'],
          },
        });
        if (picked) {
          await this.sendFiles(webviewPanel, picked, context);
        }
      } else if (msg.type === 'clearLoaded') {
        this.loadedFiles.clear();
      } else if (msg.type === 'removeFromLoaded') {
        if (msg.filePath) {
          this.loadedFiles.delete(msg.filePath);
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

    const filePromises = newUris.map(async (uri) => {
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

    const files = (await Promise.all(filePromises)).filter(Boolean);
    if (files.length === 0) return;

    for (const uri of newUris) this.loadedFiles.add(uri.fsPath);
    this.lastOpenDir = vscode.Uri.joinPath(newUris[newUris.length - 1], '..');

    if (files.length === 1) {
      webviewPanel.webview.postMessage({ type: 'fileData', ...files[0] });
    } else {
      webviewPanel.webview.postMessage({ type: 'filesData', files });
    }
  }
}
