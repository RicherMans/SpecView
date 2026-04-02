import type { Track, AnalysisSpan } from './types';
import { esc } from './util';

const CED_SR = 16000;
const CED_CHUNK_SEC = 0.96;
const CED_CHUNK_SAMPLES = Math.round(CED_SR * CED_CHUNK_SEC);
const CED_TOP_N = 5;
const CED_THRESH_COMMON = 0.50;
const CED_THRESH_RARE = 0.25;

const CED_COMMON = new Set([
  0, 1, 2, 3, 4, 5, 6, 27, 32, 33, 72, 73, 108, 137, 138, 139, 161,
  185, 189, 195, 254, 266, 267, 268, 270, 283, 288, 300, 306, 388, 404, 418, 504, 513, 514,
]);

const CED_BLACKLIST = new Set([500, 506, 507, 508, 509, 510, 526]);

const AUDIOSET_LABELS: string[] = [
  "Speech", "Male speech", "Female speech", "Child speech", "Conversation", "Narration", "Babbling",
  "Speech synthesizer", "Shout", "Bellow", "Whoop", "Yell", "Battle cry", "Children shouting",
  "Screaming", "Whispering", "Laughter", "Baby laughter", "Giggle", "Snicker", "Belly laugh",
  "Chuckle", "Crying", "Baby cry", "Whimper", "Wail", "Sigh", "Singing", "Choir", "Yodeling",
  "Chant", "Mantra", "Male singing", "Female singing", "Child singing", "Synthetic singing",
  "Rapping", "Humming", "Groan", "Grunt", "Whistling", "Breathing", "Wheeze", "Snoring", "Gasp",
  "Pant", "Snort", "Cough", "Throat clearing", "Sneeze", "Sniff", "Run", "Shuffle", "Walk",
  "Chewing", "Biting", "Gargling", "Stomach rumble", "Burping", "Hiccup", "Fart", "Hands",
  "Finger snapping", "Clapping", "Heart sounds", "Heart murmur", "Cheering", "Applause", "Chatter",
  "Crowd", "Hubbub", "Children playing", "Animal", "Domestic animals", "Dog", "Bark", "Yip", "Howl",
  "Bow-wow", "Growling", "Whimper (dog)", "Cat", "Purr", "Meow", "Hiss", "Caterwaul", "Livestock",
  "Horse", "Clip-clop", "Neigh", "Cattle", "Moo", "Cowbell", "Pig", "Oink", "Goat", "Bleat",
  "Sheep", "Fowl", "Chicken", "Cluck", "Crowing", "Turkey", "Gobble", "Duck", "Quack", "Goose",
  "Honk", "Wild animals", "Roaring cats (lions, tigers)", "Roar", "Bird", "Bird vocalization",
  "Chirp", "Squawk", "Pigeon", "Coo", "Crow", "Caw", "Owl", "Hoot", "Bird flight", "Canidae",
  "Rodents", "Mouse", "Patter", "Insect", "Cricket", "Mosquito", "Fly", "Buzz", "Bee", "Frog",
  "Croak", "Snake", "Rattle", "Whale vocalization", "Music", "Musical instrument",
  "Plucked string instrument", "Guitar", "Electric guitar", "Bass guitar", "Acoustic guitar",
  "Steel guitar", "Tapping (guitar technique)", "Strum", "Banjo", "Sitar", "Mandolin", "Zither",
  "Ukulele", "Keyboard (musical)", "Piano", "Electric piano", "Organ", "Electronic organ",
  "Hammond organ", "Synthesizer", "Sampler", "Harpsichord", "Percussion", "Drum kit",
  "Drum machine", "Drum", "Snare drum", "Rimshot", "Drum roll", "Bass drum", "Timpani", "Tabla",
  "Cymbal", "Hi-hat", "Wood block", "Tambourine", "Rattle (instrument)", "Maraca", "Gong",
  "Tubular bells", "Mallet percussion", "Marimba", "Glockenspiel", "Vibraphone",
  "Bowed string instrument", "Violin, fiddle", "Pizzicato", "Cello", "Double bass", "Harp",
  "Wind instrument, woodwind instrument", "Flute", "Saxophone", "Clarinet", "Oboe",
  "Bassoon", "Recorder", "Brass instrument", "Horn", "Trumpet", "Trombone", "Tuba",
  "Didgeridoo", "Shofar", "Theremin", "Harmonica", "Accordion", "Bagpipes", "Dulcimer",
  "Erhu", "Guzheng", "Pipa", "Shamisen", "Koto", "Kalimba", "Mbira", "Steelpan",
  "Orchestra", "Brass band", "Marching band", "Choir", "A capella", "Background music",
  "Theme music", "Jingle (music)", "Soundtrack music", "Lullaby", "Video game music",
  "Christmas music", "Dance music", "Wedding music", "Happy music", "Funny music", "Sad music",
  "Tender music", "Exciting music", "Angry music", "Scary music", "Wind", "Rustling leaves",
  "Wind noise (microphone)", "Thunderstorm", "Thunder", "Water", "Rain", "Raindrop",
  "Rain on surface", "Stream", "Waterfall", "Ocean", "Waves", "Steam", "Bubbling water",
  "Drip", "Pour", "Trickle", "Gush", "Fill (with liquid)", "Spray", "Pump (liquid)",
  "Stir", "Boiling", "Sonar", "Ice", "Crack", "Glass", "Chink", "Shatter", "Splash",
  "Slosh", "Squish", "Drip", "Pour", "Crushing", "Crackling", "Ripping", "Tearing",
  "Bouncing", "Whip", "Slap", "Smash", "Breaking", "Biting", "Chewing", "Sliding door",
  "Slam", "Knock", "Tap", "Squeak", "Drawer", "Click", "Tap (guitar technique)",
  "Keys jangling", "Coin (dropping)", "Scissors", "Electric shaver", "Zipper",
  "Typewriter", "Computer keyboard", "Writing", "Alarm", "Telephone", "Telephone bell",
  "Ringtone", "Telephone dialing, DTMF", "Dial tone", "Busy signal", "Alarm clock",
  "Siren", "Civil defense siren", "Buzzer", "Smoke detector, smoke alarm", "Fire alarm",
  "Foghorn", "Whistle", "Steam whistle", "Mechanisms", "Ratchet, pawl", "Clock", "Tick",
  "Tick-tock", "Gears", "Pulleys", "Sewing machine", "Mechanical fan", "Air conditioning",
  "Cash register", "Printer", "Camera", "Single-lens reflex camera", "Tools", "Hammer",
  "Saw", "Filing (rasp)", "Power drill", "Jackhammer", "Chainsaw", "Medium engine (mid)",
  "Small engine", "Large engine", "Engine", "Engine starting", "Idling", "Accelerating",
  "Reversing beeps", "Interior car", "Car passing by", "Air brake", "Tire squeal",
  "Skidding", "Door", "Doorbell", "Ding-dong", "Sliding door", "Slam", "Bang",
  "Filing (rasp)", "Drawer", "Cupboard open or close", "Dishes, pots, and pans",
  "Cutlery, silverware", "Chopping (food)", "Frying (food)", "Microwave oven",
  "Blender", "Water faucet, tap", "Sink (filling or washing)", "Bathtub (filling or washing)",
  "Toilet flush", "Zipper", "Keys jangling", "Coin (dropping)", "Packing tape", "Scissors",
  "Electric shaver", "Shuffle", "Footsteps", "Cheering", "Applause", "Chatter", "Crowd",
  "Hubbub", "Children playing", "Bicycle", "Skateboard", "Bus", "Subway, metro, underground",
  "Train", "Aircraft", "Aircraft engine", "Helicopter", "Small aircraft", "Jet engine",
  "Propeller, airscrew", "Ship", "Motorboat, speedboat", "Sailboat, sailing ship",
  "Canoe, kayak", "Rowboat, canoe, kayak", "Motor vehicle (road)", "Car", "Vehicle horn",
  "Beep, bleep", "Truck", "Air horn", "Train horn", "Motorcycle", "Traffic noise, roadway noise",
  "Rail transport", "Train wheels squealing", "Subway, metro, underground",
  "Aircraft", "Jet engine", "Propeller", "Helicopter", "Fixed-wing aircraft, airplane",
  "Rocket engine", "Ship", "Boat, Water vehicle", "Sailboat", "Rowboat", "Motorboat",
  "Explosion", "Gunshot, gunfire", "Machine gun", "Fusillade", "Artillery fire", "Cap gun",
  "Fireworks", "Firecracker", "Burst, pop", "Eruption", "Boom", "Wood", "Chop",
  "Splinter", "Crack", "Glass", "Chink of glass", "Shatter", "Liquid", "Splash, splatter",
  "Slosh", "Drip", "Pour", "Boiling", "Fill (with liquid)", "Spray", "Pump (liquid)",
  "Stir", "Squish", "Drip, splash", "Rain", "Raindrop", "Rain on surface", "Steam",
  "Bubbling water", "Ocean", "Waves", "Stream", "Waterfall", "Sink (filling)",
  "Bathtub (filling)", "Toilet flush", "Trickle, dribble", "Gush",
  "Inside, large room or hall", "Inside, small room", "Inside, public space",
  "Outside, urban or manmade", "Outside, rural or natural", "Outside, manmade",
  "Reverberation", "Echo", "Noise", "Environmental noise", "Static", "Mains hum",
  "Distortion", "Sidetone", "Acoustic signature", "Sound effect", "Pulse", "Zap",
  "Music", "Music genre", "Tonal", "Tuning fork", "Singing bowl",
  "Field recording",
];

