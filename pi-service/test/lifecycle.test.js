import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { installProcessGuards } from '../src/lifecycle.js';

// A stand-in for `process`: the same event surface, with exit recorded rather
// than taken. Running these against the real process would end the test run on
// the first assertion.
function fakeProc() {
  const proc = new EventEmitter();
  proc.exits = [];
  proc.exit = (code) => proc.exits.push(code);
  proc.off = proc.removeListener.bind(proc);
  return proc;
}

const quietLog = () => {
  const lines = [];
  const push = (kind) => (...a) => lines.push([kind, a.map(String).join(' ')]);
  return { lines, log: push('log'), warn: push('warn'), error: push('error') };
};

const settle = () => new Promise((r) => setTimeout(r, 5));

// THE one that used to take the bot down. Node terminates on an unhandled
// rejection by default, so a Discord edit on a deleted message could end a
// recording — and leave nothing in the log to say so.
test('an unhandled rejection is loud but does not kill the bot', async () => {
  const proc = fakeProc();
  const log = quietLog();
  installProcessGuards({ proc, log });

  proc.emit('unhandledRejection', new Error('a DM to a closed inbox'));
  await settle();

  assert.deepEqual(proc.exits, [], 'staying up is the whole point — the recording is mid-flight');
  const shouted = log.lines.find(([kind, text]) => kind === 'error' && /UNHANDLED REJECTION/.test(text));
  assert.ok(shouted, 'if it does not kill the bot it had better be impossible to miss');
  assert.match(shouted[1], /closed inbox/, 'the reason has to survive, or this is no better than dying silently');
});

test('a rejection that is not an Error still reports something usable', async () => {
  const proc = fakeProc();
  const log = quietLog();
  installProcessGuards({ proc, log });

  proc.emit('unhandledRejection', 'just a string');
  await settle();

  assert.deepEqual(proc.exits, []);
  assert.ok(log.lines.some(([, t]) => /just a string/.test(t)));
});

// The opposite case, and deliberately so: the stack it happened on is gone,
// so carrying on risks writing unknown state to the database.
test('an uncaught exception exits non-zero so Docker restarts it', async () => {
  const proc = fakeProc();
  const log = quietLog();
  installProcessGuards({ proc, log });

  proc.emit('uncaughtException', new Error('broken beyond this frame'));
  await settle();

  assert.deepEqual(proc.exits, [1], 'a non-zero exit is what the restart policy acts on');
  assert.ok(log.lines.some(([kind, t]) => kind === 'error' && /UNCAUGHT EXCEPTION/.test(t)));
});

test('SIGTERM closes what it was given, then exits cleanly', async () => {
  const proc = fakeProc();
  const closed = [];
  installProcessGuards({
    proc,
    log: quietLog(),
    onShutdown: async (signal) => {
      closed.push(signal);
    },
  });

  proc.emit('SIGTERM');
  await settle();

  assert.deepEqual(closed, ['SIGTERM'], 'the close path has to actually run');
  assert.deepEqual(proc.exits, [0], 'a stop we were asked for is not a failure');
});

test('SIGINT is handled too, for a foreground run', async () => {
  const proc = fakeProc();
  const closed = [];
  installProcessGuards({ proc, log: quietLog(), onShutdown: async (s) => closed.push(s) });

  proc.emit('SIGINT');
  await settle();

  assert.deepEqual(closed, ['SIGINT']);
  assert.deepEqual(proc.exits, [0]);
});

// docker sends SIGTERM to everything in the container, and impatient operators
// send it twice. Closing the database twice is not harmless.
test('a second signal does not run the close path again', async () => {
  const proc = fakeProc();
  let runs = 0;
  installProcessGuards({ proc, log: quietLog(), onShutdown: async () => { runs += 1; } });

  proc.emit('SIGTERM');
  proc.emit('SIGTERM');
  proc.emit('SIGINT');
  await settle();

  assert.equal(runs, 1, 'double-closing the database is the thing this prevents');
});

// A tidy stop that hangs is worse than an abrupt one: Docker's SIGKILL lands
// ten seconds after SIGTERM either way, and an exit we chose keeps the
// database's own close path in charge.
test('a shutdown that hangs still exits inside the grace period', async () => {
  const proc = fakeProc();
  const log = quietLog();
  installProcessGuards({
    proc,
    log,
    graceMs: 30,
    onShutdown: () => new Promise(() => {}), // never resolves
  });

  proc.emit('SIGTERM');
  await new Promise((r) => setTimeout(r, 80));

  assert.deepEqual(proc.exits, [0], 'it has to leave under its own power before SIGKILL arrives');
  assert.ok(log.lines.some(([kind, t]) => kind === 'warn' && /did not finish/.test(t)));
});

test('a close path that throws still exits rather than hanging', async () => {
  const proc = fakeProc();
  const log = quietLog();
  installProcessGuards({
    proc,
    log,
    onShutdown: async () => {
      throw new Error('the socket was already gone');
    },
  });

  proc.emit('SIGTERM');
  await settle();

  assert.deepEqual(proc.exits, [0]);
  assert.ok(log.lines.some(([kind, t]) => kind === 'error' && /already gone/.test(t)));
});

test('the guards can be taken back off again', async () => {
  const proc = fakeProc();
  const log = quietLog();
  const uninstall = installProcessGuards({ proc, log });
  uninstall();

  proc.emit('unhandledRejection', new Error('nobody is listening'));
  proc.emit('SIGTERM');
  await settle();

  assert.deepEqual(proc.exits, []);
  assert.equal(log.lines.length, 0);
});
