import { readFile } from 'node:fs/promises';

// Merges many short per-utterance WAV files into one, so a whole batch can be
// handed to whisper.cpp in a single invocation instead of one per file.
// whisper.cpp reloads its entire model from disk every time it runs — for a
// real Discord session (100s of short, per-speaking-turn clips) that reload
// cost dwarfs actual transcription time, since most clips are only a second
// or two of real audio. Batching collapses N reloads into N/batchSize.

const WAV_HEADER_SIZE = 44;

// Walks RIFF chunks rather than assuming a fixed 44-byte header — not every
// WAV writer omits extra chunks (e.g. LIST) before `data`, and whisper.cpp
// itself doesn't, so trusting a fixed offset would silently misread audio.
function parsePcmWav(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid PCM WAV file');
  }

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (chunkId === 'data') {
      data = buffer.subarray(body, body + chunkSize);
    }
    offset = body + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }

  if (!fmt || !data) throw new Error('WAV file is missing a fmt or data chunk');
  return { ...fmt, data };
}

export function writePcmWav({ sampleRate, channels, bitsPerSample }, data) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(WAV_HEADER_SIZE);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Reads and concatenates `paths` in order, inserting `gapMs` of silence
// between each. Returns the merged WAV buffer plus each source's [startMs,
// endMs) span within the merged timeline, so whisper's segment offsets can
// later be matched back to whichever source utterance produced them.
export async function mergeWavs(paths, gapMs = 700) {
  if (paths.length === 0) return { buffer: writePcmWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16 }, Buffer.alloc(0)), ranges: [] };

  const parsed = await Promise.all(paths.map(async (p) => parsePcmWav(await readFile(p))));

  const { sampleRate, channels, bitsPerSample } = parsed[0];
  for (const p of parsed) {
    if (p.sampleRate !== sampleRate || p.channels !== channels || p.bitsPerSample !== bitsPerSample) {
      throw new Error('mergeWavs requires every input file to share the same format');
    }
  }

  const blockAlign = (channels * bitsPerSample) / 8;
  const bytesPerMs = (sampleRate * blockAlign) / 1000;
  // Silence duration is rounded to a whole number of samples, then expressed
  // in whole blocks, so the byte count is always block-aligned.
  const gapSamples = Math.round((gapMs / 1000) * sampleRate);
  const gap = Buffer.alloc(gapSamples * blockAlign);

  const chunks = [];
  const ranges = [];
  let cursorMs = 0;

  parsed.forEach((p, i) => {
    if (i > 0) {
      chunks.push(gap);
      cursorMs += gap.length / bytesPerMs;
    }
    const durationMs = p.data.length / bytesPerMs;
    ranges.push({ startMs: cursorMs, endMs: cursorMs + durationMs });
    chunks.push(p.data);
    cursorMs += durationMs;
  });

  const buffer = writePcmWav({ sampleRate, channels, bitsPerSample }, Buffer.concat(chunks));
  return { buffer, ranges };
}

// Assigns each whisper segment (offsets in ms within the merged file) back to
// whichever source range it belongs to, by nearest distance to that range's
// span (0 if the segment's midpoint falls inside it). A segment landing in a
// silence gap between two ranges — which whisper practically never produces,
// but the merge inserts gaps generous enough that it's not impossible — goes
// to whichever range's edge is closest, rather than always guessing forward
// or backward.
export function assignSegmentsToRanges(segments, ranges) {
  const texts = ranges.map(() => []);
  for (const seg of segments) {
    const mid = (seg.fromMs + seg.toMs) / 2;
    let bestIdx = 0;
    let bestDist = Infinity;
    ranges.forEach((r, i) => {
      const dist = mid < r.startMs ? r.startMs - mid : mid > r.endMs ? mid - r.endMs : 0;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    });
    texts[bestIdx].push(seg.text);
  }
  return texts.map((t) => t.join(' ').trim());
}
