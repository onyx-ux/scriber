// Whisper invents speech in silence, and it invents the SAME things every
// time: "Thank you.", "Thanks for watching!", "Bye." — artefacts of the
// subtitle data it was trained on. Discord capture produces a lot of very
// short, very quiet clips (a mic opening, a chair moving), so this lands hard
// here.
//
// Measured on a real 3117-clip session, transcribed with large-v3-turbo:
// 478 utterances of "Thank you." — 17% of the entire transcript, none of it
// said by anyone. All of it was then fed to the summariser as dialogue.
//
// The same session on medium.en produced 62. The multilingual turbo model is
// markedly worse at this, which is the cost of the accuracy it buys elsewhere.
//
// The server's own switches do not help: suppress_nst and no_speech_thold
// were measured over 120 clips and removed exactly none of it. no_speech_prob
// is useless too — it reports ~1e-08 for these clips, i.e. whisper is certain
// the noise was speech.
//
// What does separate them is how confident whisper was about the LANGUAGE.
// Over that sample: hallucinated clips scored at most 0.899, while real
// speech sat at 0.993+ for three quarters of clips. Someone actually saying
// "thank you" scores like ordinary speech and is kept; noise that whisper
// merely rendered as "Thank you." does not.

// Exact whole-utterance matches only. A line that merely CONTAINS "thank you"
// is someone talking, and must never be touched.
const FILLER = [
  /^thank you[.!]?$/i,
  /^thanks for watching[.!]?$/i,
  /^thanks[.!]?$/i,
  /^bye[.!]?$/i,
  /^bye-bye[.!]?$/i,
  /^you[.!]?$/i,
  /^\.+$/,
];

// Below this, whisper was not even sure the audio was English.
export const LANG_CONFIDENCE_FLOOR = 0.95;
// Fallback for the CPU path, which reports no language probability. Chosen
// from the same sample: hallucinated clips ran to 2.08s, real speech had a
// median of 2.88s, so this only catches the very shortest.
export const SHORT_CLIP_SECONDS = 1.0;

// Loudness of a 16kHz mono s16le WAV — the format capture always writes.
// Used to decide whether a clip is worth prompting for; see whisper.js.
export function rmsOfWav(buffer) {
  const samples = Math.floor((buffer.length - 44) / 2);
  if (samples <= 0) return 0;

  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const v = buffer.readInt16LE(44 + i * 2) / 32768;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / samples);
}

// Sits between the two clusters measured on a real session: clips whisper
// hallucinates on averaged 0.022 RMS, real speech 0.065.
export const PROMPT_MIN_RMS = 0.03;

// Prompting is only worth doing where it can help. Measured against the live
// server on 60 real clips:
//
//   loud clips   121ms bare -> 118ms prompted   (free)
//   quiet clips   96ms bare -> 541ms prompted   (5.7x)
//
// The whole cost lands on near-silence, because without a prompt whisper
// stops early on a clip with nothing in it, and with one it generates the
// prompt back instead — which is also exactly where the prompt echoes come
// from. Skipping the prompt on quiet clips therefore keeps all of the benefit
// (real speech still gets the campaign vocabulary) while removing almost all
// of the cost AND most of the echoes.
export function worthPrompting(buffer, minRms = PROMPT_MIN_RMS) {
  return rmsOfWav(buffer) >= minRms;
}

export function isFillerPhrase(text) {
  const t = String(text || '').trim();
  return FILLER.some((re) => re.test(t));
}

// langProb: whisper's confidence the clip was the expected language. Undefined
// on the local CPU path, which does not report it — there we fall back to
// duration alone, deliberately conservatively.
export function looksLikeHallucination(text, { langProb, seconds } = {}) {
  if (!isFillerPhrase(text)) return false;

  if (typeof langProb === 'number') return langProb < LANG_CONFIDENCE_FLOOR;
  if (typeof seconds === 'number') return seconds < SHORT_CLIP_SECONDS;

  // No evidence either way: keep it. Dropping real speech is the worse error.
  return false;
}
