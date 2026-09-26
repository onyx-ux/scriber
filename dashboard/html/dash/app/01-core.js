// dashboard/html/dash/app/01-core.js: State, helpers, and the linking of names in prose.
//
// One of ten classic scripts that together are the dashboard, loaded in
// order by index.html and sharing one global scope. Split out of a single
// inline script on 2026-09-27 without changing a line; see ADR-0002.

// Same origin by default: nginx proxies /api to the Pi and adds the status
// token on the way through, so the token never reaches the browser and the
// Pi's port can stay on the LAN even when the dashboard is published.
//
// ?api=http://host:port still overrides it, for pointing at a second bot.
// `?api=` and window.SCRIBER_API point the page at a bot somewhere else. They
// are development affordances and they are now restricted to a path on this
// origin, which they were not until 2026-08-30.
//
// This page is public at quill.thehouseofcake.org. An absolute value meant a
// link on the REAL hostname could turn the real dashboard into a client of
// somebody else's server: no cookie theft (fetch defaults to same-origin
// credentials) and no injection (everything drawn goes through esc()/wiki()),
// but the whole interface became theirs to write, and every correction or
// roster search typed into it was posted to them. A convincing password prompt
// on your own domain is worth more to an attacker than an alert box.
//
// A leading slash that is not followed by another slash or a backslash is a
// path here and cannot be a host — `//evil.tld` and `/\evil.tld` are both
// read as protocol-relative by browsers, so both are refused.
const samePath = (v) => (typeof v === 'string' && /^\/(?![/\\])/.test(v) ? v : null);
const API = samePath(new URLSearchParams(location.search).get('api'))
  || samePath(window.SCRIBER_API) || '/api';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

// --- what the page is looking at ------------------------------------------
//
// Every render reads this rather than the DOM. The whole page is rebuilt from
// the poll every few seconds, so state kept in the markup would be thrown away
// mid-click.
const view = {
  screen: 'desk',       // desk | campaigns | campaign | transcript | servers | models
  signingIn: false,     // asked for the sign-in card while it was optional
  campaignId: null,
  tab: 'notes',         // notes | table | corrections | compendium | settings
  shelf: 'sessions',    // what the middle column lists: sessions | npcs | places | items
  shelfPicking: true,   // the column showing the four rather than one of them
  entry: null,          // the name last landed on in the list, as "<shelf>:<key>"
  meetingId: null,
  editing: null,        // the user id whose character name is being typed
  fixing: false,        // the correction form is open on the notes being read
  outputPicking: false, // the channel picker is open under the destination switch
  heir: null,           // who the handover picker is pointed at, before the press
  importing: false,
  creating: false,
  deleting: false,
  diagnosing: false,    // the degraded banner's detail is open
  sheet: null,          // the account panel, hung off the top bar: account
  search: '',
  speaker: null,        // transcript filter, a user id
  picking: null,        // whose colour the picker is open for, a user id
  marking: false,       // the write-up is open for correcting, not reading
  markAt: null,         // which line the box is open on, as `<part> <index>`
};

// Only one dialog is ever open. Kept in one place because every opener has to
// clear the others, and a page left with two flags set shows the first one
// forever while every click on the second looks like a dead button.
const closeDialogs = () => {
  view.importing = false;
  view.creating = false;
  view.deleting = false;
  view.renaming = false;
  view.picking = null;
  // A sheet is a dialog too as far as "only one thing is open" goes: the
  // campaigns sheet opens the new-campaign form, and leaving the sheet up
  // behind it would put a second scrim over the first one's buttons.
  view.sheet = null;
};

let me = null;          // last /me — who the bot thinks is looking
let status = null;      // last /status
let detail = null;      // last /campaign?id=
let notes = null;       // last /notes?meeting=
let notesKey = null;    // the session and job those notes were fetched for
let script = null;      // last /transcript?…&format=json
let lastSeen = null;

// The member search on the table tab. `results: null` means "not searched
// yet", which renders as nothing — distinct from `[]`, which is the honest
// and different statement that nobody matched.
const people = { query: '', results: null, error: '', busy: false };

// The sign-in card's own state, which is now only whatever went wrong last
// time. There are no steps left to be on: the card is a sentence and a button,
// and everything between pressing it and coming back happens on Discord.
const login = { message: '', failed: false };

const PROVIDERS = { gemini: 'Gemini', anthropic: 'Claude' };
const providerName = (p) => PROVIDERS[p] || p;

// --- small formatters ------------------------------------------------------

function hhmmss(ms) {
  if (ms == null) return '0:00:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
// A position in the recording, always hh:mm:ss — a three-hour session's
// timestamps have to stay comparable at a glance, and m:ss would read "202:15".
const clock = (ms) => {
  const s = Math.floor((ms ?? 0) / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// How long something ran, in the largest two units that say anything: "3:22"
// for a full evening, "0:04" for the session where everyone left before the
// bot had recorded a sentence. Both are states this actually renders.
const runtime = (ms) => {
  if (!ms) return null;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
const shortDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
const longDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const hhmm = (iso) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
const n = (x) => Number(x ?? 0).toLocaleString();
const plural = (count, word) => `${n(count)} ${word}${count === 1 ? '' : 's'}`;

function since(ms) {
  if (ms == null) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const uptime = (ms) =>
  ms == null ? '' : `up ${Math.floor(ms / 86400000)}d ${new Date(ms).toISOString().slice(11, 16)}`;

// A user with no display name has never spoken, so all we have is the id.
// Shown as an id rather than as a blank, because that is the string you paste
// into /campaign invite.
const whoIs = (p) => p.displayName || `user ${p.userId.slice(0, 4)}…${p.userId.slice(-4)}`;

// The design's NPC entries are a name and a description. Real ones are one
// string, and the summariser chooses the punctuation between the two halves —
// so this is the same split the Obsidian exporter and the ledger use, kept
// deliberately identical to campaign/entry-name.js.
const SEPARATOR = /\s*:\s+|\s+[—–-]\s+|,\s+|\s+\(/;
function splitEntry(entry) {
  const s = String(entry ?? '').trim();
  const m = s.match(SEPARATOR);
  if (!m || m.index === 0) return { name: s, rest: '' };
  return { name: s.slice(0, m.index).trim(), rest: s.slice(m.index).replace(/^[\s:—–,(-]+/, '').replace(/\)$/, '') };
}

// A session is "Session 4" wherever a person reads about one.
//
// The bot's own reference is "Cipher_04", and it has to be: it is typed into
// a slash command on a server that may run several campaigns, so it carries
// its campaign with it. Inside this page the campaign is the thing you are
// already in, so the slug says nothing the header does not — it just reads
// like a filename. The number is what the table calls the night.
const sessionName = (s) =>
  s?.sessionNumber != null ? `Session ${s.sessionNumber}`
  : s?.ref ? String(s.ref)
  : s?.meetingId != null ? `Session #${s.meetingId}`
  : 'Session';


