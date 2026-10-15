# Changelog

## 0.2.2

### Bug Fixes

- Fixed lazy-loaded multichannel archive tracks failing with an `insertBefore` DOM error when the card body is rebuilt into per-channel lanes.
- Fixed Clear All allowing queued messages and in-flight lazy loads to repopulate the view afterwards.
- Fixed the virtual window desynchronizing after multichannel group splitting, lane deletion and regrouping.
- Fixed paired JSON metadata going missing after scrolling a large archive/folder away and back (stable stem key across recycle/restore, and re-fetching for already-loaded cards).
- Fixed JSON field paths so keys containing `.` or markup characters no longer break field selection or inject HTML.

### Improvements

- `.tar` archives are indexed by reading only 512-byte headers (no whole-file load), so multi-gigabyte archives open without exhausting memory; entries are read on demand.
- `.tar.gz`/`.tgz` archives stream-decompress to a per-panel temp directory with expansion, path, cache and disk-space limits.
- Added a per-panel session with opaque source IDs; the webview can no longer request arbitrary files or URIs.
- Archive audio loads lazily through a single-task, viewport-scoped queue with a bounded card window; lazy entries are sent in batches so large folders stay responsive.
- JSON metadata is now lazy: a `.json` is fetched only after its same-stem audio has loaded; `.json` files with no matching audio are fetched once audio loading settles and shown as standalone cards.
- Volume slider now uses a square curve reaching +12 dB at full scale (default unity), so quiet material can be boosted.

## 0.2.1

### Bug Fixes

- Fixed the **fields** browser being empty when a `.json` is opened on its own (no audio). Field discovery now reads every loaded JSON, and standalone JSON cards re-render when a field is selected.
- Fixed a `.json` appearing as a duplicate standalone card alongside its paired track when a wav and its same-stem json are opened together. Standalone cards are now reconciled against the loaded tracks, and metadata is sent after the audio.
- Fixed the spectrogram not re-scaling when the JSON toggle is switched on/off (the canvas reflow is now deferred a frame so it reads the post-toggle width).
- Paired JSON panels and standalone JSON cards are now height-capped to their audio card and scroll internally instead of growing the card.

### Improvements

- The **fields** popup is now a hierarchical tree: parent nodes are tri-state checkboxes that select/clear all their descendants, an **All fields** row selects everything, nodes can be collapsed, and the search filters branches.

## 0.2.0

### New Features

- **Windowed / virtualized lazy loading** — large file sets are no longer gated behind "Load more" clicks. Only a bounded window of cards is rendered; a scroll sentinel reveals more as you scroll (infinite scroll), cards that scroll far off-screen are recycled, and scrolling back up restores them. DOM stays small even with thousands of files.
- **Fast PCM WAV decoding** — plain `.wav` files are decoded with a native-rate RIFF/PCM path instead of `decodeAudioData`, making webdataset-style archives decode much faster (and preserves the source sample rate).
- **Paired JSON metadata panel** — a `.json` file next to an audio file (same stem) is matched up and shown in a metadata panel to the right of each track card and diff group. Click any JSON key to add it to a multi-field comparison across all loaded files; the **fields** pill opens a searchable field browser. The panel width is adjustable via a drag handle.
- **Standalone JSON cards** — `.json` files with no matching audio are rendered as their own cards (full JSON view with the same field-selection behavior). They participate in removal / Clear All and are hidden while the JSON toggle is off.
- **JSON & Grouping toolbar toggles** — a **JSON** checkbox shows/hides all metadata panels (and standalone JSON cards); a **Grouping** button turns automatic A/B diff grouping on/off.
- **Multichannel per-channel display** — stereo and multichannel files (2–8 channels) are expanded into one lane per channel, each with its own waveform, spectrogram, and a **Mute** button. Playback mixes all channels by default and supports muting any combination of channels.
- **Absolute full-scale normalization** — the spectrogram scale top is clamped to full scale (`20*log10(FFT_SIZE/4)` dB) instead of normalizing each file to its own peak, so quiet / near-silent files stay dark instead of having their noise floor stretched to full brightness.

### Bug Fixes

- Fixed frequency-axis (y-axis) labels missing on lacy-loaded playback cards. Frequency ticks are now populated once the real sample rate is known, scoped to the track's own lanes so diff-group siblings are not crossed.
- Fixed the spectrogram canvas not re-scaling after the JSON panel is toggled open/closed or dragged wider/narrower. Canvas backing widths are now re-synced and redrawn (from the cached STFT) on those layout changes.

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