const ANALYSIS_COLORS = [
  '#4f83cc', '#c0392b', '#27ae60', '#e67e22', '#8e44ad',
  '#16a085', '#d4ac0d', '#2980b9', '#e74c3c', '#1abc9c',
  '#f39c12', '#9b59b6', '#3498db', '#e84393', '#00b894',
];

let cedSession: any = null;
let cedLoading = false;
let cedLoadCallbacks: ((s: any) => void)[] = [];
let cedProgressEl: HTMLElement | null = null;

// Configure ONNX Runtime WASM paths
(function configureOrt() {
  if (typeof (window as any).ort !== 'undefined') {
    const ort = (window as any).ort;
    const wasmBase = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
    ort.env.wasm.wasmPaths = wasmBase;
    ort.env.wasm.numThreads = 1;
  }
})();

/**
 * Request model URL from extension host.
 * Extension host downloads/caches the model on disk and returns a webview-accessible URL.
 */
function requestModelFromHost(): Promise<string> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'modelProgress' && cedProgressEl) {
        if (msg.status === 'downloading') {
          const mb = (msg.loaded / 1048576).toFixed(1);
          const tmb = msg.total > msg.loaded ? (msg.total / 1048576).toFixed(1) : '?';
          cedProgressEl.innerHTML = '<div class="spinner" style="display:inline-block;vertical-align:middle;margin-right:6px"></div>Downloading model... ' + mb + ' / ' + tmb + ' MB';
        } else if (msg.status === 'saving') {
          cedProgressEl.innerHTML = '<div class="spinner" style="display:inline-block;vertical-align:middle;margin-right:6px"></div>Saving model to cache...';
        }
      } else if (msg.type === 'modelReady') {
        window.removeEventListener('message', handler);
        resolve(msg.url);
      } else if (msg.type === 'modelError') {
        window.removeEventListener('message', handler);
        reject(new Error(msg.message));
      }
    };
    window.addEventListener('message', handler);
    (window as any).__vscodePostMessage({ type: 'requestModel' });
  });
}

