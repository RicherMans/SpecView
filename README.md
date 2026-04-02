# SpecView

Audio spectrogram visualizer with playback, auto-grouping for A/B comparison, and ML-powered audio classification.

Forked from [RicherMans/SpecView](https://github.com/RicherMans/SpecView), with added [VS Code extension](#vs-code-extension). The web version and VS Code extension share the same feature set.

**Live Demo**: https://richermans.github.io/SpecView/ | https://xingws.github.io/SpecView/

**VS Code Extension**: [Install from Marketplace](https://marketplace.visualstudio.com/items?itemName=sunxingwei.specview)

## Features

- **Spectrogram Visualization** — hot-metal colormap, frequency labels, time ruler
- **Audio Playback** — play, pause, stop, seek, volume; click spectrogram to seek (preserves playback state)
- **Auto-Grouping** — 32 recognized tags for A/B comparison with `_` or `-` separators (suffix and prefix modes)
- **Time Axis Zoom** — Ctrl+wheel zoom, Shift+drag box selection, toolbar +/–/Fit buttons; STFT cached for instant redraw; group tracks zoom in sync
- **Time-Domain Waveform** — toggle via toolbar Waveform checkbox; amplitude labels (-1.0, 0, 1.0); time-aligned with spectrogram
- **ML Audio Classification** — CED-tiny ONNX model (527 AudioSet labels); Analyze All / Analyze Group / per-track buttons; colored analysis strip below spectrogram
- **Track Management** — Delete key to remove active track; per-lane × button in diff groups; card position preserved on deletion/merge
- **Card Navigation** — Up/Down arrow keys to switch between tracks with smooth scrolling
- **Auto-Pause** — playback pauses when browser tab or VS Code panel loses focus

Supported formats: **WAV, MP3, OGG, FLAC, M4A, AAC, WebM, WMA, AIFF, Opus**.

## Usage (Web)

Try the live demo at https://richermans.github.io/SpecView/ or https://xingws.github.io/SpecView/, or run locally:

1. Open `index.html` in a browser
2. Drag & drop audio files or click to browse
3. Click spectrogram to seek; Ctrl+wheel to zoom
4. Use toolbar for playback, zoom, waveform, and analysis controls

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `Shift + Space` | Switch lane in diff group (A/B comparison) |
| `Escape` | Stop playback and reset position |
| `←` / `→` | Seek backward / forward 2 seconds |
| `↑` / `↓` | Switch to previous / next card (track or group) |
| `Shift + ↑` | Zoom in (time axis) |
| `Shift + ↓` | Zoom out (time axis) |
| `Shift + ←` | Reset zoom (fit all) |
| `Delete` | Remove active track (or remove lane from group) |

## VS Code Extension

SpecView is also available as a **VS Code extension** with additional features beyond the web version.

### Install

**From VS Code Marketplace** (recommended):

Search "SpecView" in the Extensions panel, or install directly:

```
ext install sunxingwei.specview
```

Or visit: https://marketplace.visualstudio.com/items?itemName=sunxingwei.specview

**From VSIX (local install):**

```bash
cd specview-vscode
npm install && node esbuild.mjs
npx @vscode/vsce package
code --install-extension specview-0.1.1.vsix
```

### Additional Extension Features

Beyond all web version features, the VS Code extension adds:

- **Custom editor** — double-click audio files to open directly in SpecView
- **Explorer integration** — right-click multiple audio files → "Open with SpecView" → opens in one panel
- **ONNX model disk caching** — model downloaded once, cached across sessions (no re-download on restart)
- **Same-name different-directory grouping** — files with same name from different directories auto-grouped with parent folder name as tag
- **File deduplication** — already loaded files are silently skipped; removed files can be re-added
- **VS Code theme integration** — adapts to light and dark themes via CSS variables

### Development

```bash
cd specview-vscode
npm install
code .
# Press F5 to launch Extension Development Host
```

### Documentation

- [English Documentation](specview-vscode/README.md)
- [中文文档](specview-vscode/README.zh-CN.md)

## License

[Apache-2.0](LICENSE)

## Credits

- Audio classification powered by [CED-tiny](https://huggingface.co/mispeech/ced-tiny) (ONNX Runtime Web)

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.
