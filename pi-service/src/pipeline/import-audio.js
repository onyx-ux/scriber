import { spawn } from 'node:child_process';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';

import { transcribeWav } from '../stt/whisper.js';
import { applyCorrections } from '../campaign/corrections.js';

// Import a recording made OUTSIDE Discord — a phone recording of a table
// game, or audio exported from another tool — and run it through the same
// transcribe → summarise → post pipeline.
//
// The one thing this can't do is tell speakers apart. A Discord capture gets
// one audio stream per person for free; a single room microphone would need
// speaker diarisation, which is a separate model. Rather than guess, every
// line is attributed to one label (default "Table"), and that's stated
// plainly to the user rather than being silently wrong.

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

function convertToWav(sourcePath, wavPath) {
  return new Promise((resolve, reject) => {
    // -vn drops any video stream (phone recordings are often .mp4), and the
    // output matches exactly what whisper.cpp expects: 16kHz mono PCM.
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', sourcePath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      wavPath,
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg could not read that audio (${stderr.trim().slice(0, 300)})`));
    });
  });
}

async function fetchToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the file (HTTP ${res.status})`);

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`That file is ${Math.round(declared / 1048576)}MB — too large to import.`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));

  const { size } = await stat(destPath);
  if (size === 0) throw new Error('The downloaded file was empty.');
  return size;
}

// Turns whisper's flat segment list into utterance rows. Consecutive segments
// are merged up to a target length so the transcript reads in paragraphs
// rather than one row per half-sentence.
export function segmentsToUtterances(segments, speakerLabel, { maxChars = 400 } = {}) {
  const utterances = [];
  let current = null;

  for (const seg of segments) {
    if (current && current.text.length + seg.text.length + 1 <= maxChars) {
      current.text = `${current.text} ${seg.text}`.trim();
      current.endMs = seg.toMs;
      continue;
    }
    if (current) utterances.push(current);
    current = {
      userId: 'imported',
      displayName: speakerLabel,
      startMs: seg.fromMs,
      endMs: seg.toMs,
      text: seg.text,
    };
  }
  if (current) utterances.push(current);
  return utterances;
}

export async function importAudio({
  db,
  cfg,
  guildId,
  campaignId,
  channelId,
  channelName,
  url,
  filename,
  speakerLabel = 'Table',
  onProgress,
}) {
  const importDir = join(cfg.dataDir, 'audio', `import-${guildId}-${Date.now()}`);
  await mkdir(importDir, { recursive: true });

  const sourcePath = join(importDir, filename || 'source-audio');
  const wavPath = join(importDir, 'audio.wav');

  onProgress?.('downloading');
  await fetchToFile(url, sourcePath);

  onProgress?.('converting');
  await convertToWav(sourcePath, wavPath);

  onProgress?.('transcribing');
  const { segments } = await transcribeWav(wavPath, cfg);
  if (!segments || segments.length === 0) {
    throw new Error('Whisper found no speech in that recording.');
  }

  const corrections = campaignId ? db.listCorrections(campaignId) : [];
  const utterances = segmentsToUtterances(segments, speakerLabel).map((u) => ({
    ...u,
    text: applyCorrections(u.text, corrections),
  }));

  // Imported audio has no real wall-clock start, so anchor the session at the
  // import time and let the offsets carry the internal timing.
  const startedAt = new Date().toISOString();
  const lastOffset = utterances[utterances.length - 1]?.endMs ?? 0;

  const meetingId = db.createMeeting({
    guildId,
    campaignId,
    channelId,
    channelName,
    startedAt,
    audioDir: importDir,
  });
  db.endMeeting(meetingId, new Date(Date.parse(startedAt) + lastOffset).toISOString());

  const job = db.finalizeTranscription(meetingId, utterances, {
    requireApproval: cfg.summaryRequireApproval,
  });

  return { meetingId, utteranceCount: utterances.length, job };
}
