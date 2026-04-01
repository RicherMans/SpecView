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
- **Click on spectrogram** to seek to any position
- **Volume control** slider
- Real-time playhead tracking with time display

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
| `my_song.wav` + `my_voice.wav` | No | `song` and `voice` not in tag list |
| `file1_xxx.wav` | No | `xxx` not in tag list |

#### Grouping Rules

- Tags are matched **case-insensitively**, longest match first
- Both **suffix** (`stem_tag`) and **prefix** (`tag_stem`) patterns are supported
- A group forms when **2+ files** share the same stem with **2+ distinct tags** (empty tag counts as one)
- Duplicate files (same path) are automatically skipped

### ML Audio Classification

Click **Analyze** to run on-device audio classification using the [CED-tiny](https://huggingface.co/mispeech/ced-tiny) ONNX model, which recognizes 527 AudioSet sound categories.

Three levels of analysis:

| Button | Location | Scope |
|---|---|---|
| **Analyze All** | Toolbar | All loaded tracks |
| **Analyze Group** | Group card header | All tracks in the group |
| **Analyze** | Individual track / lane | Single track |

The model is downloaded once on first use (~20MB) and cached for subsequent analyses.

### Cross-Directory Support

When comparing files from different directories, display names automatically show the relative path from their common parent directory for clear identification.

Example: files from `/project/exp1/file1.wav` and `/project/exp2/file1_pred.wav` display as `exp1/file1.wav` and `exp2/file1_pred.wav`.

## Usage

### Opening Files

| Method | Description |
|---|---|
| **Double-click** | Click an audio file in Explorer to open directly in SpecView |
| **Right-click** | Select multiple audio files → "Open with SpecView" → opens in one panel |
| **Command Palette** | `Ctrl+Shift+P` → "SpecView: Open Audio File" → file picker |
| **Click drop zone** | Click "Click to add audio files" area → file picker (defaults to last opened directory) |

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `Shift + Space` | Switch lane in diff group (A/B comparison) |
| `Escape` | Stop playback and reset position |
| `←` | Seek backward 2 seconds |
| `→` | Seek forward 2 seconds |

## Requirements

- VS Code 1.85.0 or later
- Internet connection for first-time ML model download (~20MB from HuggingFace)

## License

[Apache-2.0](LICENSE)

## Credits

- Based on [SpecView](https://github.com/RicherMans/SpecView) by Heinrich
- Audio classification powered by [CED-tiny](https://huggingface.co/mispeech/ced-tiny) (ONNX Runtime Web)
