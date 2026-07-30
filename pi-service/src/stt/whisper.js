import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

// whisper.cpp's CLI, invoked with -oj (output JSON) and -np (no printing to
// stdout beyond the JSON) so we get structured segments back instead of
// having to scrape stdout text. Requires the input to already be a WAV file
// (16kHz mono s16le) — conversion happens in voice/capture.js at capture time.
export async function transcribeWav(wavPath, cfg) {
  const jsonOutPath = `${wavPath}.json`;

  await execFileAsync(
    cfg.whisperBin,
    [
      '-m', cfg.whisperModelPath,
      '-f', wavPath,
      '-oj',                          // output json
      '-of', wavPath.replace(/\.wav$/, ''), // output file prefix (whisper.cpp appends .json)
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
  const segments = parsed.transcription || [];
  const text = segments.map((s) => s.text.trim()).join(' ').trim();
  return { text };
}
