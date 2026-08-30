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

// How many terms Gemini's custom_vocabulary is given.
//
// That API takes a LIST rather than a decoder prefix, so it has no 224-token
// window to fit inside and PROMPT_MAX_CHARS does not apply — it accepts up to
// 1000 terms. Google's guidance is that results are typically best around
// 100, so this sits between the two: comfortably more of the campaign than
// whisper could ever be told, without diluting the bias across every name the
// ledger has ever recorded.
export const VOCABULARY_MAX_TERMS = 250;

async function gatherSources(db, cfg, meeting) {
  const campaignId = meeting?.campaign_id;
  if (!campaignId) return null;
  const folder = campaignFolder(meeting, db.getCampaignName(campaignId));
  const { npcs, locations } = await readKnownEntityNames(cfg, folder);
  return {
    corrections: db.listCorrections(campaignId),
    characters: db.listCharacters(campaignId),
    npcs,
    locations,
  };
}

// Gathers this campaign's vocabulary, in both the forms the two engines want.
//
//   prompt — whisper's decoder prefix, packed into PROMPT_MAX_CHARS.
//   terms  — the ordered list, for Gemini's custom_vocabulary.
//
// Built together from ONE read of the ledger, because which engine will
// actually transcribe the session is not decided until the GPU server has
// been probed (see pipeline/transcribe.js), and reading the vault twice to
// find out would be the same work for the same answer.
//
// Campaign-scoped, not server-scoped: two tables in one Discord must not
// bleed names into each other's transcripts, and biasing a recogniser toward
// the wrong campaign's proper nouns is worse than no vocabulary at all — it
// invents the other game's NPCs into this one.
export async function campaignVocabulary(db, cfg, meeting, { maxTerms = VOCABULARY_MAX_TERMS } = {}) {
  const nothing = { prompt: '', terms: [] };
  if (!cfg.whisperPrompt) return nothing;

  try {
    const sources = await gatherSources(db, cfg, meeting);
    if (!sources) return nothing;
    return {
      prompt: buildWhisperPrompt(sources),
      terms: selectVocabulary(sources).slice(0, maxTerms),
    };
  } catch (err) {
    // A vocabulary is an optimisation. Losing it must never cost a transcript.
    console.warn(`[stt] could not build campaign vocabulary: ${err.message}`);
    return nothing;
  }
}

export async function campaignPrompt(db, cfg, meeting) {
  return (await campaignVocabulary(db, cfg, meeting)).prompt;
}
