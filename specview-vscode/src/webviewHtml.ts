import * as vscode from 'vscode';

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js')
  );
  const nonce = getNonce();
  const cspSource = webview.cspSource;

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://registry.npmmirror.com; style-src 'unsafe-inline'; font-src data:; img-src data: blob: ${cspSource}; connect-src ${cspSource} https://cdn.jsdelivr.net https://registry.npmmirror.com data: blob:; worker-src blob:; child-src blob:;">
<title>SpecView</title>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js"></script>
</head>
<body>
<div class="toolbar">
  <span class="logo">SpecView</span>
  <div class="sep"></div>
  <button class="btn primary" id="btn-play" disabled>
    <span class="btn-icon" id="play-icon">&#9654;</span><span id="play-label">Play</span>
  </button>
  <button class="btn" id="btn-stop" disabled>
    <span class="btn-icon">&#9632;</span> Stop
  </button>
  <div class="sep"></div>
  <span class="time-display" id="time-display">0:00.000 / 0:00.000</span>
  <span class="spacer"></span>
  <div class="vol-group">
    <label>Vol</label>
    <input type="range" class="vol-slider" id="vol-slider" min="0" max="100" value="80">
  </div>
  <div class="sep"></div>
  <button class="btn" id="btn-analyze-all" disabled>Analyze All</button>
  <div class="sep"></div>
  <button class="btn" id="btn-clear">Clear All</button>
</div>

<div id="drop-zone" class="empty">
  <div class="dz-icon">&#127925;</div>
  <div class="dz-text">Click to add audio files</div>
  <div class="dz-sub">Supports MP3, WAV, OGG, FLAC, M4A &mdash; matching suffixes auto-grouped for diff</div>
</div>

<div id="tracks-container"></div>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
