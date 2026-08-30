import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ButtonStyle } from 'discord.js';

import {
  applyTranscribeTarget,
  choiceAvailable,
  parseTranscribeChoice,
  buildTranscribeChoiceRow,
  defaultTarget,
  transcribeChoicePrompt,
  transcribeChosenNote,
  isValidTarget,
  TARGET_PC,
  TARGET_PI,
  TARGET_GEMINI,
  TRANSCRIBE_PREFIX,
} from '../src/pipeline/transcribe-target.js';

// Note there is a key here but GEMINI_TRANSCRIBE is not set: a key alone is
// the summariser's, and must not put the cloud on the transcription menu.
const cfg = {
  whisperServerUrl: 'http://192.168.0.153:8089',
  summaryProvider: 'gemini',
  geminiApiKey: 'gm-test',
};

const geminiCfg = { ...cfg, geminiTranscribe: true };

test('choosing the PC changes nothing — it is the configured path', () => {
  assert.equal(applyTranscribeTarget(cfg, TARGET_PC), cfg);
});

test('choosing the Pi pins transcription to the local CPU', () => {
  const run = applyTranscribeTarget(cfg, TARGET_PI);
  assert.equal(run.whisperServerUrl, null, 'a server URL left set would send the audio back to the PC');
});

// This used to also switch the summariser, because the local summariser lived
// on the same PC as the GPU. With summarising in the cloud it is independent
// of which machine transcribed, and quietly changing it would be surprising.
test('choosing the Pi does not change who summarises', () => {
  assert.equal(applyTranscribeTarget(cfg, TARGET_PI).summaryProvider, 'gemini');
  assert.equal(applyTranscribeTarget(cfg, TARGET_PC).summaryProvider, 'gemini');
});

test('the shared config is never mutated by a choice', () => {
  const original = { ...cfg };
  applyTranscribeTarget(cfg, TARGET_PI);
  assert.deepEqual(cfg, original, "one session's choice must not leak into the next");
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
  const row = buildTranscribeChoiceRow(999_999_999, geminiCfg, { serverReachable: true });
  for (const button of row.components) {
    assert.ok(button.data.custom_id.length <= 100, button.data.custom_id);
  }
});

test('an unreachable PC is offered as disabled rather than silently missing', () => {
  const row = buildTranscribeChoiceRow(1, cfg, { serverReachable: false });
  const pc = row.components.find((b) => b.data.custom_id.endsWith(TARGET_PC));
  assert.equal(pc.data.disabled, true, 'a button that cannot work must not look like it can');

  const pi = row.components.find((b) => b.data.custom_id.endsWith(TARGET_PI));
  assert.notEqual(pi.data.disabled, true, 'the Pi is still a real option when the PC is off');
});

test('the prompt states the time cost, which is the whole decision', () => {
  const text = transcribeChoicePrompt(cfg, { serverReachable: true });
  assert.match(text, /minutes/, 'the fast option says how fast');
  assert.match(text, /hours/, 'the slow option says how slow');
});

test('the prompt does not advertise a PC that is not answering', () => {
  assert.match(transcribeChoicePrompt(cfg, { serverReachable: false }), /not answering/);
});

test('the confirmation names where it ran', () => {
  assert.match(transcribeChosenNote(cfg, TARGET_PI), /Pi/);
  assert.match(transcribeChosenNote(cfg, TARGET_PC), /PC/);
});

// --- the cloud rung ---
//
// Everything below is about one property: the option that sends the table's
// recording off the network is never reached for on anybody's behalf.

test('the cloud is not on the menu unless it was deliberately turned on', () => {
  const row = buildTranscribeChoiceRow(1, cfg, { serverReachable: false });
  assert.equal(
    row.components.find((b) => b.data.custom_id.endsWith(TARGET_GEMINI)),
    undefined,
    'a summariser key alone must not offer to send audio to Google'
  );
  assert.doesNotMatch(transcribeChoicePrompt(cfg, { serverReachable: false }), /Gemini/);
});

test('turned on, the cloud is offered — and says what it costs', () => {
  const row = buildTranscribeChoiceRow(1, geminiCfg, { serverReachable: false });
  const gemini = row.components.find((b) => b.data.custom_id.endsWith(TARGET_GEMINI));
  assert.ok(gemini, 'the whole point of the setting is that the button appears');

  const text = transcribeChoicePrompt(geminiCfg, { serverReachable: false });
  assert.match(text, /Gemini/);
  assert.match(text, /Google/, 'somebody choosing this should not have to read the README to know');
  assert.match(transcribeChosenNote(geminiCfg, TARGET_GEMINI), /Google/);
});

// The button ordering is load-bearing rather than cosmetic: the cloud is the
// only option that leaves the house, so it must never be the one styled as
// the obvious answer, even when the PC is the one that cannot work.
test('the cloud is never the recommended-looking button', () => {
  const SUCCESS = ButtonStyle.Success;
  for (const serverReachable of [true, false]) {
    const row = buildTranscribeChoiceRow(1, geminiCfg, { serverReachable });
    const gemini = row.components.find((b) => b.data.custom_id.endsWith(TARGET_GEMINI));
    assert.notEqual(
      gemini.data.style,
      SUCCESS,
      'the green button is the one that keeps the recording at home, in both states'
    );
    assert.notEqual(gemini.data.disabled, true, 'it is still a real option — just not the advertised one');
  }

  // And the PC keeps it when it can actually work.
  const up = buildTranscribeChoiceRow(1, geminiCfg, { serverReachable: true });
  assert.equal(up.components.find((b) => b.data.custom_id.endsWith(TARGET_PC)).data.style, SUCCESS);
});

test('nobody pressing anything still falls to the Pi, not the cloud', () => {
  assert.equal(
    defaultTarget({ serverReachable: false }),
    TARGET_PI,
    'a recording must not leave the network because the prompt scrolled off screen'
  );
});

test('choosing the cloud pins it, without disturbing the server URL', () => {
  const run = applyTranscribeTarget(geminiCfg, TARGET_GEMINI);
  assert.equal(run.transcribeVia, TARGET_GEMINI);
  assert.equal(run.whisperServerUrl, geminiCfg.whisperServerUrl, 'the PC is still where a later job goes');
});

// With the cloud on, a null server URL is what the automatic ladder reads as
// "use Gemini" — so pinning the Pi has to say so explicitly, or "not the PC"
// would quietly become "the internet".
test('choosing the Pi means the Pi, even with the cloud available', () => {
  const run = applyTranscribeTarget(geminiCfg, TARGET_PI);
  assert.equal(run.transcribeVia, TARGET_PI);
  assert.equal(run.whisperServerUrl, null);
});

test('the cloud makes a choice worth offering even with no GPU server', () => {
  assert.equal(choiceAvailable({ whisperServerUrl: null }), false);
  assert.equal(choiceAvailable({ whisperServerUrl: null, geminiTranscribe: true, geminiApiKey: 'k' }), true);
});

test('the cloud button id round-trips', () => {
  assert.deepEqual(parseTranscribeChoice(`${TRANSCRIBE_PREFIX}42:${TARGET_GEMINI}`), {
    meetingId: 42,
    target: TARGET_GEMINI,
  });
});
