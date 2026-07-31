import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

// whisper.cpp's CLI, invoked with -oj (output JSON) and -np (no printing to
// stdout beyond the JSON) so we get structured segments back instead of
// having to scrape stdout text. Requires the input to already be a WAV file
// (16kHz mono s16le) — conversion happens in voice/capture.js at capture time.
export async function transcribeWav(wavPath, cfg) {
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
      '-l', 'en',
    ],
    { timeout: 10 * 60 * 1000 } // 10 min hard cap per file — a single utterance shouldn't take anywhere near this
  );

  const raw = await readFile(jsonOutPath, 'utf8');
  await unlink(jsonOutPath).catch(() => {});
  const parsed = JSON.parse(raw);

  // whisper.cpp's JSON schema: { transcription: [{ text, offsets: { from, to } }, ...] }
  const parsedSegments = parsed.transcription || [];
  const text = parsedSegments.map((s) => s.text.trim()).join(' ').trim();

  // Segments (with their offsets) are what an imported single-track recording
  // needs — a Discord capture already has one file per speaking turn, but an
  // in-person recording is one long file and has to be split by timestamp.
  const segments = parsedSegments
    .map((s) => ({
      text: String(s.text || '').trim(),
      fromMs: s.offsets?.from ?? 0,
      toMs: s.offsets?.to ?? s.offsets?.from ?? 0,
    }))
    .filter((s) => s.text);

  return { text, segments };
}
