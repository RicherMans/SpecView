# ocen - Spectrogram Player

A web-based audio spectrogram player that visualizes audio files as spectrograms with a clean, modern interface. Features automatic grouping of related audio files for easy comparison.

![ocen Screenshot](screenshot.png)

## Features

- **Spectrogram Visualization**: View audio files as spectrograms with log-frequency axis (ocenaudio-style colormap)
- **Audio Playback**: Play, pause, stop, and seek through audio files
- **Diff Groups**: Automatically group files with matching base names and different suffixes (e.g., `song_orig.wav`, `song_pred.wav`, `song_enhanced.wav`)
- **Multi-track Support**: Load and visualize multiple audio files simultaneously
- **Synchronized Scrolling**: Diff groups scroll together for easy comparison
- **Keyboard Shortcuts**: Quick control with spacebar, arrow keys, and escape

## Supported Formats

MP3, WAV, OGG, FLAC, M4A, AAC, WebM, WMA, AIFF, Opus

## Usage

### Loading Audio Files

1. **Drag & Drop**: Drag audio files onto the drop zone
2. **Click to Browse**: Click the drop zone to open a file picker
3. **Multiple Files**: Select multiple files at once

### Automatic Grouping

Files with matching base names and different suffixes are automatically grouped for comparison:

- `song_orig.wav` + `song_pred.wav` → Diff group with 2 lanes
- `audio_ref.flac` + `audio_gen.flac` + `audio_enhanced.flac` → Diff group with 3 lanes

**Supported suffix patterns**:
- `_orig`, `_original`, `_ref`, `_reference`, `_gt`, `_ground_truth`, `_target`
- `_pred`, `_predicted`, `_gen`, `_generated`, `_synth`, `_synthesized`, `_output`
- `_recon`, `_reconstructed`, `_enhanced`, `_denoised`, `_clean`, `_noisy`
- `_src`, `_source`, `_input`, `_baseline`, `_model`
- `_v1`, `_v2`, `_v3`, `_v4`, `_a`, `_b`, `_c`, `_d`

### Playback Controls

- **Play/Pause**: Click the Play button or press `Space`
- **Stop**: Click the Stop button or press `Escape`
- **Seek**: Click anywhere on the spectrogram to jump to that position
- **Volume**: Adjust using the volume slider

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play/Pause |
| `Escape` | Stop |
| `←` | Seek backward 2 seconds |
| `→` | Seek forward 2 seconds |

## Interface

### Toolbar

- **ocen** logo
- **Play/Stop** buttons
- **Time display**: Current time / Total duration
- **Volume slider**
- **Clear All** button

### Drop Zone

- **Empty state**: Large area for initial file drop
- **Compact state**: Small bar when tracks are loaded

### Track Cards

- **Standalone tracks**: Single audio file with full spectrogram height (220px)
- **Diff groups**: Multiple tracks side-by-side with reduced height (180px)
- **Lane labels**: Show track name and suffix tag with color coding

### Spectrogram Display

- **Log-frequency axis**: Frequencies displayed on a logarithmic scale (30Hz to Nyquist)
- **Ocenaudio-style colormap**: Black → Navy → Blue → Purple → Magenta → Red → Orange → Yellow → White
- **Playhead**: Red vertical line showing current playback position
- **Time ruler**: Bottom timeline with time markers

## Technical Details

### Spectrogram Rendering

- **FFT Size**: 2048 samples
- **Window**: Hann window
- **Hop Size**: FFT_SIZE / 4 (50% overlap)
- **Frequency Scale**: Logarithmic (30Hz to Nyquist)
- **Dynamic Range**: 90 dB
- **Colormap**: Custom ocenaudio-style hot-metal palette

### Performance

- Spectrograms are rendered asynchronously using `requestAnimationFrame`
- Loading overlay shown during rendering
- Canvas-based rendering for smooth visualization

## Development

The application is a single HTML file with embedded CSS and JavaScript. No build process required.

### Running Locally

1. Open `spec.html` in a modern web browser
2. Or serve using a local web server:
   ```bash
   python -m http.server 8000
   ```
   Then navigate to `http://localhost:8000/spec.html`

### Browser Compatibility

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

## License

This project is provided as-is for educational and personal use.