async function loadCedModel(): Promise<any> {
  const ort = (window as any).ort;
  if (!ort) throw new Error('ONNX Runtime not loaded. Check network connection for CDN access.');
  if (cedSession) return cedSession;
  if (cedLoading) {
    return new Promise(resolve => cedLoadCallbacks.push(resolve));
  }
  cedLoading = true;
  try {
    // Get model URL from extension host (cached on disk)
    const modelUrl = await requestModelFromHost();

    if (cedProgressEl) {
      cedProgressEl.innerHTML = '<div class="spinner" style="display:inline-block;vertical-align:middle;margin-right:6px"></div>Loading model into ONNX Runtime...';
    }
    await new Promise(r => setTimeout(r, 0));

    // Fetch model data from local webview URI, then create session from ArrayBuffer
    const resp = await fetch(modelUrl);
    if (!resp.ok) throw new Error('Failed to fetch cached model: HTTP ' + resp.status);
    const modelData = await resp.arrayBuffer();

    if (cedProgressEl) {
      cedProgressEl.innerHTML = '<div class="spinner" style="display:inline-block;vertical-align:middle;margin-right:6px"></div>Initializing WASM runtime...';
    }
    await new Promise(r => setTimeout(r, 0));

    cedSession = await ort.InferenceSession.create(modelData, {
      executionProviders: ['wasm'],
    });
    cedLoading = false;
    for (const cb of cedLoadCallbacks) cb(cedSession);
    cedLoadCallbacks = [];
    return cedSession;
  } catch (e) {
    cedLoading = false;
    cedLoadCallbacks = [];
    throw e;
  }
}

