import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { VOICES, VOICE_SLUGS, isVoiceColour, voiceColour } from '../src/web/palette.js';

// The twenty-four voices, measured rather than admired.
//
// This file exists because the palette lives in two places and cannot live in
// one. The server owns it — it validates what may be stored, and it is the
// list any future screen reads. The dashboard is a static HTML file with no
// build step, so its copy of the same forty-eight values is typed into a
// stylesheet. Nothing at runtime forces those two to agree.
//
// So the agreement is forced here, by reading both files. And since the whole
// claim of the palette is that every colour stays legible in both themes, that
// is re-measured too: a hex nudged by hand in either file to look nicer will
// fail on the number rather than on somebody's eye a month later.

const HTML = fileURLToPath(new URL('../../dashboard/html/index.html', import.meta.url));
const page = await readFile(HTML, 'utf8');

// --- contrast, the same way a browser computes it ---

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const channel = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// The two grounds are read out of the stylesheet rather than pasted here, so
// that retuning a theme is what breaks this test — which is the moment the
// palette genuinely does need looking at again.
//
// The lightest surface each theme ever puts text on is the one that matters:
// dark text is hardest to read on the lightest ground, and light text on a dark
// theme is hardest on ITS lightest ground too. Anything else on either page has
// more contrast than these, not less.
function tokenIn(block, name) {
  const found = new RegExp('--' + name + ':\\s*(#[0-9A-Fa-f]{6})').exec(block);
  assert.ok(found, 'no --' + name + ' in that theme block');
  return found[1].toUpperCase();
}
const darkBlock = page.slice(page.indexOf(':root, :root[data-theme="dark"]'), page.indexOf(':root[data-theme="light"]'));
const lightBlock = page.slice(page.indexOf(':root[data-theme="light"]'), page.indexOf('@media (prefers-color-scheme: light)'));
const DARK_GROUND = tokenIn(darkBlock, 'raise');
const LIGHT_GROUND = tokenIn(lightBlock, 'card');

// --- what the stylesheet says ---

