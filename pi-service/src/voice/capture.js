import { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import prism from 'prism-media';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_CHANNELS = 2;
const TARGET_SAMPLE_RATE = 16000; // what whisper.cpp expects
const DECIMATION = DISCORD_SAMPLE_RATE / TARGET_SAMPLE_RATE; // 3

function writeWavHeader(stream, dataLength) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(TARGET_SAMPLE_RATE, 24);
  header.writeUInt32LE(TARGET_SAMPLE_RATE * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  stream.write(header);
}

// Naive stereo-48kHz -> mono-16kHz downsample: averages the two channels,
// then takes every 3rd sample. This is NOT a proper anti-aliased resampler —
// it's good enough for speech-to-text (which doesn't need audiophile
// quality) but will alias slightly on sibilant sounds. If transcription
// accuracy on real sessions seems off, swapping in a real resampler
// (e.g. a small WASM library) here is the first thing to try.
function downsampleFrame(stereoBuf) {
  const inSamples = stereoBuf.length / 4; // 2 channels * 2 bytes
  const outSamples = Math.floor(inSamples / DECIMATION);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcIdx = i * DECIMATION * 4;
    const left = stereoBuf.readInt16LE(srcIdx);
    const right = stereoBuf.readInt16LE(srcIdx + 2);
    const mono = Math.round((left + right) / 2);
    out.writeInt16LE(mono, i * 2);
  }
  return out;
}

// Starts listening to a voice channel. Returns a handle with .disconnect().
// onUtterance(userId, displayName, wavPath, startMs, endMs) fires once per
// speaking turn (Discord already gives us per-user audio streams, so no ML
// diarization is needed — same trick Craig and Parley both rely on).
export function startCapture({ channel, guildId, audioDir, getDisplayName, onUtterance }) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  const receiver = connection.receiver;
  const sessionStart = Date.now();

  receiver.speaking.on('start', async (userId) => {
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

    const fileStream = createWriteStream(wavPath);
    let dataLength = 0;
    let headerWritten = false;

    const pcmStream = opusStream.pipe(decoder);

    pcmStream.on('data', (chunk) => {
      if (!headerWritten) {
        // placeholder header, patched with real length in 'end' below
        writeWavHeader(fileStream, 0);
        headerWritten = true;
      }
      const mono16k = downsampleFrame(chunk);
      dataLength += mono16k.length;
      fileStream.write(mono16k);
    });

    pcmStream.on('end', () => {
      fileStream.end(() => {
        // patch the header with the real data length now that we know it
        patchWavLength(wavPath, dataLength);
        const endMs = Date.now() - sessionStart;
        if (dataLength > 0) {
          onUtterance(userId, displayName, wavPath, startMs, endMs);
        }
      });
    });

    pcmStream.on('error', (err) => {
      console.error(`[capture] stream error for user ${userId}:`, err.message);
      fileStream.end();
    });
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

function patchWavLength(wavPath, dataLength) {
  // Reopen and patch bytes 4 (RIFF size) and 40 (data size) rather than
  // buffering the whole file in memory — sessions can run for hours.
  import('node:fs').then(({ openSync, writeSync, closeSync }) => {
    const fd = openSync(wavPath, 'r+');
    const riffSize = Buffer.alloc(4);
    riffSize.writeUInt32LE(36 + dataLength, 0);
    writeSync(fd, riffSize, 0, 4, 4);
    const dataSize = Buffer.alloc(4);
    dataSize.writeUInt32LE(dataLength, 0);
    writeSync(fd, dataSize, 0, 4, 40);
    closeSync(fd);
  });
}
