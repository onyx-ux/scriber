import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  zonedParts,
  isWeekend,
  withinAutoWindow,
  decideTranscribeAction,
  snoozeUntil,
  parseTranscribeAction,
  transcribeRequestMessage,
  reminderMessage,
  TRANSCRIBE_PREFIX,
  ACTION_NOW,
  ACTION_LATER,
  ACTION_PI,
} from '../src/pipeline/transcribe-schedule.js';

const cfg = {
  scheduleTimeZone: 'Australia/Brisbane', // UTC+10, no daylight saving
  transcribeWindowStartHour: 8,
  transcribeWindowEndHour: 16,
  transcribeWeekdaysOnly: true,
  transcribeSnoozeHours: 24,
};

// Brisbane is UTC+10, so these UTC instants are chosen to land on known local
// times. Getting this wrong is the whole risk: the container runs in UTC, so
// a naive getHours() would put "8am" at 6pm local.
const at = (utc) => new Date(utc);
const WED_10AM = at('2026-08-05T00:00:00Z'); // Wed 10:00 Brisbane
const WED_9PM = at('2026-08-05T11:00:00Z'); // Wed 21:00 Brisbane
const WED_7AM = at('2026-08-04T21:00:00Z'); // Wed 07:00 Brisbane
const SAT_10AM = at('2026-08-08T00:00:00Z'); // Sat 10:00 Brisbane
const MON_10AM = at('2026-08-10T00:00:00Z'); // Mon 10:00 Brisbane

test('local time is read in the configured zone, not the container’s UTC', () => {
  assert.deepEqual(
    { hour: zonedParts(WED_10AM, 'Australia/Brisbane').hour, weekday: zonedParts(WED_10AM, 'Australia/Brisbane').weekday },
    { hour: 10, weekday: 'Wed' },
    'midnight UTC is 10am in Brisbane — a UTC-based check would call this 0'
  );
  assert.equal(zonedParts(WED_10AM, 'UTC').hour, 0, 'same instant, different zone');
});

// The container is UTC and the person is not. This is the bug this module
// exists to prevent.
test('a UTC-naive implementation would have been wrong by ten hours', () => {
  assert.equal(withinAutoWindow(WED_10AM, cfg), true, '10am Brisbane is inside 8-16');
  assert.equal(withinAutoWindow(WED_10AM, { ...cfg, scheduleTimeZone: 'UTC' }), false, 'the same instant is midnight UTC');
});

test('the window covers working hours and excludes evenings', () => {
  assert.equal(withinAutoWindow(WED_10AM, cfg), true);
  assert.equal(withinAutoWindow(WED_7AM, cfg), false, 'an hour before the window');
  assert.equal(withinAutoWindow(WED_9PM, cfg), false, 'prime gaming time must never auto-run');
});

test('weekends are excluded when weekdays-only is set', () => {
  assert.equal(isWeekend(SAT_10AM, cfg.scheduleTimeZone), true);
  assert.equal(withinAutoWindow(SAT_10AM, cfg), false, 'Saturday 10am is in-hours but must not run');
  assert.equal(withinAutoWindow(SAT_10AM, { ...cfg, transcribeWeekdaysOnly: false }), true, 'unless configured otherwise');
  assert.equal(withinAutoWindow(MON_10AM, cfg), true);
});

test('a window that wraps past midnight still works', () => {
  const night = { ...cfg, transcribeWindowStartHour: 22, transcribeWindowEndHour: 6, transcribeWeekdaysOnly: false };
  assert.equal(withinAutoWindow(at('2026-08-05T13:00:00Z'), night), true, '23:00 local, after the start');
  assert.equal(withinAutoWindow(at('2026-08-04T16:00:00Z'), night), true, '02:00 local, the far side of midnight');
  assert.equal(withinAutoWindow(at('2026-08-04T20:00:00Z'), night), false, '06:00 local — the end hour is exclusive');
  assert.equal(withinAutoWindow(WED_10AM, night), false, '10am is outside a 22-06 window');
});

// --- the decision the worker acts on ---

const job = (over = {}) => ({
  id: 1,
  status: 'awaiting_approval',
  next_attempt_at: '2026-08-01T00:00:00.000Z',
  notified_at: null,
  ...over,
});

test('an approved job runs whenever the PC answers, even at 9pm', () => {
  const d = decideTranscribeAction({ job: job({ status: 'pending' }), now: WED_9PM, serverReachable: true, cfg });
  assert.equal(d.action, 'run');
  assert.equal(d.reason, 'approved', 'an explicit yes overrides the window — that is the point of the button');
});

