import { open, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { readPcmWav } from './wav-merge.js';

// Reconstructs a whole session as ONE continuous audio file, instead of the
// hundreds of separate per-utterance clips capture.js writes (one per
// speaking turn, per user — see voice/capture.js). Transcription deliberately
// keeps using those small clips (batched — see transcribe.js/wav-merge.js);
// this is a second, independent output whose only job is to be a clean,
// single file worth backing up and actually listening back to.
//
// Each utterance is written at its OWN real start time, not concatenated
// back-to-back — so the result actually sounds like the session as it
// happened, silences included, rather than every line squashed together.
//
// KNOWN LIMITATION: if two people talk at the same time, whichever utterance
// gets written second simply overwrites the other's bytes for that overlap
// — no sample-level mixing. That's a deliberate simplification: real
// multi-track mixing means reading, summing, and rewriting every overlapping
// byte range, which is a lot of extra I/O for what's normally a brief,
// rare artifact in turn-taking tabletop conversation.
//
// Writes positionally rather than building the session in memory — an
// hours-long session at 16kHz mono is tens to hundreds of MB, comfortably
// writable to disk but not something to hold as one in-memory buffer on a
// Raspberry Pi.
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BLOCK_ALIGN = (CHANNELS * BITS_PER_SAMPLE) / 8;

function msToByteOffset(ms) {
  return Math.floor((ms / 1000) * SAMPLE_RATE) * BLOCK_ALIGN;
}

function wavHeader(dataLength) {
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(BLOCK_ALIGN, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

export async function buildSessionRecording(capturedUtterances, outPath) {
  if (!capturedUtterances || capturedUtterances.length === 0) return null;

  const totalMs = Math.max(...capturedUtterances.map((u) => u.endMs));
  const totalBytes = msToByteOffset(totalMs);

  const handle = await open(outPath, 'w');
  try {
    await handle.write(wavHeader(totalBytes), 0, 44, 0);

    // Pre-size the whole file so every utterance write below lands inside an
    // already-allocated region. Sparse regions on most filesystems read back
    // as zero bytes anyway (silence, for 16-bit PCM), but this makes that
    // guaranteed rather than filesystem-dependent.
    await handle.truncate(44 + totalBytes);

    for (const u of capturedUtterances) {
      let parsed;
      try {
        parsed = await readPcmWav(u.wavPath);
      } catch (err) {
        console.warn(`[session-recording] skipping unreadable clip ${u.wavPath}: ${err.message}`);
        continue;
      }
      if (parsed.sampleRate !== SAMPLE_RATE || parsed.channels !== CHANNELS || parsed.bitsPerSample !== BITS_PER_SAMPLE) {
        console.warn(`[session-recording] skipping ${u.wavPath}: unexpected format`);
        continue;
      }
      const offset = 44 + msToByteOffset(u.startMs);
      await handle.write(parsed.data, 0, parsed.data.length, offset);
    }
  } finally {
    await handle.close();
  }

  return outPath;
}

// Speech doesn't need music-grade bitrate — 64kbps mono keeps a 3-hour
// session around 65-90MB instead of the ~345MB the raw 16kHz/16-bit WAV
// would be, without being noticeably worse to listen back to.
export function compressToMp3(wavPath, mp3Path) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', wavPath,
      '-ac', '1',
      '-b:a', '64k',
      mp3Path,
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on('error', reject); // e.g. ffmpeg binary missing
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg compression failed: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

// Builds the reconstruction, compresses it, and cleans up the (much larger)
// intermediate WAV — only the compressed MP3 is meant to stick around.
export async function buildCompressedSessionRecording(capturedUtterances, workDir) {
  const wavPath = `${workDir}/session-full.wav`;
  const mp3Path = `${workDir}/session-full.mp3`;

  const built = await buildSessionRecording(capturedUtterances, wavPath);
  if (!built) return null;

  try {
    await compressToMp3(wavPath, mp3Path);
    return mp3Path;
  } finally {
    await unlink(wavPath).catch(() => {});
  }
}
