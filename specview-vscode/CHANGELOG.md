# Changelog

## 0.1.0 — Initial Release

### Features

- **Spectrogram visualization** with hot-metal colormap for all common audio formats (WAV, MP3, OGG, FLAC, M4A, AAC, WebM, WMA, AIFF, Opus)
- **Audio playback** with play, pause, stop, seek, and volume control
- **Auto-grouping** by 32 recognized tags for A/B comparison (suffix and prefix modes)
- **Lane switching** with Shift+Space for instant A/B comparison at the same playback position
- **ML audio classification** using CED-tiny ONNX model (527 AudioSet labels)
  - Analyze All (toolbar), Analyze Group (group header), Analyze (per track)
- **Cross-directory support** with relative path display for files from different directories
- **File deduplication** — already loaded files are silently skipped
- **Explorer integration** — right-click context menu "Open with SpecView" for multi-file selection
- **Custom editor** — double-click audio files to open directly in SpecView
- **Keyboard shortcuts** — Space (play/pause), Shift+Space (switch lane), Escape (stop), Arrow keys (seek)
- **VS Code theme integration** — adapts to light and dark themes via CSS variables
