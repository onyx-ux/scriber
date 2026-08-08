import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectOpusBackend, describeOpusBackend } from '../src/voice/opus-backend.js';

// prism-media picks an opus implementation silently, and which one it gets
// decides how many people can speak at once before clips start being dropped
// (opusscript's WASM heap fails past ~19 simultaneous decoders). These pin
// that the startup line actually tells the truth about it.

test('the backend in use is identified', () => {
  const { name, native } = detectOpusBackend();
  assert.ok(['@discordjs/opus', 'node-opus', 'opusscript', 'none'].includes(name), name);
  assert.equal(native, name !== 'opusscript' && name !== 'none');
});

test('the native module is preferred when installed', () => {
  const { name } = detectOpusBackend();
  // Declared in package.json, so anything else means the install degraded —
  // which is precisely the silent failure this module exists to surface.
  assert.equal(name, '@discordjs/opus', `prism would load ${name} instead of the native module`);
});

test('the description names the backend', () => {
  const { name } = detectOpusBackend();
  assert.match(describeOpusBackend(), new RegExp(name.replace(/[/@]/g, '\\$&')));
});

test('a fallback is described as a limitation, not just a name', () => {
  const text = describeOpusBackend();
  if (detectOpusBackend().name === 'opusscript') {
    assert.match(text, /speaking at once/, 'a bare package name would not tell anyone what it costs');
  } else {
    assert.match(text, /native/);
  }
});
