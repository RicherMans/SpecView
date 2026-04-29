# Changelog

## 0.1.3

### Bug Fixes

- Fixed long audio spectrogram truncation — STFT hop auto-adjusts for full duration
- Fixed large/stereo file loading — base64 decoding yields to event loop
- Fixed `activeLoads` counter negative after `clearAll()`
- Fixed group zoom inverted range when sibling is shorter
- Fixed `Analyze` button not enabled after lazy load completes

### Improvements

- Audio files sent one-by-one to avoid massive postMessage payload
- Lazy URIs use `handleFiles` for proper grouping (removed `createLazyCard`)
- Diff group lanes have individual rulers
- Incremental rendering during batch decode

## 0.1.2

### New Features

- **Tar/Tar.gz archive support** — open `.tar`/`.tar.gz`/`.tgz` archives via file dialog or right-click
- **Folder right-click** — "Open folder with SpecView" loads all audio files (top-level, natural sort)
- **Lazy loading** — large file sets (>10) decode on scroll via IntersectionObserver
- **Batched card creation** — 100 cards per batch with "Load More" button
- **Playhead GPU acceleration** — `transform: translateX()` for smoother animation
- **Adaptive hop size** — short files auto-adjust STFT hop to fill canvas

### Improvements

- Concurrency-limited loading (max 3 concurrent) and batch decoding (3 at a time)
- Zombie track protection across async gaps
- Shift-drag listener leak fix (register on mousedown, remove on mouseup)
- Analyze All skips unloaded lazy placeholders
- Serial message queue preserves correct card ordering

### Bug Fixes

- Fixed lazy load timeout (webview URI vs file:// URI mismatch)
- Fixed silent file read failures (now sends error back to webview)
- Fixed tar same-name collision, cache key collision, and deferred extraction issues
- Fixed first file lost when right-click opening multiple selected files
- Fixed `clearAll` not resetting async state (load queue, observer)
- Fixed `lazyUri`/`filePath` lost during diff group rebuilds
- Removed webview drag-drop (VS Code intercepts drops)

## 0.1.1

### New Features

- **Delete key** (`Delete`) to remove the active track or individual lane from a diff group
- **Lane remove button** (×) on each lane in diff groups — click to remove that lane only
  - 2-lane group: remaining lane converts to standalone track
  - 3+ lane group: group rebuilds without the removed lane
- **Card navigation** — Up/Down arrow keys to switch between cards (tracks or groups) with smooth scrolling
- **Card position preservation** — cards stay at their original position when deleting lanes, merging tracks, or adding to groups

### Bug Fixes

- Fixed removed files could not be re-added after deletion (extension host `loadedFiles` now syncs on track removal)
- Fixed waveform not rendering for newly loaded files when waveform toggle is already on
- Fixed Play/Pause button state not updating when clicking a different track's spectrogram during playback
- Fixed auto-pause now uses `visibilitychange` event for reliable detection when switching VS Code panels
- Fixed audio glitch during rapid seek (source identity check in `onended` callback)
- Fixed click-to-seek now preserves playback state (continues playing from new position)

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
- **Time axis zoom** — Ctrl+wheel, Shift+drag box selection, toolbar +/–/Fit buttons, Shift+Arrow keyboard shortcuts
  - STFT cached for instant zoom/scroll; group tracks zoom in sync
- **Time-domain waveform display** — toggle via toolbar checkbox; amplitude labels (1.0, 0, -1.0); time-aligned with spectrogram; synced playhead
- **Same-name different-directory grouping** — files with same name from different dirs auto-grouped with parent folder name as tag
- **Auto-pause on visibility loss** — playback pauses when switching to another VS Code panel or tab
- **Analysis strip visualization** — colored tags below spectrogram showing detected sound categories, time ranges, and confidence levels
- **Multi-mirror model download** — ML model downloads from multiple mirrors (HuggingFace, HF Mirror) for reliability
- **Keyboard shortcuts** — Space (play/pause), Shift+Space (switch lane), Escape (stop), Arrow keys (seek), Shift+Arrows (zoom)
- **VS Code theme integration** — adapts to light and dark themes via CSS variables
