import { readKnownEntityNames } from '../campaign/ledger.js';
import { campaignFolder } from '../export/naming.js';

// Whisper accepts a text prompt that conditions the decoder as though it were
// the transcript immediately preceding the audio. Feeding it the campaign's
// proper nouns makes it far likelier to spell them correctly, because the
// failure it makes on "Kaelen" is not a hearing problem — it is that
// "Kaylen"/"Kaelin"/"Caelan" are all plausible English and the model has no
// reason to prefer one. Naming them removes the ambiguity at inference time.
//
// This attacks the same problem /correct exists to clean up afterwards, which
// is why corrections are the highest-priority terms here: they are the exact
// words this campaign has already proved whisper gets wrong.
//
// TODO: campaign vocabulary is currently per-guild, derived from the ledger,
// the character table and the corrections list. A future per-user/per-server
// setup could let a DM curate this list directly — pinning names that have
// not been mentioned yet (a villain introduced next session), weighting
// recurring NPCs above one-off ones, or sharing a vocabulary across several
// servers running the same campaign. The builder below is already pure and
// takes plain arrays, so that would be a new source feeding buildWhisperPrompt
// rather than a change to it.

// Whisper's prompt window is 224 tokens; past that the model silently drops
// the beginning, so a longer list would quietly lose its highest-priority
// terms. ~4 chars per token, kept conservative because names tokenise worse
// than ordinary English.
export const PROMPT_MAX_CHARS = 720;

const LEAD_IN = 'A Dungeons & Dragons session.';

// Single letters and very short strings are almost never the proper nouns
// this is for, and they collide with ordinary words — biasing toward them
// costs budget and risks dragging unrelated speech toward the term.
const MIN_TERM_CHARS = 3;

function addTerms(into, seen, terms) {
  for (const raw of terms) {
    const term = String(raw || '').trim();
    if (term.length < MIN_TERM_CHARS) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    into.push(term);
  }
}

// Ordered most- to least-valuable, because the budget cuts from the end.
export function selectVocabulary({ corrections = [], characters = [], npcs = [], locations = [] } = {}) {
  const terms = [];
  const seen = new Set();

  // Proven failures first — these are words whisper demonstrably mishears in
  // THIS campaign, so they buy more than a name it may already get right.
  addTerms(terms, seen, corrections.map((c) => c.correct_text ?? c));
  // Player characters are said constantly, every session.
  addTerms(terms, seen, characters.map((c) => c.character_name ?? c));
  // Ledger entries are appended over time, so the tail is the most recent —
  // and recent NPCs are likelier to come up than ones from session one.
  addTerms(terms, seen, [...npcs].reverse());
  addTerms(terms, seen, [...locations].reverse());

  return terms;
}

// Truncates at term boundaries, never mid-name: half a name in the prompt
// biases toward a word that does not exist.
export function buildWhisperPrompt(sources, { maxChars = PROMPT_MAX_CHARS } = {}) {
  const terms = selectVocabulary(sources);
  if (terms.length === 0) return '';

  const kept = [];
  let length = LEAD_IN.length + 1; // the space before the first term
  for (const term of terms) {
    const cost = term.length + 2; // ", " or the trailing "."
    if (length + cost > maxChars) break;
    kept.push(term);
    length += cost;
  }

  if (kept.length === 0) return '';
  return `${LEAD_IN} ${kept.join(', ')}.`;
}

// The terms that went into a prompt, recovered from the prompt itself so the
// echo guard below doesn't need them threaded separately through the pipeline.
export function promptTerms(prompt) {
  if (!prompt) return [];
  return prompt
    .slice(LEAD_IN.length)
    .replace(/\.$/, '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

// Prompting has a known cost: on near-silent audio whisper will happily
// transcribe the PROMPT instead of the sound. Measured against this very
// server — 5s of low noise returned "." unprompted, and "Kaelen Zyrthax,
// Thoram." once the campaign vocabulary was supplied. Left alone that puts
// invented dialogue in the transcript and feeds it to the summariser.
//
// A clip is treated as an echo only when it is made ENTIRELY of prompt
// vocabulary and mentions at least two of those terms. One name on its own
// stays — "Kaelen!" is a perfectly ordinary thing to shout at a table, and
// dropping real speech is worse than keeping a rare fabrication.
export function looksLikePromptEcho(text, terms) {
  if (!text || terms.length === 0) return false;

  const vocabulary = new Set();
  for (const term of terms) {
    for (const word of term.toLowerCase().split(/\s+/)) vocabulary.add(word);
  }

  // Matched loosely on purpose. An echo is rarely verbatim — the live server
  // returned "Kaelen Zyrthax, Thoras, Thoras, Thoras." for a prompt naming
  // "Thora Ironfist", so an exact-word test misses the very case this exists
  // to catch. Short names must still match exactly, or "Vex" would swallow
  // "vexing", "vexed" and anything else beginning with those letters.
  const STEM_CHARS = 4;
  const isVocabulary = (word) => {
    if (vocabulary.has(word)) return true;
    for (const known of vocabulary) {
      if (known.length < STEM_CHARS || word.length < STEM_CHARS) continue;
      if (word.startsWith(known) || known.startsWith(word)) return true;
    }
    return false;
  };

  const words = text.toLowerCase().match(/[\p{L}\p{N}’']+/gu) || [];
  if (words.length === 0) return false;
  if (!words.every(isVocabulary)) return false;

  const matched = new Set(terms.filter((t) => words.some((w) => isVocabulary(w) && stemsMatch(w, t))));
  return matched.size >= 2;
}

function stemsMatch(word, term) {
  const head = term.toLowerCase().split(/\s+/)[0];
  return word === head || (head.length >= 4 && word.length >= 4 && (word.startsWith(head) || head.startsWith(word)));
}

// Gathers this campaign's vocabulary. Guild-scoped: two campaigns on one bot
// must not bleed names into each other's transcripts.
export async function campaignPrompt(db, cfg, meeting) {
  if (!cfg.whisperPrompt) return '';

  try {
    const folder = campaignFolder(meeting, db.getCampaignName(meeting.guild_id));
    const { npcs, locations } = await readKnownEntityNames(cfg, folder);
    return buildWhisperPrompt({
      corrections: db.listCorrections(meeting.guild_id),
      characters: db.listCharacters(meeting.guild_id),
      npcs,
      locations,
    });
  } catch (err) {
    // A prompt is an optimisation. Losing it must never cost a transcript.
    console.warn(`[whisper] could not build vocabulary prompt: ${err.message}`);
    return '';
  }
}
