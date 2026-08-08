import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderCampaignSite } from '../src/export/site.js';

const session = (over = {}) => ({
  id: 3,
  session_number: 2,
  channel_name: 'Cipher',
  started_at: '2026-07-31T10:00:00Z',
  ended_at: '2026-07-31T13:30:00Z',
  lineCount: 412,
  notes: {
    tldr: 'The party entered the crypt.',
    funnyMoments: [],
    npcsIntroduced: [],
    locationsVisited: [],
    partyDecisions: [],
    unresolvedThreads: [],
    lootAndRewards: [],
  },
  ...over,
});

test('renders a self-contained page with no external requests', () => {
  const html = renderCampaignSite([session()]);
  assert.match(html, /^<!doctype html>/);
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+href=/i.test(html), 'no external stylesheets');
  assert.ok(!/https?:\/\//.test(html), 'no outbound URLs at all');
});

test('session detail and derived stats appear', () => {
  const html = renderCampaignSite([session()]);
  assert.match(html, /Session #3 — Cipher/);
  assert.match(html, /The party entered the crypt\./);
  assert.match(html, /3h 30m/, 'duration is derived from start/end');
  assert.match(html, /412 lines/);
  // Notes now live at "<Campaign>/Session NN.md" — see export/naming.js. The
  // link uses the per-campaign session number, not the meeting id.
  assert.match(html, /Cipher\/Session 02\.md/, 'links to the matching markdown file');
});

test('sessions are listed newest first', () => {
  const html = renderCampaignSite([
    session({ id: 1, started_at: '2026-01-01T10:00:00Z' }),
    session({ id: 2, started_at: '2026-06-01T10:00:00Z' }),
  ]);
  assert.ok(html.indexOf('Session #2') < html.indexOf('Session #1'));
});

test('an entity is credited to the session that introduced it, not repeated', () => {
  const html = renderCampaignSite([
    session({
      id: 1,
      started_at: '2026-01-01T10:00:00Z',
      notes: { ...session().notes, npcsIntroduced: ['Vex the Bold — a smuggler'] },
    }),
    session({
      id: 2,
      started_at: '2026-06-01T10:00:00Z',
      notes: { ...session().notes, npcsIntroduced: ['Vex the Bold, smuggler of the docks'] },
    }),
  ]);

  // Once on session #1's card (the introduction) and once in the campaign
  // index — but never again on the later session that only re-mentions them.
  assert.equal(html.match(/Vex the Bold/g).length, 2, 're-mentions must not be re-listed');

  const laterCard = html.slice(html.indexOf('Session #2'), html.indexOf('Session #1'));
  assert.ok(!laterCard.includes('Vex the Bold'), 'the later session should not re-introduce them');
});

test('user content is HTML-escaped', () => {
  const html = renderCampaignSite([
    session({ channel_name: '<img src=x onerror=alert(1)>', notes: { ...session().notes, tldr: 'a & b < c' } }),
  ]);
  assert.ok(!html.includes('<img src=x'), 'raw markup from transcript data must not survive');
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /a &amp; b &lt; c/);
});

test('an empty campaign renders rather than crashing', () => {
  const html = renderCampaignSite([]);
  assert.match(html, /No completed sessions yet/);
});

test('a session with a missing end time omits duration instead of showing NaN', () => {
  const html = renderCampaignSite([session({ ended_at: null })]);
  assert.ok(!/NaN/.test(html));
});
