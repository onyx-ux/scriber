import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTranscribeTarget,
  targetSummary,
  choiceAvailable,
  parseTranscribeChoice,
  buildTranscribeChoiceRow,
  defaultTarget,
  transcribeChoicePrompt,
  transcribeChosenNote,
  isValidTarget,
  TARGET_PC,
  TARGET_PI,
  TRANSCRIBE_PREFIX,
} from '../src/pipeline/transcribe-target.js';

const cfg = {
  whisperServerUrl: 'http://192.168.0.153:8089',
  summaryProvider: 'ollama',
  geminiApiKey: 'gm-test',
};

test('choosing the PC changes nothing — it is the configured path', () => {
  assert.equal(applyTranscribeTarget(cfg, TARGET_PC), cfg);
});

// The whole point of the coupling: transcribing on the Pi means the PC is
// off, and Ollama lives on that PC.
test('choosing the Pi pins transcription local AND moves the summary off Ollama', () => {
  const run = applyTranscribeTarget(cfg, TARGET_PI);
  assert.equal(run.whisperServerUrl, null, 'a server URL left set would send audio back to the PC');
  assert.equal(run.summaryProvider, 'gemini', 'Ollama needs the PC that was just declared off');
});

test('the shared config is never mutated by a choice', () => {
  const original = { ...cfg };
  applyTranscribeTarget(cfg, TARGET_PI);
  assert.deepEqual(cfg, original, "one session's choice must not leak into the next");
});

// Switching to a provider with no credentials would turn a merely-delayed job
// into one that can never succeed.
test('without a Gemini key the summariser is left alone', () => {
  const noKey = { ...cfg, geminiApiKey: null };
  const run = applyTranscribeTarget(noKey, TARGET_PI);
  assert.equal(run.whisperServerUrl, null, 'transcription still moves to the Pi');
  assert.equal(run.summaryProvider, 'ollama', 'a delayed job beats an impossible one');
});

test('a Gemini-configured setup reports no switch, because there is none', () => {
  const already = { ...cfg, summaryProvider: 'gemini' };
  assert.equal(targetSummary(already, TARGET_PI).providerSwitched, false);
  assert.equal(targetSummary(cfg, TARGET_PI).providerSwitched, true);
  assert.equal(targetSummary(cfg, TARGET_PC).providerSwitched, false);
});

test('there is nothing to ask when no GPU server is configured', () => {
  assert.equal(choiceAvailable({ whisperServerUrl: null }), false);
  assert.equal(choiceAvailable(cfg), true);
});

// Nobody pressing a button must not strand a recorded session.
test('the default follows whichever machine can actually do the work', () => {
  assert.equal(defaultTarget({ serverReachable: true }), TARGET_PC);
  assert.equal(defaultTarget({ serverReachable: false }), TARGET_PI);
});

test('button ids round-trip', () => {
  for (const target of [TARGET_PC, TARGET_PI]) {
    assert.deepEqual(parseTranscribeChoice(`${TRANSCRIBE_PREFIX}42:${target}`), { meetingId: 42, target });
  }
});

test('foreign or malformed button ids are rejected, not guessed at', () => {
  assert.equal(parseTranscribeChoice('scriber:approve:42'), null, 'another feature’s button');
  assert.equal(parseTranscribeChoice(`${TRANSCRIBE_PREFIX}42:laptop`), null, 'unknown target');
  assert.equal(parseTranscribeChoice(`${TRANSCRIBE_PREFIX}abc:pc`), null, 'non-numeric meeting');
  assert.equal(parseTranscribeChoice(undefined), null);
  assert.equal(isValidTarget('gpu'), false);
});

// Discord rejects a custom_id over 100 characters, which would break the
// prompt only for large meeting ids — i.e. much later, in production.
test('button ids stay inside Discord’s 100-character limit', () => {
  const row = buildTranscribeChoiceRow(999_999_999, { serverReachable: true });
  for (const button of row.components) {
    assert.ok(button.data.custom_id.length <= 100, button.data.custom_id);
  }
});

test('an unreachable PC is offered as disabled rather than silently missing', () => {
  const row = buildTranscribeChoiceRow(1, { serverReachable: false });
  const pc = row.components.find((b) => b.data.custom_id.endsWith(TARGET_PC));
  assert.equal(pc.data.disabled, true, 'a button that cannot work must not look like it can');

  const pi = row.components.find((b) => b.data.custom_id.endsWith(TARGET_PI));
  assert.notEqual(pi.data.disabled, true, 'the Pi is still a real option when the PC is off');
});

test('the prompt states the time cost and the summariser consequence', () => {
  const text = transcribeChoicePrompt(cfg, { serverReachable: true });
  assert.match(text, /minutes/, 'the fast option says how fast');
  assert.match(text, /hours/, 'the slow option says how slow — this is the whole decision');
  assert.match(text, /Gemini/, 'the summariser switch is disclosed before choosing, not after');
});

test('the prompt does not advertise a PC that is not answering', () => {
  assert.match(transcribeChoicePrompt(cfg, { serverReachable: false }), /not answering/);
});

test('the confirmation names where it ran and what will summarise it', () => {
  assert.match(transcribeChosenNote(cfg, TARGET_PI), /Pi/);
  assert.match(transcribeChosenNote(cfg, TARGET_PI), /Gemini/);
  assert.match(transcribeChosenNote(cfg, TARGET_PC), /PC/);
  assert.match(transcribeChosenNote(cfg, TARGET_PC), /Ollama/);
});
