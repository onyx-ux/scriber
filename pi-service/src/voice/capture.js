import { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import prism from 'prism-media';
import { spawn } from 'node:child_process';
import { unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { wavDurationMs } from '../pipeline/wav-merge.js';

const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_CHANNELS = 2;
const TARGET_SAMPLE_RATE = 16000; // what whisper.cpp expects

// Shortest clip worth transcribing. Discord opens a speaking segment whenever
// its voice-activity flag flickers — a mic click, a noise-gate blip, someone
// bumping their desk — and those produce WAVs with little or no audio in them.
//
// This used to be a file-SIZE check ("anything <= 44 bytes, a bare WAV header,
// is empty"), which silently failed: ffmpeg also writes a LIST/INFO metadata
// chunk, so a WAV containing zero samples is 78 bytes and passed the test.
// Those empty clips went on to whisper, where each one cost a full 30-second
// encode window (~65s on the Pi) to transcribe nothing at all, and the GPU
// transcription server rejects them with HTTP 400.
//
// 100ms is deliberately conservative — well under the shortest real word, so
// nothing anyone actually said gets dropped.
export const MIN_UTTERANCE_MS = 100;

// Resample 48kHz stereo -> 16kHz mono via ffmpeg's swresample rather than a
// hand-rolled decimator. A naive "take every 3rd sample" downsample (the
// previous approach here) has no anti-aliasing filter and measurably hurts
// whisper's transcription accuracy on sibilants/consonants; ffmpeg's resampler
// is the same one used by essentially every other transcription pipeline.
function resampleToWav(pcmStream, wavPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 's16le',
      '-ar', String(DISCORD_SAMPLE_RATE),
      '-ac', String(DISCORD_CHANNELS),
      '-i', 'pipe:0',
      '-ar', String(TARGET_SAMPLE_RATE),
      '-ac', '1',
      '-f', 'wav',
      wavPath,
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', reject); // e.g. ffmpeg binary missing
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
    });

    pcmStream.pipe(ffmpeg.stdin);
    pcmStream.on('error', (err) => {
      ffmpeg.stdin.end();
      reject(err);
    });
  });
}

// Starts listening to a voice channel. Returns a handle with .disconnect().
// onUtterance(userId, displayName, wavPath, startMs, endMs) fires once per
// speaking turn (Discord already gives us per-user audio streams, so no ML
// diarization is needed — same trick Craig and Parley both rely on).
// mayRecord(userId) -> boolean decides whether this person is captured at all.
// Defaults to recording everyone, which is what every caller did before
// consent existed and what the tests rely on; the live path passes the real
// check. See campaign/consent.js.
export function startCapture({ channel, guildId, audioDir, getDisplayName, onUtterance, mayRecord = () => true }) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true, // the bot only ever listens — never let it appear as an open mic
  });

  // VoiceConnection is its own EventEmitter — an unhandled 'error' here
  // crashes the process the same way an unhandled Client error would.
  connection.on('error', (err) => console.error('[voice] connection error:', err.message));

  // Lightweight state-transition + close-code logging — enough to diagnose a
  // stuck/failed handshake (e.g. the WS close code, which pinpoints things
  // like DAVE/E2EE negotiation failures) without the full verbose packet
  // trace, which is noisy and briefly includes the voice session token.
  connection.on('stateChange', (oldState, newState) => {
    console.log(`[voice] state: ${oldState.status} -> ${newState.status}`);
    if (newState.networking && !newState.networking.__closeLogged) {
      newState.networking.__closeLogged = true;
      newState.networking.once('close', (code) => console.log(`[voice] networking WS closed with code: ${code}`));
    }
  });

  const receiver = connection.receiver;
  const sessionStart = Date.now();

  // Discord's per-user "speaking" flag flickers off and back on during
  // ordinary mid-sentence pauses (far shorter than our 1000ms AfterSilence
  // threshold) — so 'start' can fire again for a user who's still mid-
  // utterance. Without this guard, that second 'start' opens a second
  // overlapping subscription on the same audio, producing two WAV files
  // that both transcribe to roughly the same text (seen in practice as
  // duplicate/near-duplicate lines back-to-back in the transcript). One
  // active subscription per user at a time — the existing one keeps
  // running and will only end on genuine silence.
  const activeUsers = new Set();

  // Logged once per person per session rather than on every speaking turn,
  // which for someone talking all evening would be hundreds of lines.
  const skipped = new Set();

  receiver.speaking.on('start', async (userId) => {
    if (activeUsers.has(userId)) return;

    // The consent check, and it belongs exactly here: BEFORE subscribe().
    //
    // Subscribing is what opens an audio stream for this person — decode it
    // and it lands in a WAV on disk. Not subscribing means their packets are
    // dropped by the voice library and nothing of theirs is ever decoded,
    // written or held. Filtering later would mean recording them first and
    // deleting it afterwards, which is not the same promise at all, and not
    // the one the invitation makes.
    if (!mayRecord(userId)) {
      if (!skipped.has(userId)) {
        skipped.add(userId);
        console.log(`[voice] not recording ${userId} — no consent for this campaign`);
      }
      return;
    }

    activeUsers.add(userId);

    const startMs = Date.now() - sessionStart;
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({
      rate: DISCORD_SAMPLE_RATE,
      channels: DISCORD_CHANNELS,
      frameSize: 960,
    });

    const displayName = await getDisplayName(userId);
    const safeDir = join(audioDir, String(userId));
    await mkdir(safeDir, { recursive: true });
    const wavPath = join(safeDir, `${startMs}.wav`);

    const pcmStream = opusStream.pipe(decoder);

    try {
      await resampleToWav(pcmStream, wavPath);
      const endMs = Date.now() - sessionStart;
      if ((await wavDurationMs(wavPath)) >= MIN_UTTERANCE_MS) {
        onUtterance(userId, displayName, wavPath, startMs, endMs);
      } else {
        await unlink(wavPath).catch(() => {});
      }
    } catch (err) {
      console.error(`[capture] stream error for user ${userId}:`, err.message);
    } finally {
      activeUsers.delete(userId);
    }
  });

  return {
    connection,
    async waitUntilReady() {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    },
    disconnect() {
      connection.destroy();
    },
  };
}