// .v-red-deep  { --voice: #F55B57; --voice: light-dark(#940014, #F55B57); }
const cssVoices = new Map();
const rule = /\.v-([a-z-]+)\s*\{\s*--voice:\s*(#[0-9A-Fa-f]{6});\s*--voice:\s*light-dark\((#[0-9A-Fa-f]{6}),\s*(#[0-9A-Fa-f]{6})\);\s*\}/g;
for (let m = rule.exec(page); m; m = rule.exec(page)) {
  cssVoices.set(m[1], { fallback: m[2].toUpperCase(), light: m[3].toUpperCase(), dark: m[4].toUpperCase() });
}

test('the stylesheet carries every colour the server knows about, and no others', () => {
  assert.deepEqual([...cssVoices.keys()].sort(), [...VOICE_SLUGS].sort());
});

test('every value in the stylesheet is the value the server stores against', () => {
  for (const v of VOICES) {
    const css = cssVoices.get(v.slug);
    assert.equal(css.light, v.light, `${v.slug} light`);
    assert.equal(css.dark, v.dark, `${v.slug} dark`);
  }
});

test('the fallback in front of light-dark() is the dark value, because dark is the default theme', () => {
  // A browser without light-dark() takes the first declaration. Giving it the
  // light value there would paint dark ink on the dark table.
  for (const v of VOICES) assert.equal(cssVoices.get(v.slug).fallback, v.dark, v.slug);
});

test('all forty-eight values clear 4.5:1 as text on their own theme', () => {
  for (const v of VOICES) {
    const onLight = contrast(v.light, LIGHT_GROUND);
    const onDark = contrast(v.dark, DARK_GROUND);
    assert.ok(onLight >= 4.5, `${v.slug} on ${LIGHT_GROUND} is only ${onLight.toFixed(2)}:1`);
    assert.ok(onDark >= 4.5, `${v.slug} on ${DARK_GROUND} is only ${onDark.toFixed(2)}:1`);
  }
});

test('twelve families, two shades each, no repeats', () => {
  assert.equal(VOICES.length, 24);
  assert.equal(new Set(VOICE_SLUGS).size, 24);
  assert.equal(new Set(VOICES.map((v) => v.family)).size, 12);
  for (const family of new Set(VOICES.map((v) => v.family))) {
    const shades = VOICES.filter((v) => v.family === family).map((v) => v.shade).sort();
    assert.deepEqual(shades, ['bright', 'deep'], family);
  }
});

test('no two colours are the same hex in either theme', () => {
  assert.equal(new Set(VOICES.map((v) => v.light)).size, 24, 'two colours collide on the light theme');
  assert.equal(new Set(VOICES.map((v) => v.dark)).size, 24, 'two colours collide on the dark theme');
});

test('the picker offers the same twelve families, in the palette’s own order', () => {
  const listed = /const VOICE_FAMILIES = \[([\s\S]*?)\];/.exec(page);
  assert.ok(listed, 'the page has no VOICE_FAMILIES');
  const families = [...listed[1].matchAll(/\['([a-z]+)', '[A-Za-z]+'\]/g)].map((m) => m[1]);

  // Order matters as well as membership: the picker lays the grid out in this
  // order, and it is a colour wheel with the near-neutrals at the end rather
  // than an alphabet.
  const fromServer = [];
  for (const v of VOICES) if (!fromServer.includes(v.family)) fromServer.push(v.family);
  assert.deepEqual(families, fromServer);
});

// --- what a caller can hand in ---

test('only the twenty-four are colours', () => {
  for (const slug of VOICE_SLUGS) assert.ok(isVoiceColour(slug), slug);
  for (const not of ['', null, undefined, 'red', 'deep', 'RED-DEEP', 'red-deepish', 0, {}]) {
    assert.equal(isVoiceColour(not), false, String(not));
  }
});

test('a colour cannot smuggle anything into a class attribute', () => {
  // The page interpolates the slug into class="… v-<slug>". Both ends check it;
  // this is the end that would be asked first.
  for (const attempt of [
    'red-deep red-bright',
    'red-deep" onload="x',
    'red-deep; color: red',
    '../../etc',
    'red-deep\n',
  ]) {
    assert.equal(isVoiceColour(attempt), false, attempt);
    assert.equal(voiceColour(attempt), null, attempt);
  }
});

test('the page never writes a class for a slug it has not checked', () => {
  // voiceClass() is the only place a stored value reaches the markup, and it
  // guards with realVoice(). If that guard is ever removed this test says so,
  // because the shape of the check is the whole protection.
  assert.match(page, /const realVoice = \(slug\) => \/\^\[a-z\]\+-\(deep\|bright\)\$\/\.test/);
  assert.match(page, /if \(!colour \|\| !realVoice\(colour\)\) return ''/);
  for (const v of VOICES) assert.match(v.slug, /^[a-z]+-(deep|bright)$/, v.slug);
});

test('the swatch does not wear a class the page already uses', () => {
  // `.dot` is the 7px status light in the top bar, the banner and every health
  // row. The colour swatch was called `.dot` too for about an hour, and because
  // it is declared further down the same stylesheet it won on source order and
  // silently blew every status light up to 22px with a border. Nothing failed;
  // it just looked wrong on four screens.
  //
  // So: whatever the swatch is called, it is not this.
  const rules = [...page.matchAll(/^\s*\.dot(?:\.[a-z-]+)*\s*\{/gm)].map((m) => m[0].trim());
  const known = new Set([
    '.dot {', '.dot.ok    {', '.dot.bad   {', '.dot.warn  {', '.dot.brass {', '.dot.live  {',
  ]);
  for (const rule of rules) {
    assert.ok(known.has(rule), `a new .dot rule appeared: ${rule} — pick another name`);
  }

  // And the swatch is where it should be.
  assert.match(page, /\.voice-dot \{/);
  assert.match(page, /class="voice-dot/);
  assert.doesNotMatch(page, /class="dot pick/, 'the swatch is wearing the status light again');
});