async function resampleTo16k(buffer: AudioBuffer): Promise<Float32Array> {
  const targetLen = Math.round(buffer.duration * CED_SR);
  const offCtx = new OfflineAudioContext(1, targetLen, CED_SR);
  const src = offCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(offCtx.destination);
  src.start(0);
  const rendered = await offCtx.startRendering();
  return rendered.getChannelData(0);
}

function postProcessAnalysis(chunkResults: { startSec: number; endSec: number; labels: { idx: number; prob: number }[] }[], duration: number): AnalysisSpan[] {
  const labelMap = new Map<number, { startSec: number; endSec: number; prob: number }[]>();

  for (const cr of chunkResults) {
    for (const l of cr.labels) {
      if (!labelMap.has(l.idx)) labelMap.set(l.idx, []);
      labelMap.get(l.idx)!.push({ startSec: cr.startSec, endSec: cr.endSec, prob: l.prob });
    }
  }

  const spans: AnalysisSpan[] = [];
  const mergeGap = CED_CHUNK_SEC * 1.5;

  for (const [labelIdx, chunks] of labelMap) {
    chunks.sort((a, b) => a.startSec - b.startSec);

    let spanStart = chunks[0].startSec;
    let spanEnd = chunks[0].endSec;
    let maxProb = chunks[0].prob;

    for (let i = 1; i < chunks.length; i++) {
      if (chunks[i].startSec - spanEnd <= mergeGap) {
        spanEnd = chunks[i].endSec;
        if (chunks[i].prob > maxProb) maxProb = chunks[i].prob;
      } else {
        spans.push({ label: AUDIOSET_LABELS[labelIdx] || `Label ${labelIdx}`, labelIdx, startSec: spanStart, endSec: spanEnd, maxProb });
        spanStart = chunks[i].startSec;
        spanEnd = chunks[i].endSec;
        maxProb = chunks[i].prob;
      }
    }
    spans.push({ label: AUDIOSET_LABELS[labelIdx] || `Label ${labelIdx}`, labelIdx, startSec: spanStart, endSec: spanEnd, maxProb });
  }

  spans.sort((a, b) => a.startSec - b.startSec || b.maxProb - a.maxProb);
  return spans;
}

function renderAnalysisStrip(track: Track): void {
  const strip = track.analysisStrip;
  const spans = track.analysisResults;
  if (!strip || !spans || !spans.length) {
    if (strip) { strip.innerHTML = '<div class="analysis-progress">No events detected above 50%</div>'; }
    return;
  }
  strip.innerHTML = '';
  strip.classList.remove('empty');

  const dur = track.duration;
  const rows: number[] = [];
  const spanRows = new Map<AnalysisSpan, number>();

  for (const sp of spans) {
    let placed = false;
    for (let r = 0; r < rows.length; r++) {
      if (sp.startSec >= rows[r] - 0.01) {
        rows[r] = sp.endSec;
        spanRows.set(sp, r);
        placed = true;
        break;
      }
    }
    if (!placed) {
      spanRows.set(sp, rows.length);
      rows.push(sp.endSec);
    }
  }

  const rowEls: HTMLElement[] = [];
  for (let r = 0; r < rows.length; r++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'analysis-row';
    strip.appendChild(rowEl);
    rowEls.push(rowEl);
  }

  const labelColorMap = new Map<number, string>();
  let colorIdx = 0;

  for (const sp of spans) {
    if (!labelColorMap.has(sp.labelIdx)) {
      labelColorMap.set(sp.labelIdx, ANALYSIS_COLORS[colorIdx % ANALYSIS_COLORS.length]);
      colorIdx++;
    }
    const color = labelColorMap.get(sp.labelIdx)!;
    const row = spanRows.get(sp)!;
    const leftPct = (sp.startSec / dur * 100);
    const widthPct = ((sp.endSec - sp.startSec) / dur * 100);

    const tag = document.createElement('div');
    tag.className = 'analysis-tag';
    tag.style.left = leftPct + '%';
    tag.style.width = Math.max(widthPct, 0.5) + '%';
    tag.style.background = color + '33';
    tag.style.color = color;
    tag.style.borderColor = color + '66';
    tag.textContent = sp.label;
    tag.title = sp.label + ' (' + (sp.maxProb * 100).toFixed(0) + '%) ' +
      sp.startSec.toFixed(1) + 's\u2013' + sp.endSec.toFixed(1) + 's';
    rowEls[row].appendChild(tag);
  }
}

