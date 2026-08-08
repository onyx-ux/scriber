import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { basename } from 'node:path';

const execFileAsync = promisify(execFile);

// Transcription runs in one of two places:
//
//   local  — whisper.cpp's CLI on the Pi itself. Works with no other machine
//            involved, but the Pi does neural inference on a 4-core ARM CPU:
//            whisper encodes a fixed 30-second window at ~65s per window, so
//            a real session takes hours.
//   server — whisper.cpp's HTTP server on a machine with a GPU (in this setup,
//            the Windows PC on the LAN). Two to three orders of magnitude
//            faster, and the audio never leaves the LAN.
//
// WHISPER_SERVER_URL picks the second. Everything else in the pipeline is
// unchanged: both paths return the same { text, segments } shape.

// whisper annotates non-speech audio with bracketed markers rather than
// leaving the segment empty — [BLANK_AUDIO] for silence, plus [SOUND],
// [MUSIC], [LAUGHTER] and similar. They're useful to whisper, but in a
// session transcript they read as if someone said "[BLANK_AUDIO]", and they
// get fed to the summariser as though they were dialogue.
const NON_SPEECH_MARKER = /^[\s]*[[(][^\])]*[\])][\s]*$/;

function stripNonSpeech(value) {
  const text = String(value || '').trim();
  return NON_SPEECH_MARKER.test(text) ? '' : text;
}

// The two JSON schemas differ — the CLI emits whisper.cpp's own format with
// millisecond `offsets`, the server emits an OpenAI-shaped `verbose_json`
// with `segments` in SECONDS. Both are normalised to milliseconds here so
// nothing downstream has to care which one produced a transcript.
function normalise(text, segments) {
  const cleaned = segments
    .map((s) => ({ ...s, text: stripNonSpeech(s.text) }))
    .filter((s) => s.text);

  // The top-level text is whisper's own concatenation, so it carries the same
  // markers; rebuild it from the cleaned segments when they're available
  // rather than trying to unpick them from the joined string.
  const wholeText = cleaned.length ? cleaned.map((s) => s.text).join(' ') : stripNonSpeech(text);

  return { text: wholeText.trim(), segments: cleaned };
}

async function transcribeLocally(wavPath, cfg, wordLevel, prompt) {
  // whisper.cpp's -of takes a prefix and appends ".json" itself — so the
  // real output path has the ".wav" stripped, not appended to the full name.
  const outPrefix = wavPath.replace(/\.wav$/, '');
  const jsonOutPath = `${outPrefix}.json`;

  await execFileAsync(
    cfg.whisperBin,
    [
      '-m', cfg.whisperModelPath,
      '-f', wavPath,
      '-oj',                          // output json
      '-of', outPrefix, // output file prefix (whisper.cpp appends .json)
      '-t', String(cfg.whisperThreads),
      '-nt',                          // no timestamps in stdout text (we use the JSON segments instead)
      '-l', cfg.whisperLanguage || 'en',
      ...(wordLevel ? ['-ml', '1', '-sow'] : []),
      // Campaign vocabulary, so proper nouns are spelled the campaign's way.
      // See stt/vocabulary.js.
      ...(prompt ? ['--prompt', prompt] : []),
    ],
    { timeout: 10 * 60 * 1000 } // 10 min hard cap per file — a single utterance shouldn't take anywhere near this
  );

  const raw = await readFile(jsonOutPath, 'utf8');
  await unlink(jsonOutPath).catch(() => {});
  const parsed = JSON.parse(raw);

  // whisper.cpp's CLI schema: { transcription: [{ text, offsets: { from, to } }] }
  const parsedSegments = parsed.transcription || [];
  return normalise(
    parsedSegments.map((s) => s.text.trim()).join(' '),
    parsedSegments.map((s) => ({
      text: String(s.text || '').trim(),
      fromMs: s.offsets?.from ?? 0,
      toMs: s.offsets?.to ?? s.offsets?.from ?? 0,
    }))
  );
}

