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
  <button class="btn" id="btn-zoom-in" disabled title="Zoom In (Shift+Up)">+</button>
  <button class="btn" id="btn-zoom-out" disabled title="Zoom Out (Shift+Down)">&#8211;</button>
  <button class="btn" id="btn-zoom-fit" disabled title="Fit All (Shift+Left)">Fit</button>
  <div class="sep"></div>
  <button class="btn" id="btn-analyze-all" disabled>Analyze All</button>
  <div class="sep"></div>
  <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;white-space:nowrap">
    <input type="checkbox" id="chk-waveform"> Waveform
  </label>
  <div class="sep"></div>
  <button class="btn" id="btn-clear">Clear All</button>
</div>

<div id="drop-zone" class="empty">
  <div class="dz-icon">&#127925;</div>
  <div class="dz-text">Drop audio files or .tar/.tar.gz archives here, or click to browse</div>
  <div class="dz-sub">Supports MP3, WAV, OGG, FLAC, M4A &amp; .tar/.tar.gz archives &mdash; or right-click folders in Explorer</div>
</div>

<div id="tracks-container"></div>
<div class="drop-overlay" id="drop-overlay"><span class="drop-overlay-text">Drop audio files or archives anywhere</span></div>

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