export async function runAnalysis(track: Track): Promise<void> {
  if (track.analysisResults) return;
  const btn = track.analyzeBtn;
  const strip = track.analysisStrip;
  if (!btn || !strip) return;

  btn.disabled = true;
  btn.textContent = 'Loading...';
  strip.classList.remove('empty');
  strip.innerHTML = '<div class="analysis-progress"><div class="spinner" style="display:inline-block;vertical-align:middle;margin-right:6px"></div>Loading CED-tiny model...</div>';
  cedProgressEl = strip.querySelector('.analysis-progress') as HTMLElement;

  let session: any;
  try {
    session = await loadCedModel();
    cedProgressEl = null;
  } catch (e) {
    strip.innerHTML = '<div class="analysis-progress" style="color:#e74c3c">Failed to load model: ' + esc(String((e as Error).message || e)) + '</div>';
    btn.textContent = 'Analyze';
    btn.disabled = false;
    return;
  }

  btn.textContent = 'Analyzing...';
  strip.innerHTML = '<div class="analysis-progress"><div class="spinner" style="display:inline-block;vertical-align:middle;margin-right:6px"></div>Resampling to 16kHz...</div>';

  let pcm16k: Float32Array;
  try {
    pcm16k = await resampleTo16k(track.buffer);
  } catch (e) {
    strip.innerHTML = '<div class="analysis-progress" style="color:#e74c3c">Resample failed: ' + esc(String((e as Error).message || e)) + '</div>';
    btn.textContent = 'Analyze';
    btn.disabled = false;
    return;
  }

  const inputName = session.inputNames[0];
  const ort = (window as any).ort;
  const nChunks = Math.max(1, Math.ceil(pcm16k.length / CED_CHUNK_SAMPLES));
  const chunkResults: { startSec: number; endSec: number; labels: { idx: number; prob: number }[] }[] = [];

  for (let i = 0; i < nChunks; i++) {
    const startSample = i * CED_CHUNK_SAMPLES;
    const endSample = Math.min(startSample + CED_CHUNK_SAMPLES, pcm16k.length);
    const chunk = new Float32Array(CED_CHUNK_SAMPLES);
    chunk.set(pcm16k.subarray(startSample, endSample));

    strip.innerHTML = '<div class="analysis-progress"><div class="spinner" style="display:inline-block;vertical-align:middle;margin-right:6px"></div>Analyzing chunk ' + (i + 1) + '/' + nChunks + '...</div>';
    await new Promise(r => setTimeout(r, 0));

    try {
      const tensor = new ort.Tensor('float32', chunk, [1, chunk.length]);
      const result = await session.run({ [inputName]: tensor });
      const output = result[session.outputNames[0]];
      const probs = output.data as Float32Array;

      const scored: { idx: number; prob: number }[] = [];
      for (let k = 0; k < probs.length; k++) {
        if (CED_BLACKLIST.has(k)) continue;
        scored.push({ idx: k, prob: probs[k] });
      }
      scored.sort((a, b) => b.prob - a.prob);
      const topN = scored.slice(0, CED_TOP_N);
      const labels = topN.filter(l => {
        const thresh = CED_COMMON.has(l.idx) ? CED_THRESH_COMMON : CED_THRESH_RARE;
        return l.prob >= thresh;
      });

      const startSec = startSample / CED_SR;
      const endSec = endSample / CED_SR;
      chunkResults.push({ startSec, endSec, labels });
    } catch {
      chunkResults.push({ startSec: startSample / CED_SR, endSec: endSample / CED_SR, labels: [] });
    }
  }

  track.analysisResults = postProcessAnalysis(chunkResults, track.duration);
  renderAnalysisStrip(track);
  btn.textContent = 'Done';
}

/** Analyze all tracks sequentially (skips already-analyzed tracks) */
export async function runAnalysisAll(allTracks: Track[]): Promise<void> {
  for (const t of allTracks) {
    if (!t.analysisResults) {
      await runAnalysis(t);
    }
  }
}

/** Analyze all tracks in a specific group sequentially */
export async function runAnalysisGroup(allTracks: Track[], groupId: number): Promise<void> {
  const groupTracks = allTracks.filter(t => t.groupId === groupId);
  for (const t of groupTracks) {
    if (!t.analysisResults) {
      await runAnalysis(t);
    }
  }
}