test('an un-approved job runs inside the window without being asked', () => {
  const d = decideTranscribeAction({ job: job(), now: WED_10AM, serverReachable: true, cfg });
  assert.equal(d.action, 'run');
  assert.equal(d.reason, 'auto-window');
});

// THE case the whole feature exists for.
test('an un-approved job never runs outside the window', () => {
  const d = decideTranscribeAction({ job: job({ notified_at: WED_9PM.toISOString() }), now: WED_9PM, serverReachable: true, cfg });
  assert.notEqual(d.action, 'run', 'must not seize the GPU on a weeknight evening');
});

test('nothing runs on a weekend unless approved by hand', () => {
  const auto = decideTranscribeAction({ job: job({ notified_at: SAT_10AM.toISOString() }), now: SAT_10AM, serverReachable: true, cfg });
  assert.notEqual(auto.action, 'run');

  const approved = decideTranscribeAction({ job: job({ status: 'pending' }), now: SAT_10AM, serverReachable: true, cfg });
  assert.equal(approved.action, 'run', 'the button still works on a Saturday');
});

// Waiting for the PC is the agreed behaviour — never quietly divert to the Pi.
test('an unreachable PC waits rather than falling back to the Pi', () => {
  const d = decideTranscribeAction({ job: job({ status: 'pending' }), now: WED_10AM, serverReachable: false, cfg });
  assert.equal(d.action, 'wait');
  assert.equal(d.reason, 'pc-unreachable');
});

test('a snoozed job is suppressed even inside the window', () => {
  const snoozed = job({ next_attempt_at: new Date(WED_10AM.getTime() + 3600_000).toISOString() });
  const d = decideTranscribeAction({ job: snoozed, now: WED_10AM, serverReachable: true, cfg });
  assert.equal(d.action, 'wait');
  assert.equal(d.reason, 'snoozed', '"remind me tomorrow" has to mean the window too, or it is not a snooze');
});

test('a snoozed job becomes eligible again once its time passes', () => {
  const expired = job({ next_attempt_at: new Date(WED_10AM.getTime() - 1000).toISOString() });
  assert.equal(decideTranscribeAction({ job: expired, now: WED_10AM, serverReachable: true, cfg }).action, 'run');
});

// --- reminders ---

test('a never-notified job outside the window gets one nudge', () => {
  const d = decideTranscribeAction({ job: job(), now: WED_9PM, serverReachable: true, cfg });
  assert.equal(d.action, 'remind');
});

test('reminders are rate-limited to one per snooze period, not one per tick', () => {
  const justTold = job({ notified_at: new Date(WED_9PM.getTime() - 60_000).toISOString() });
  assert.equal(decideTranscribeAction({ job: justTold, now: WED_9PM, serverReachable: true, cfg }).action, 'wait');

  const toldYesterday = job({ notified_at: new Date(WED_9PM.getTime() - 25 * 3600_000).toISOString() });
  assert.equal(decideTranscribeAction({ job: toldYesterday, now: WED_9PM, serverReachable: true, cfg }).action, 'remind');
});

test('a weekend nudge is labelled as such, so "why is nothing happening" is answerable', () => {
  const d = decideTranscribeAction({ job: job(), now: SAT_10AM, serverReachable: true, cfg });
  assert.equal(d.action, 'remind');
  assert.equal(d.reason, 'weekend');
});

test('snoozeUntil moves by the configured hours', () => {
  const until = snoozeUntil(WED_10AM, cfg);
  assert.equal(until.getTime() - WED_10AM.getTime(), 24 * 3600_000);
});

// --- the buttons already sitting in scrollback ---
//
// The bot no longer SENDS these — scheduling moved to the dashboard — but
// every DM it has already delivered still carries them, so the parser has to
// keep recognising them. They are answered with a pointer to the dashboard
// rather than left to fail silently, and that answer depends on this still
// telling a transcribe button apart from anything else.

test('button ids round-trip and reject anything foreign', () => {
  for (const action of [ACTION_NOW, ACTION_LATER, ACTION_PI]) {
    assert.deepEqual(parseTranscribeAction(`${TRANSCRIBE_PREFIX}7:${action}`), { jobId: 7, action });
  }
  assert.equal(parseTranscribeAction('scriber:approve:7'), null, "another feature's button");
  assert.equal(parseTranscribeAction(`${TRANSCRIBE_PREFIX}7:destroy`), null);
  assert.equal(parseTranscribeAction(`${TRANSCRIBE_PREFIX}abc:now`), null);
  assert.equal(parseTranscribeAction(undefined), null);
});

