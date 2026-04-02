[中文文档](https://github.com/RicherMans/SpecView/blob/main/specview-vscode/README.zh-CN.md)

# SpecView - Audio Spectrogram Viewer for VS Code

A VS Code extension for viewing audio spectrograms with playback, auto-grouping for A/B comparison, and ML-powered audio classification.

Based on [SpecView](https://github.com/RicherMans/SpecView) by Heinrich.

## Features

### Spectrogram Visualization

Open any audio file to see its spectrogram rendered with a hot-metal colormap. Frequency labels and time rulers are displayed alongside the spectrogram for easy reference.

Supported formats: **WAV, MP3, OGG, FLAC, M4A, AAC, WebM, WMA, AIFF, Opus**.

### Audio Playback

- **Play / Pause / Stop** controls in the toolbar
- **Click on spectrogram** to seek to any position (preserves playback state)
- **Volume control** slider
- Real-time playhead tracking with time display
- **Auto-pause**: Playback automatically pauses when you switch to another VS Code panel or tab

### Time-Domain Waveform Display

Toggle the waveform view via the **Waveform** checkbox in the toolbar to display the time-domain amplitude envelope above each spectrogram.

- Amplitude labels (-1.0, 0, 1.0) are displayed on the left Y-axis
- The waveform canvas is time-aligned with the spectrogram; click, zoom, and seek operations work on both simultaneously
- Shows amplitude envelope as min/max vertical bars per pixel column
- Synced playhead with the spectrogram view
- Ctrl+wheel and Shift+drag work on both the waveform and spectrogram

### Time Axis Zoom

Zoom into any region of the spectrogram for detailed inspection:

- **Ctrl + Mouse Wheel**: Zoom in/out centered on mouse position
- **Mouse Wheel** (when zoomed): Horizontal scroll to pan the visible region
- **Shift + Drag**: Select a time region to zoom into (box selection)
- **Toolbar + / – / Fit**: Zoom in, zoom out, or reset to full view
- **Keyboard**: `Shift+Up` (zoom in), `Shift+Down` (zoom out), `Shift+Left` (fit all)
- **Group sync**: All tracks in a diff group zoom and scroll together
- Playhead hides automatically when outside the visible region
- STFT is computed once and cached; zoom/scroll operations are instant

### Auto-Grouping for A/B Comparison

Files with matching base names and recognized tag suffixes are automatically grouped side-by-side for easy comparison. Use **Shift + Space** to instantly switch between tracks in a group while maintaining playback position.

#### Recognized Grouping Tags

The following tags trigger automatic grouping when used as a suffix (e.g., `file1_pred.wav`) or prefix (e.g., `pred_file1.wav`) with `_` or `-` separators:

| Category | Tags |
|---|---|
| **Original / Reference** | `orig`, `original`, `ref`, `reference`, `gt`, `ground_truth`, `target` |
| **Generated / Predicted** | `pred`, `predicted`, `gen`, `generated`, `synth`, `synthesized`, `output` |
| **Processing** | `recon`, `reconstructed`, `enhanced`, `denoised`, `clean`, `noisy` |
| **Input / Source** | `src`, `source`, `input`, `baseline`, `model` |
| **Version / Label** | `v1`, `v2`, `v3`, `v4`, `a`, `b`, `c`, `d` |

#### Grouping Examples

| Files | Grouped? | Reason |
|---|---|---|
| `song_pred.wav` + `song_orig.wav` | Yes | stem=`song`, tags=`pred`+`orig` |
| `song.wav` + `song_pred.wav` | Yes | stem=`song`, tags=(empty)+`pred` |
| `pred-song.wav` + `orig-song.wav` | Yes | prefix mode, stem=`song` |
| `file1_ground_truth.wav` + `file1.wav` | Yes | longest match: `ground_truth` |
| `/exp1/file1.wav` + `/exp2/file1.wav` | Yes | same-name different-dir, tags=`exp1`+`exp2` |
| `my_song.wav` + `my_voice.wav` | No | `song` and `voice` not in tag list |
| `file1_xxx.wav` | No | `xxx` not in tag list |

#### Grouping Rules

- Tags are matched **case-insensitively**, longest match first
- Both **suffix** (`stem_tag`) and **prefix** (`tag_stem`) patterns are supported
- A group forms when **2+ files** share the same stem with **2+ distinct tags** (empty tag counts as one)
- Same-name files from different directories are auto-grouped; the tag displays as the parent folder name
- Duplicate files (same path) are automatically skipped

### ML Audio Classification

Click **Analyze** to run on-device audio classification using the [CED-tiny](https://huggingface.co/mispeech/ced-tiny) ONNX model, which recognizes 527 AudioSet sound categories.

Three levels of analysis:

| Button | Location | Scope |
|---|---|---|
| **Analyze All** | Toolbar | All loaded tracks |
| **Analyze Group** | Group card header | All tracks in the group |
| **Analyze** | Individual track / lane | Single track |

The model is downloaded once on first use (~20MB) and cached for subsequent analyses. Detection results are displayed as colored tags below each spectrogram, showing detected sound categories, time ranges, and confidence levels.

### Cross-Directory Support

When comparing files from different directories, display names automatically show the relative path from their common parent directory for clear identification.

Example: files from `/project/exp1/file1.wav` and `/project/exp2/file1_pred.wav` display as `exp1/file1.wav` and `exp2/file1_pred.wav`.

Files with the same name from different directories are automatically grouped, with the parent folder name displayed as the tag.

## Usage

### Opening Files

| Method | Description |
|---|---|
| **Double-click** | Click an audio file in Explorer to open directly in SpecView |
| **Right-click** | Select multiple audio files → "Open with SpecView" → opens in one panel |
| **Command Palette** | `Ctrl+Shift+P` → "SpecView: Open Audio File" → file picker |
| **Click drop zone** | Click "Click to add audio files" area → file picker (defaults to last opened directory) |

### Track Management

- **Delete track**: Press `Delete` key or click the × button on the card header to remove a standalone track
- **Remove lane from group**: Click the × button on any lane label within a diff group to remove just that lane
  - If only 2 lanes remain, removing one converts the other to a standalone track
  - Cards maintain their position in the list when lanes are removed or groups are restructured
- **Re-add removed files**: Files that have been removed can be re-added normally

### Keyboard Shortcuts

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

## Requirements

- VS Code 1.85.0 or later
- Internet connection for first-time ML model download (~20MB from HuggingFace)

## License

[Apache-2.0](LICENSE)

## Credits

- Based on [SpecView](https://github.com/RicherMans/SpecView) by Heinrich
- Audio classification powered by [CED-tiny](https://huggingface.co/mispeech/ced-tiny) (ONNX Runtime Web)
