export const STYLES = `
:root {
  --bg: var(--vscode-editor-background, #f0f0f0);
  --bg-toolbar: var(--vscode-sideBar-background, #e8e8e8);
  --bg-card: var(--vscode-editor-background, #ffffff);
  --bg-header: var(--vscode-titleBar-activeBackground, #f5f5f5);
  --bg-spec: #000000;
  --text: var(--vscode-editor-foreground, #2c2c2c);
  --text-dim: var(--vscode-descriptionForeground, #777);
  --text-sub: var(--vscode-disabledForeground, #999);
  --accent: var(--vscode-focusBorder, #3b82f6);
  --accent-light: var(--vscode-focusBorder, #60a5fa);
  --accent-glow: rgba(59,130,246,0.25);
  --accent-hover: var(--vscode-button-hoverBackground, #2563eb);
  --red: var(--vscode-errorForeground, #ef4444);
  --green: #22c55e;
  --orange: #f59e0b;
  --border: var(--vscode-panel-border, #d4d4d4);
  --border-light: var(--vscode-editorWidget-border, #e5e5e5);
  --playhead: #ff3333;
  --playhead-glow: rgba(255,51,51,0.5);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
  background: var(--bg);
  color: var(--text);
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
}

.toolbar {
  display: flex;
  align-items: center;
  padding: 5px 12px;
  background: var(--bg-toolbar);
  border-bottom: 1px solid var(--border);
  gap: 6px;
  flex-shrink: 0;
  z-index: 100;
}
.toolbar .logo {
  font-size: 15px;
  font-weight: 800;
  color: var(--accent);
  margin-right: 8px;
  letter-spacing: 0.5px;
}
.toolbar .sep {
  width: 1px; height: 20px; background: var(--border); margin: 0 4px;
}
.btn {
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: all .12s ease;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.btn:hover { background: var(--vscode-button-hoverBackground, #e9e9e9); border-color: #bbb; }
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.35; pointer-events: none; }
.btn.primary { background: var(--vscode-button-background, var(--accent)); color: var(--vscode-button-foreground, #fff); border-color: var(--accent); font-weight: 600; }
.btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn-icon { font-size: 12px; }
.spacer { flex: 1; }

.time-display {
  font-family: var(--vscode-editor-font-family, 'SF Mono', 'Cascadia Code', 'Consolas', monospace);
  font-size: 12px;
  color: var(--text);
  background: var(--bg-card);
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid var(--border);
  min-width: 175px;
  text-align: center;
  letter-spacing: 0.3px;
}

.vol-group { display: flex; align-items: center; gap: 5px; }
.vol-group label { font-size: 11px; color: var(--text-dim); }
.vol-slider {
  -webkit-appearance: none; appearance: none;
  width: 65px; height: 3px; background: var(--border); border-radius: 2px; outline: none;
}
.vol-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 11px; height: 11px;
  border-radius: 50%; background: var(--accent); cursor: pointer;
}

#drop-zone {
  margin: 8px 10px;
  border: 2px dashed var(--border);
  border-radius: 8px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  transition: all 0.2s ease; cursor: pointer; flex-shrink: 0;
  background: var(--bg-card);
}
#drop-zone.empty { height: 180px; }
#drop-zone.compact { height: 38px; flex-direction: row; margin: 5px 10px; gap: 8px; }
#drop-zone .dz-icon { font-size: 36px; color: var(--text-dim); }
#drop-zone.compact .dz-icon { font-size: 16px; }
#drop-zone .dz-text { font-size: 13px; color: var(--text-dim); margin-top: 5px; }
#drop-zone.compact .dz-text { margin-top: 0; font-size: 11px; }
#drop-zone .dz-sub { font-size: 10px; color: var(--text-sub); margin-top: 3px; }
#drop-zone.compact .dz-sub { display: none; }
#drop-zone:hover { border-color: var(--accent); background: var(--accent-glow); }

#tracks-container { flex: 1; overflow-y: auto; padding: 0 10px 10px; }

.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 8px;
  overflow: hidden;
  transition: border-color .15s, box-shadow .15s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-glow), 0 1px 4px rgba(0,0,0,0.08);
}
.card-header {
  display: flex; align-items: center; padding: 5px 10px;
  background: var(--bg-header); border-bottom: 1px solid var(--border-light);
  gap: 8px; cursor: pointer; transition: background .12s;
}
.card-header:hover { background: var(--vscode-list-hoverBackground, #eaeaea); }
.card-title {
  font-size: 12px; font-weight: 600; flex: 1; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.card-info {
  font-size: 10px; color: var(--text-dim);
  font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
}
.card-remove {
  background: none; border: none; color: var(--text-sub);
  font-size: 16px; cursor: pointer; padding: 0 3px; line-height: 1; transition: color .12s;
}
.card-remove:hover { color: var(--red); }

.diff-badge {
  font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 3px; letter-spacing: 0.3px;
  background: rgba(59,130,246,0.1); color: var(--accent); border: 1px solid rgba(59,130,246,0.25);
}

.diff-columns { display: flex; flex-direction: row; }
.diff-lane {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
  border-right: 1px solid var(--border-light);
}
.diff-lane:last-child { border-right: none; }

.diff-lane-label {
  display: flex; align-items: center; padding: 2px 8px;
  background: var(--bg-header); gap: 5px; font-size: 10px;
  border-bottom: 1px solid var(--border-light);
  cursor: pointer; transition: background .12s;
}
.diff-lane-label:hover { background: var(--vscode-list-hoverBackground, #f0f0f0); }
.diff-lane-label.selected { background: rgba(59,130,246,0.08); }
.diff-lane-tag {
  font-size: 8px; font-weight: 700; padding: 1px 5px; border-radius: 3px;
  text-transform: uppercase; letter-spacing: 0.4px;
}
.diff-lane-name {
  color: var(--text-dim); font-size: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.diff-lane-playing {
  font-size: 8px; color: var(--accent); margin-left: auto;
  font-family: var(--vscode-editor-font-family, 'Consolas', monospace); font-weight: 600;
}

.track-body { display: flex; background: #000; flex: 1; min-height: 0; }
.freq-labels {
  width: 44px; position: relative; flex-shrink: 0;
  background: #1a1a1a; border-right: 1px solid #333;
  overflow: hidden;
}
.freq-label {
  position: absolute; right: 4px; font-size: 8px; color: #999;
  font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
  transform: translateY(-50%); white-space: nowrap; pointer-events: none;
  line-height: 1;
}
.freq-tick {
  position: absolute; right: 0; width: 5px; height: 1px;
  background: #444; pointer-events: none;
}
.spec-wrapper {
  position: relative; flex: 1; overflow: hidden; cursor: crosshair;
}
.spec-wrapper canvas { display: block; width: 100%; }
.playhead {
  position: absolute; top: 0; width: 2px; height: 100%;
  background: var(--playhead); pointer-events: none; z-index: 10;
  box-shadow: 0 0 6px var(--playhead-glow);
}

.time-ruler {
  display: flex; padding: 2px 0 2px 44px;
  background: var(--bg-header); border-top: 1px solid var(--border-light); overflow: hidden;
}
.time-mark {
  font-size: 9px; color: var(--text-dim);
  font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
  flex-shrink: 0; text-align: left; padding-left: 2px;
}

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: #c0c0c0; border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: #aaa; }

.loading-overlay {
  position: absolute; inset: 0; background: rgba(0,0,0,0.8);
  display: flex; align-items: center; justify-content: center;
  z-index: 20; font-size: 12px; color: #aaa; gap: 8px;
}
.spinner {
  width: 14px; height: 14px; border: 2px solid #444;
  border-top-color: var(--accent-light); border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.tag-a { background: rgba(59,130,246,0.15); color: var(--accent); }
.tag-b { background: rgba(239,68,68,0.12); color: var(--red); }
.tag-c { background: rgba(34,197,94,0.12); color: var(--green); }
.tag-d { background: rgba(245,158,11,0.12); color: var(--orange); }

.analysis-strip {
  position: relative;
  min-height: 18px;
  background: #111;
  border-top: 1px solid #333;
  overflow: hidden;
  font-size: 0;
}
.analysis-strip.empty { display: none; }
.analysis-row {
  display: flex; position: relative; height: 16px;
}
.analysis-tag {
  position: absolute; height: 14px; top: 1px;
  border-radius: 2px; font-size: 8px; font-weight: 600;
  line-height: 14px; padding: 0 3px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
  cursor: default; transition: opacity .15s;
  border: 1px solid rgba(255,255,255,0.15);
}
.analysis-tag:hover { opacity: 0.8; }
.analysis-progress {
  font-size: 10px; color: #aaa; padding: 3px 8px;
  font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
}
.btn-analyze {
  font-size: 10px; padding: 2px 8px; margin-left: 4px;
  background: #2a2a3a; color: #a5b4fc; border: 1px solid #444;
  border-radius: 3px; cursor: pointer; font-family: inherit;
  transition: all .12s;
}
.btn-analyze:hover { background: #3a3a5a; border-color: #666; }
.btn-analyze:disabled { opacity: 0.4; cursor: default; }
.btn-analyze-group {
  font-size: 10px; padding: 2px 8px; margin-left: 4px;
  background: #2a2a3a; color: #a5b4fc; border: 1px solid #444;
  border-radius: 3px; cursor: pointer; font-family: inherit;
  transition: all .12s;
}
.btn-analyze-group:hover { background: #3a3a5a; border-color: #666; }
.btn-analyze-group:disabled { opacity: 0.4; cursor: default; }

`;
