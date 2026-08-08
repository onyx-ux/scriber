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