async function transcribeOnServer(wavPath, cfg, wordLevel, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.whisperServerTimeoutMs);

  try {
    const form = new FormData();
    form.append('file', new Blob([await readFile(wavPath)]), basename(wavPath));
    // verbose_json is the only format that returns per-segment timings, which
    // /import needs to split one long recording into utterances.
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0.0');
    // Pin the language rather than letting whisper detect it. The multilingual
    // models (large-v3-turbo and friends) will happily decide a short, noisy
    // Discord clip is Welsh and transcribe it as such — and a session is
    // hundreds of short clips, so it only has to misfire occasionally to put
    // nonsense in the transcript. The English-only models ignore this.
    form.append('language', cfg.whisperLanguage || 'en');
    // Campaign vocabulary — see stt/vocabulary.js. whisper.cpp's server names
    // this field 'prompt'; OpenAI's API calls the same thing initial_prompt.
    if (prompt) form.append('prompt', prompt);
    if (wordLevel) {
      form.append('max_len', '1');
      form.append('split_on_word', 'true');
    }

    const res = await fetch(`${cfg.whisperServerUrl.replace(/\/$/, '')}/inference`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`whisper server returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }

    const data = await res.json();
    // OpenAI-shaped verbose_json: { text, segments: [{ text, start, end }] }
    // with start/end in SECONDS (the server multiplies whisper's centiseconds
    // by 0.01), unlike the CLI which reports milliseconds directly.
    const segments = (data.segments || []).map((s) => ({
      text: String(s.text || '').trim(),
      fromMs: Math.round((s.start ?? 0) * 1000),
      toMs: Math.round((s.end ?? s.start ?? 0) * 1000),
    }));

    // Fall back to joining the segments when the server omits a top-level
    // text field, so a transcript is never silently empty.
    return normalise(data.text || segments.map((s) => s.text).join(' '), segments);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`whisper server timed out after ${Math.round(cfg.whisperServerTimeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Requires the input to already be a WAV file (16kHz mono s16le) — conversion
// happens in voice/capture.js at capture time.
//
// wordLevel: emit one segment per word instead of whisper's own sentence-ish
// segmentation. Only used for merged multi-utterance files (see
// pipeline/transcribe.js): whisper's default segments there routinely span
// several of the clips that were merged, so everything collapses onto
// whichever clip the segment's midpoint lands in and the transcript loses its
// timestamps. Not worth it for a single clip, where there's nothing to split.
export async function transcribeWav(wavPath, cfg, { wordLevel = false, prompt = '' } = {}) {
  if (!cfg.whisperServerUrl) return transcribeLocally(wavPath, cfg, wordLevel, prompt);

  try {
    return await transcribeOnServer(wavPath, cfg, wordLevel, prompt);
  } catch (err) {
    if (!cfg.whisperLocalFallback) throw err;
    // The GPU machine being off shouldn't lose a session — the Pi can still
    // do it, just slowly. Logged loudly because "it worked but took nine
    // hours" is exactly the kind of thing that should never be silent.
    console.warn(
      `[whisper] server unavailable (${err.message}) — falling back to local CPU transcription, which is far slower`
    );
    return transcribeLocally(wavPath, cfg, wordLevel, prompt);
  }
}

// Whether the GPU transcription server is up. Used to warn at /leave time
// rather than after an hour of silent CPU grinding.
export async function isWhisperServerReachable(cfg, timeoutMs = 3000) {
  if (!cfg.whisperServerUrl) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // The server has no dedicated health route; a GET on the root is enough
    // to prove something is listening and speaking HTTP.
    const res = await fetch(cfg.whisperServerUrl.replace(/\/$/, '/'), { signal: controller.signal });
    clearTimeout(timer);
    return res.status < 500;
  } catch {
    return false;
  }
}