// --- what the owner actually reads ---

test('the request explains when it will run on its own', () => {
  const text = transcribeRequestMessage({ meetingId: 12, utteranceCount: 800, now: WED_9PM, cfg, serverReachable: true });
  assert.match(text, /#12/);
  assert.match(text, /800 clips/);
  assert.match(text, /weekdays 08:00–16:00/, 'the automatic window is stated, not implied');
  assert.match(text, /Australia\/Brisbane/, 'in a named zone, since the whole point is which clock is meant');
});

test('a weekend request says why the automatic window will not help', () => {
  const text = transcribeRequestMessage({ meetingId: 12, utteranceCount: 10, now: SAT_10AM, cfg, serverReachable: true });
  assert.match(text, /weekend/i);
});

test('an unreachable PC is disclosed up front rather than looking like a hang', () => {
  const text = transcribeRequestMessage({ meetingId: 12, utteranceCount: 10, now: WED_9PM, cfg, serverReachable: false });
  assert.match(text, /isn't answering/i);
});

test('the reminder says how long it has been waiting', () => {
  const text = reminderMessage({
    meetingId: 12,
    waitingSinceIso: new Date(WED_9PM.getTime() - 3 * 86_400_000).toISOString(),
    cfg,
    now: WED_9PM,
  });
  assert.match(text, /3 days/);
  assert.match(text, /#12/);
});

// --- diverting to the cloud when the PC is off ---
//
// The rule this changes is "never quietly divert", which was written about
// the Pi: hours of unattended CPU for a worse transcript is not worth doing
// on somebody's behalf. Gemini is minutes for a transcript that is no worse,
// and GEMINI_TRANSCRIBE is the operator having already said yes to exactly
// this situation — so it diverts, and only it does.

const CLOUD_ON = { ...cfg, geminiTranscribe: true, geminiApiKey: 'gm-test' };

test('with the cloud off, an unreachable PC still waits', () => {
  const d = decideTranscribeAction({ job: job({ status: 'pending' }), now: WED_10AM, serverReachable: false, cfg });
  assert.equal(d.action, 'wait');
  assert.equal(d.via, undefined);
});

test('with the cloud on, an unreachable PC diverts instead of waiting', () => {
  const d = decideTranscribeAction({
    job: job({ status: 'pending' }),
    now: WED_10AM,
    serverReachable: false,
    cfg: CLOUD_ON,
  });
  assert.equal(d.action, 'run');
  assert.equal(d.via, 'gemini');
  assert.match(d.reason, /gemini/);
});

test('a switch without a key diverts nowhere', () => {
  const d = decideTranscribeAction({
    job: job({ status: 'pending' }),
    now: WED_10AM,
    serverReachable: false,
    cfg: { ...CLOUD_ON, geminiApiKey: null },
  });
  assert.equal(d.action, 'wait');
});

// The important limit. Turning the cloud on buys a faster answer to "the PC
// is off" — it does not buy permission to transcribe a session nobody has
// approved, at a time nobody chose, and bill for it.
test('the cloud does not let a session past the approval or window gates', () => {
  const unapprovedAtNight = decideTranscribeAction({
    job: job({ notified_at: WED_9PM.toISOString() }),
    now: WED_9PM,
    serverReachable: false,
    cfg: CLOUD_ON,
  });
  assert.notEqual(unapprovedAtNight.action, 'run', 'outside the window is still outside the window');

  const snoozed = job({ status: 'pending', next_attempt_at: '2999-01-01T00:00:00Z' });
  assert.equal(
    decideTranscribeAction({ job: snoozed, now: WED_10AM, serverReachable: false, cfg: CLOUD_ON }).action,
    'wait',
    '"remind me tomorrow" means tomorrow, whichever engine would do the work'
  );
});

test('a reachable PC is never diverted away from', () => {
  const d = decideTranscribeAction({
    job: job({ status: 'pending' }),
    now: WED_10AM,
    serverReachable: true,
    cfg: CLOUD_ON,
  });
  assert.equal(d.action, 'run');
  assert.equal(d.via, undefined, 'the GPU is faster, free, and keeps the audio at home');
});
