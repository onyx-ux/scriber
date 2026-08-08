import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// prism-media picks an opus implementation at load time, trying them in a
// fixed order: @discordjs/opus (native), then node-opus, then opusscript
// (pure JavaScript/WASM). It reports nothing about which one it got, and the
// difference matters a lot when several people are speaking at once.
//
// opusscript's WASM heap fails past roughly 19 simultaneous decoders, with
// "memory access out of bounds". Measured on this Pi: 18 concurrent speakers
// were fine, 20 lost a clip, 24 lost five. capture.js catches that, so the
// cost is a dropped clip and a log line rather than a crash — but a bot
// serving two or three servers at once can reach it during crosstalk.
//
// The native module has no such ceiling and is considerably cheaper per
// stream. Both are declared, so this exists to make the silent fallback
// visible: without it, a failed native build would quietly leave the Pi on
// the slow path with no indication anything had changed.
const CANDIDATES = ['@discordjs/opus', 'node-opus', 'opusscript'];

export function detectOpusBackend() {
  for (const name of CANDIDATES) {
    try {
      require.resolve(name);
      return { name, native: name !== 'opusscript' };
    } catch {
      // not installed; prism will try the next one for the same reason
    }
  }
  return { name: 'none', native: false };
}

export function describeOpusBackend() {
  const { name, native } = detectOpusBackend();

  if (name === 'none') {
    return 'Opus: NO implementation found — voice capture will fail.';
  }
  if (native) {
    return `Opus: ${name} (native).`;
  }
  return (
    `Opus: ${name} (pure JavaScript fallback). Works, but its WASM heap fails ` +
    `past ~19 people speaking at once, costing a clip each time. Install ` +
    `@discordjs/opus for headroom.`
  );
}
