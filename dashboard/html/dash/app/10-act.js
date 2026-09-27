// dashboard/html/dash/app/10-act.js: Actions, event handlers, and the poll that starts it all.
//
// One of ten classic scripts that together are the dashboard, loaded in
// order by index.html and sharing one global scope. Split out of a single
// inline script on 2026-09-27 without changing a line; see ADR-0002.

// ==========================================================================
// Acting
// ==========================================================================

let toastTimer = null;
function toast(message, ok) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${ok ? 'good' : 'bad'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, ok ? 4500 : 9000);
}

async function send(action, body) {
  let sent = null;
  try {
    const res = await fetch(`${API}/actions/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));

    // Some refusals are a question rather than a no: the bot has counted what
    // the change would do and wants that seen first. If the answer is yes it
    // re-sends confirmed, and this call's job is done.
    if (payload?.needsConfirming && (await confirmBlastRadius(action, body, payload))) return;

    toast(payload.message || `HTTP ${res.status}`, res.ok && payload.ok !== false);
    sent = payload;
  } catch (err) {
    toast(`Couldn't reach the bot — ${err.message}`, false);
    return;
  }
  // Straight to a refresh rather than waiting for the next poll: the whole
  // point of pressing the button is to watch the thing move.
  status = await getStatus().catch(() => status);
  if (view.campaignId) detail = await get(`/campaign?id=${view.campaignId}`).catch(() => detail);
  if (view.meetingId) await syncNotes();
  paint();
  // Handed back so a caller can act on what was made — the id of a campaign
  // that did not exist a moment ago is not knowable any other way.
  return sent;
}

// The transcript needs the auth header, which a plain <a href> cannot carry —
// so it is fetched and handed to the browser as a blob rather than linked.
async function downloadTranscript(meetingId) {
  try {
    const res = await fetch(`${API}/transcript?meeting=${meetingId}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `session-${meetingId}-transcript.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast(`Couldn't fetch that transcript — ${err.message}`, false);
  }
}

async function copy(text, said) {
  try {
    await navigator.clipboard.writeText(text);
    toast(said, true);
  } catch {
    toast('The browser refused clipboard access — this needs https or localhost.', false);
  }
}

// The notes as markdown, in the shape the Obsidian export already writes, so
// pasting one into a vault matches the files Quill puts there itself — down to
// the wikilinks, which the exporter adds on its way out and this adds on the
// way to the clipboard.
//
// The heading keeps the vault's own name for the file rather than the "Session
// 4" this page reads by. A note sitting in a vault has to say which campaign it
// belongs to, which is the entire reason that reference carries one.
function notesAsMarkdown() {
  if (!notes?.written) return '';
  const section = (title, lines) =>
    lines?.length ? `\n## ${title}\n\n${lines.map((l) => `- ${wikiText(l)}`).join('\n')}\n` : '';
  return [
    `# ${notes.ref || sessionName(notes)}`,
    '',
    wikiText(notes.tldr),
    notes.scenes.map((s) => `\n## ${s.title}\n\n${wikiText(s.points.join(' '))}\n`).join(''),
    section('Party decisions', notes.partyDecisions),
    section('Still unresolved', notes.unresolvedThreads),
    section('NPCs introduced', notes.npcsIntroduced),
    section('Locations', notes.locationsVisited),
    section('Loot and rewards', notes.lootAndRewards),
    section('Follow-ups', notes.followUps),
    section('Worth remembering', notes.funnyMoments),
  ].join('\n');
}

// One listener for the whole page rather than one per render. Everything here
// is rebuilt from the poll every few seconds, so a handler attached to a button
// would be thrown away with it — and a click landing in the gap between two
// renders would do nothing at all.
document.addEventListener('click', async (event) => {
  const t = event.target;

  // --- correcting a write-up ---

  // The switch, and the way out of the band, which is the same act.
  const mode = t.closest('[data-mark]');
  if (mode) {
    markClose();
    view.marking = mode.dataset.mark === 'correct';
    return paint();
  }

  if (marking()) {
    // Inside the open box, nothing on this page is listening. A press on the
    // textarea is a caret, and the two buttons are answered here.
    if (t.closest('[data-mark-strike]')) { clearTimeout(markDraft.timer); markDraft.timer = 0; return markStore({ striking: true }); }
    if (t.closest('[data-mark-undo]')) return markUndo();
    if (t.closest('[data-mark-keep]')) return;

    const line = t.closest('[data-mark-line]');
    if (line) {
      const at = line.dataset.markLine;
      if (at === view.markAt) return;
      const e = markLineAt(at);
      if (!e) return;
      const cut = at.lastIndexOf(' ');
      return markOpen(at.slice(0, cut), e);
    }

    // A press anywhere else means finished with that line. Saved on the way
    // out rather than dropped: leaving is a stronger signal that a sentence
    // is finished than stopping typing for 700ms is.
    if (view.markAt) { markClose(); paint(); }
  }

  if (t.closest('[data-close-modal]') || t === $('modal')?.querySelector('[data-backdrop]')) {
    closeDialogs(); return paint();
  }
  // The threshold owns every click while it is up. Answered first because it
  // is the whole screen — nothing underneath it is reachable, and a press on
  // the sheet while the pen is moving means "I read faster than that".
  if (welcome.open) {
    const answer = t.closest('[data-thr-answer]');
    if (answer) return welcomeAnswer(answer.dataset.thrAnswer, answer);

    // Which Discord the new table belongs to, when there is more than one.
    const where = t.closest('[data-thr-where]');
    if (where) {
      welcome.guildId = where.dataset.thrWhere;
      return welcomeCreate(where);
    }

    // Agreeing to be recorded, or not. Its own attribute rather than another
    // data-thr-answer, so no future edit to the question ladder can route a
    // press meant for one of those into a consent row.
    const agreed = t.closest('[data-thr-agree]');
    if (agreed) return welcomeAgree(agreed.dataset.thrAgree, agreed);

    // Pressed by somebody who came to join and has nothing to join with.
    if (t.closest('[data-thr-nolink]')) {
      return welcomeGo(t.closest('[data-thr-nolink]'), () => { welcome.step = 'close'; });
    }

    if (t.closest('[data-thr-link]')) return welcomeLink();

    const ask = t.closest('[data-thr-ask]');
    if (ask) return welcomeAsk(ask.dataset.thrAsk);

    const done = t.closest('[data-thr-done]');
    if (done) return welcomeGo(done, () => { welcome.step = 'close'; });

    if (t.closest('[data-thr-skip]')) return closeWelcome();

    const door = t.closest('[data-thr-door]');
    if (door) {
      const where = door.dataset.thrDoor;
      const id = Number(door.dataset.thrCampaign);
      closeWelcome();
      if (where === 'open' && id) return loadCampaign(id);
      return;
    }

    if (welcome.writing && !welcome.burning && t.closest('.thr-sheet')) return welcomeFinish();
    return;
  }

  // The campaign column: folded and unfolded on a wide window, a drawer on a
  // narrow one. Choosing a night, a name or a thread out of the drawer closes
  // it on the way, so the choice lands on the page rather than behind the menu.
  if (t.closest('[data-rail]')) return railToggle();
  if (t.closest('[data-rail-close]')) return drawerClose();
  if (view.drawer && t.closest('.sessions [data-session], .sessions [data-entry], .sessions [data-jump]')) {
    view.drawer = false;
  }
  if (t.closest('[data-screen]')) view.drawer = false;

  // One dialog at a time. Opening any has to close the others, or a page left
  // with two flags set shows the first one forever and every later click on
  // the second looks like a dead button.
  if (t.closest('[data-new-campaign]')) { closeDialogs(); view.creating = true; return paint(); }
  if (t.closest('[data-import]')) { closeDialogs(); view.importing = true; return paint(); }
  if (t.closest('[data-delete-campaign]')) { closeDialogs(); view.deleting = true; return paint(); }
  if (t.closest('[data-rename]')) { closeDialogs(); view.renaming = true; return paint(); }

  if (t.closest('[data-signin-cancel]')) { view.signingIn = false; return paint(); }
  if (t.closest('[data-ask-invite]')) return askForInvite();

  if (t.closest('[data-signin]')) {
    closeDialogs();
    view.signingIn = true;
    login.message = ''; login.failed = false;
    return paint();
  }

  if (t.closest('[data-diagnose]')) { view.diagnosing = !view.diagnosing; return renderBanner(); }
  if (t.closest('[data-cancel-edit]')) { view.editing = null; return paint(); }

  const edit = t.closest('[data-edit]');
  if (edit) { view.editing = edit.dataset.edit; return paint(); }

  if (t.closest('[data-people-clear]')) {
    people.query = ''; people.results = null; people.error = '';
    return paint();
  }

  if (t.closest('[data-logout]')) {
    try {
      await post('/auth/logout', {});
    } catch { /* the cookie is dead either way once the row is gone */ }
    me = null; status = null; detail = null; notes = null; script = null;
    view.campaignId = null; view.meetingId = null;
    return tick();
  }
  if (t.closest('[data-copy-notes]')) {
    return copy(notesAsMarkdown(), 'Notes copied as markdown.');
  }
  if (t.closest('[data-copy-transcript]')) {
    return copy(script.lines.map((l) => `[${clock(l.ms)}] ${l.speaker}: ${l.text}`).join('\n'),
                `${n(script.total)} lines copied.`);
  }

  const theme = t.closest('[data-theme-set]');
  if (theme) return setTheme(theme.dataset.themeSet);

  // The sheets. Clicking the mark that opened one closes it again, and the
  // scrim behind catches everything else.
  const sheet = t.closest('[data-sheet]');
  if (sheet) {
    const want = sheet.dataset.sheet;
    closeDialogs();
    view.sheet = view.sheet === want ? null : want;
    return paint();
  }
  if (t.closest('[data-close-sheet]')) { view.sheet = null; return paint(); }

  if (t.closest('[data-rebuild-compendium]')) { compendium = null; return buildCompendium(); }

  // The header slides the chooser back in; a row in the chooser slides it out
  // again, on whatever was picked.
  if (t.closest('[data-shelf-back]')) {
    view.shelfPicking = true;
    const unread = !compendium || compendium.campaignId !== view.campaignId;
    paint();
    // The counts on those rows need the whole campaign read back, and that
    // read paints twice on its own. Starting it now would replace the column
    // mid-slide and the movement would be lost, so it waits for the slide to
    // land and the numbers arrive a beat later.
    if (unread) setTimeout(buildCompendium, 460);
    return;
  }

  const pick = t.closest('[data-shelf]');
  if (pick) {
    view.shelfPicking = false;
    if (pick.dataset.shelf !== view.shelf) {
      view.shelf = pick.dataset.shelf;
      view.entry = null;
      // A shelf opens at the top of its list. Nothing is picked out of it
      // until somebody picks something, and the list is what there is to read.
      view.tab = 'notes';
    }
    return paint();
  }

  // A name, picked out of the index or followed out of a write-up. A
  // wikilink in the prose is the same gesture as a row in the column, so it is
  // the same attribute — it just has to bring the column with it, because the
  // name it was following belongs to a shelf the reader may not be on.
  const entry = t.closest('[data-entry]');
  if (entry) {
    const [kind, key] = String(entry.dataset.entry ?? '').split(/:(.*)/);
    if (kind && kind !== view.shelf) view.shelf = kind;
    view.shelfPicking = false;
    view.entry = entry.dataset.entry;
    view.tab = 'notes';
    paint();
    // After the paint, because on a wikilink out of a write-up the row being
    // aimed at does not exist until the shelf it belongs to has been drawn.
    reveal(entryId(kind, key));
    return;
  }

  // A night in the ledger, jumped to from the column.
  const hop = t.closest('[data-jump]');
  if (hop) { reveal(hop.dataset.jump); return; }

  // Fixing a misheard name from the write-up that has it.
  if (t.closest('[data-fix-name]')) { view.fixing = !view.fixing; return paint(); }
  if (t.closest('[data-fix-cancel]')) { view.fixing = false; return paint(); }

  const nav = t.closest('[data-screen]');
  if (nav) {
    // Only a screen that actually changes gets the entrance. The quill is the
    // way home from everywhere including home, and replaying the animation on
    // a click that moved nothing reads as a glitch.
    if (view.screen !== nav.dataset.screen) entering();
    view.screen = nav.dataset.screen;
    view.sheet = null;
    paint();
    // Coming back to a session that is waiting for approval, its first few
    // lines have to be fetched again — the transcript reader borrowed the same
    // slot to hold the whole thing.
    if (view.screen === 'campaign') { await syncNotes(); paint(); }
    return;
  }

  const camp = t.closest('[data-campaign]:not([data-act]):not(form)');
  if (camp) return loadCampaign(Number(camp.dataset.campaign));

  const tab = t.closest('[data-tab]');
  if (tab) { view.tab = tab.dataset.tab; view.editing = null; return paint(); }

  const jump = t.closest('button.btn[data-session]');
  if (jump) {
    view.shelf = 'sessions';
    view.shelfPicking = false;
    view.entry = null;
    return openSession(Number(jump.dataset.session));
  }

  const sess = t.closest('.sess[data-session]');
  if (sess) return openSession(Number(sess.dataset.session));

  const script_ = t.closest('[data-transcript]');
  if (script_) return openTranscript(Number(script_.dataset.transcript));

  const speaker = t.closest('[data-speaker]');
  if (speaker) { view.speaker = speaker.dataset.speaker || null; return paint(); }

  // Back to a part of the write-up. Scrolled rather than jumped, and offset
  // by the sticky top bar so the heading does not land underneath it.
  const goPart = t.closest('[data-part-to]');
  if (goPart) {
    const part = document.getElementById(goPart.dataset.partTo);
    if (part) {
      const top = part.getBoundingClientRect().top + window.scrollY - 96;
      window.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    return;
  }

  // Whether the rest of the table is drawn in their own colours. This
  // browser’s answer, not the table’s and not the account’s — see
  // voicesShown().
  if (t.closest('[data-voices]')) { showVoices(!voicesShown()); return paint(); }

  const openVoice = t.closest('[data-voice-for]');
  if (openVoice) {
    // Yours, and only ever yours. Nothing on the page draws this button for
    // anybody else any more, so this is the belt to the server's braces: a
    // page that has been edited in a console cannot open the dialog on
    // somebody else's row and then send their id with the answer.
    if (!me?.signedIn || String(openVoice.dataset.voiceFor) !== String(me.userId)) return;
    closeDialogs();
    view.picking = me.userId;
    return paint();
  }

  // A colour chosen. The dialog shuts on the press rather than on the
  // answer: the choice is already made, and a picker that hangs around
  // spinning invites a second press on a second colour.
  const swatch = t.closest('[data-pick-voice]');
  if (swatch) {
    const chosen = swatch.dataset.pickVoice;
    const forWhom = view.picking;
    const where = detail?.id ?? script?.campaignId ?? null;
    view.picking = null;
    paint();
    if (!forWhom || !where) return;
    const said = await send('roster/colour', { campaignId: where, userId: forWhom, colour: chosen });

    // send() refreshes the status and the campaign, and deliberately not the
    // transcript: re-fetching four hours of lines to repaint one name would
    // be the most expensive way possible to change a class. The one field
    // that moved is written in by hand instead.
    if (said?.ok && script) {
      const sp = script.speakers.find((s) => String(s.userId) === String(forWhom));
      if (sp) { sp.colour = said.colour ?? null; paint(); }
    }
    return;
  }

  const dl = t.closest('button[data-download]');
  if (dl) return downloadTranscript(dl.dataset.download);

  // "A chosen channel" opens the list rather than sending anything. It is the
  // one destination that is two answers — that it is a channel, and which one —
  // and there is no honest way for the segment to give the second.
  const chanPick = t.closest('button[data-pick-channel]');
  if (chanPick) {
    if (chanPick.disabled) return;
    view.outputPicking = true;
    return paint();
  }

  // A button inside a form is the submit handler's business -- handling the
  // click here too would fire the action twice. Asking for .type instead was
  // the bug: a <button> with no type attribute reports "submit", so this
  // dropped every action click on the page.
  const btn = t.closest('button[data-act]');
  if (!btn || btn.disabled || btn.closest('form')) return;
  if (btn.dataset.confirm && !confirm(btn.dataset.confirm)) return;

  const d = btn.dataset;
  const body = {};
  if (d.job) body.jobId = Number(d.job);
  if (d.meeting) body.meetingId = Number(d.meeting);
  if (d.campaign) body.campaignId = Number(d.campaign);
  if (d.user) body.userId = d.user;
  if (d.wrong) body.wrong = d.wrong;
  if (d.provider) body.provider = d.provider;
  if (d.action) body.action = d.action;
  if (d.queue) body.queue = d.queue;
  if (d.mode) body.mode = d.mode;
  if (d.edition) body.edition = d.edition;
  if (d.paused) body.paused = d.paused === 'true';
  if (d.request) body.requestId = Number(d.request);
  if (d.approve) body.approve = d.approve === 'true';
  if (d.thread) body.threadId = Number(d.thread);
  if (d.threadStatus) body.status = d.threadStatus;

  // Moving the destination anywhere else closes the channel list. Left open it
  // would sit under a switch that no longer says "channel", offering to change
  // something the person has just decided against.
  if (d.act === 'campaign/output' && d.mode !== 'channel') view.outputPicking = false;

  const was = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  const said = await send(d.act, body);

  // A decision made is a dialog finished. Left open it would keep offering
  // buttons for a request that is no longer waiting on anything.

  // The campaign has a new manager, so the picker's own selection is now the
  // person it should be leaving out. Cleared rather than left armed, which
  // would offer to hand it straight back.
  if (d.act === 'campaign/manager' && said?.ok) { view.heir = null; paint(); }

  // A different rulebook is a different list of spells, so the one held in
  // memory is now the wrong one. send() has already refreshed the campaign,
  // which is where the new edition comes from.
  if (d.act === 'campaign/edition' && said?.ok) { await loadRules(said.edition); paint(); }
  btn.disabled = false; btn.textContent = was;
});

// Picking a channel out of the list.
//
// A change rather than a click, because the control is a list: the choice IS
// the event, and a dropdown with a Save button beside it invites somebody to
// pick a channel, walk away, and be sure they set it.
//
// Both facts go in one request. Choosing a channel is choosing to post to a
// channel, so making the mode a separate step would only create a state where
// the destination is 'channel' and the channel is nothing.
document.addEventListener('change', async (event) => {
  const sel = event.target.closest?.('select[data-set-channel]');
  if (!sel || sel.disabled || !sel.value) return;
  await send('campaign/output', { campaignId: detail?.id, mode: 'channel', channelId: sel.value });
});

// Choosing who a campaign would go to.
//
// Unlike the channel picker above, this one only ARMS the button beside it. The
// two acts are different sizes: pointing a recap at another channel is undone
// by pointing it back, and handing the campaign over gives somebody else the
// say over this table's records — including whether it is deleted.
document.addEventListener('change', (event) => {
  const sel = event.target.closest?.('select[data-heir]');
  if (!sel) return;
  view.heir = sel.value || null;
  paint();
});

// Forms wherever there is something to type: Enter-to-submit and required-field
// validation for free, and both matter for the things typed most often here.
// Signing out, which is the only request on this page that works without a
// credential — everything else is behind one. Signing IN is not here at all
// any more: it is a link the browser follows to Discord and a redirect back,
// so there is nothing for fetch to do.
async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, payload: await res.json().catch(() => ({})) };
}

// Searching for a person is the one form whose answer is not a toast: it
// returns a list to choose from, so it renders into the page rather than
// disappearing after a second and a half.
// The torch follows the pointer and the keyboard alike, so the line it is
// standing beside is always the line a press will take. Pointer events rather
// than :hover in CSS, because the flame is one element being moved rather than
// a state on each row — and because the same handler serves both.
document.addEventListener('pointerover', (event) => {
  if (!welcome.open || welcome.burning) return;
  const row = event.target.closest?.('.thr-choices .thr-choice:not([disabled])');
  if (!row) return;
  const rows = thrRows();
  const i = rows.indexOf(row);
  if (i >= 0 && i !== thrPicked) thrPick(i);
});

document.addEventListener('focusin', (event) => {
  if (!welcome.open || welcome.burning) return;
  const row = event.target.closest?.('.thr-choices .thr-choice:not([disabled])');
  if (!row) return;
  const i = thrRows().indexOf(row);
  if (i >= 0) thrPick(i);
});

document.addEventListener('keydown', (event) => {
  if (!welcome.open || welcome.burning) return;
  // Not while somebody is typing a campaign name into the field.
  if (event.target?.classList?.contains('thr-in')) return;
  const rows = thrRows();
  if (!rows.length) return;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    thrPick(thrPicked + (event.key === 'ArrowDown' ? 1 : -1), { focus: true });
  }
});

// The threshold's own two fields. Forms rather than buttons with a click
// handler, so Enter sends them — somebody typing the name of their campaign
// should not have to go looking for the control.
document.addEventListener('submit', (event) => {
  const named = event.target.closest('form[data-thr-name]');
  if (named) { event.preventDefault(); return welcomeNamed(named); }

  const finding = event.target.closest('form[data-thr-find]');
  if (finding) { event.preventDefault(); return welcomeFind(); }

  const joining = event.target.closest('form[data-thr-join]');
  if (joining) { event.preventDefault(); return welcomeJoined(); }

  const seating = event.target.closest('form[data-thr-seat]');
  if (seating) { event.preventDefault(); return welcomeSeat(seating); }
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-people-search]');
  if (!form) return;
  event.preventDefault();

  people.query = $('people-q')?.value.trim() ?? '';
  people.error = '';
  if (people.query.length < 2) {
    people.error = 'Type at least two characters.';
    return paint();
  }

  people.busy = true;
  paint();
  try {
    const res = await fetch(`${API}/actions/roster/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: detail.id, query: people.query }),
    });
    const payload = await res.json().catch(() => ({}));
    people.results = payload.people ?? [];
    people.error = payload.ok === false ? payload.message || `HTTP ${res.status}` : '';
    if (payload.ok === false) people.results = null;
  } catch (err) {
    people.results = null;
    people.error = `Couldn't reach the bot — ${err.message}`;
  }
  people.busy = false;
  paint();
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-act]');
  if (!form) return;
  event.preventDefault();

  const body = Object.fromEntries(new FormData(form));
  if (form.dataset.campaign) body.campaignId = Number(form.dataset.campaign);
  if (form.dataset.user) body.userId = form.dataset.user;

  const submit = form.querySelector('button[type=submit]');
  if (submit) submit.disabled = true;
  if (form.dataset.act === 'import') view.importing = false;
  if (form.dataset.act === 'campaign/create') view.creating = false;
  if (form.dataset.act === 'roster/character') view.editing = null;
  // The two boxes on the write-up close on submit rather than on the reply:
  // leaving them open behind a toast reads as though nothing was sent.
  if (form.dataset.act === 'corrections/add') view.fixing = false;
  const payload = await send(form.dataset.act, body);
  if (submit) submit.disabled = false;

  if (form.dataset.act === 'campaign/rename' && payload?.ok) { view.renaming = false; paint(); }

  // The delete dialog stays open when the typed name did not match, because
  // closing it would throw the attempt away and say nothing about why.
  if (form.dataset.act === 'campaign/delete' && payload?.ok) {
    view.deleting = false;
    view.campaignId = null;
    detail = null;
    // The campaign just left the list, so land somewhere that still exists
    // rather than on a screen describing something the bot no longer returns.
    const next = status?.campaigns?.[0];
    if (next) await loadCampaign(next.id);
    else paint();
  }

  // Land in the campaign that was just made. Making one and then being put
  // back on the ledger to find it yourself would be a strange way to finish.
  if (form.dataset.act === 'campaign/create' && payload?.campaignId) {
    await loadCampaign(payload.campaignId);
  }
});

// A correction that would change a large share of the campaign comes back
// refused rather than applied, with the count. It can be taken back, but until
// it is every transcript and write-up reads that way, so the number is shown
// before it happens rather than reported after.
async function confirmBlastRadius(action, body, payload) {
  if (!payload?.needsConfirming) return false;
  const sure = confirm(
    `${payload.message}\n\n` +
    `Apply it anyway to all ${payload.wouldChange} of ${payload.total} lines? You can remove it afterwards to put them back.`
  );
  if (!sure) return false;
  await send(action, { ...body, force: true });
  return true;
}

// Searching re-renders in place rather than on submit — the list under it is
// the answer as you type. The box keeps the caret because morph() leaves the
// focused field alone; it used to be saved and put back by hand here.
document.addEventListener('input', (event) => {
  if (event.target.id === 'mark-box') return markTyped(event.target.value);
  if (event.target.id !== 'tsearch') return;
  view.search = event.target.value;
  renderScreen();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // The box first, and what is in it is kept. Escape here means "that is
  // the sentence", not "forget what I typed" — there is no undo behind it,
  // and a correction lost to a keystroke is the thing this must never do.
  if (view.markAt) { markClose(); return paint(); }
  if (view.marking) { view.marking = false; return paint(); }
  if (view.importing || view.creating || view.deleting || view.renaming || view.picking) {
    closeDialogs(); return paint();
  }
  if (view.sheet) { view.sheet = null; return paint(); }
  if (drawerClose()) return;
  if (view.editing) { view.editing = null; return paint(); }
  if (view.screen === 'transcript') { view.screen = 'campaign'; return paint(); }
  if (view.screen !== 'campaigns' && status?.campaigns?.length) {
    view.screen = 'campaigns';
    entering();
    return paint();
  }
});

// The banner rewraps when the window changes width — two lines at 1400px,
// six at 390px — so the height the sticky columns are budgeted from has to be
// taken again. Nothing here re-renders; it only re-measures.
window.addEventListener('resize', measureChrome);

// Crossing the column's breakpoint changes what the campaign screen is made
// of — a column or a drawer — so that one resize repaints. A drawer left open
// on a narrow window is closed on the way to a wide one.
window.matchMedia?.(RAIL_WIDE)?.addEventListener?.('change', () => {
  view.drawer = false;
  paint();
});

// The recording timers tick on their own second, so they keep counting between
// polls rather than jumping every five.
//
// Two of them now: the big one in the session pane, and the desk's, which is
// the only moving thing on the front door. Both read the same payload and both
// add the time since it arrived, so they always agree. morph() rewrites the
// text from the fresh figure on every poll and lands on the same second this
// does, which is why the two do not fight.
setInterval(() => {
  if (!lastSeen) return;
  const since = Date.now() - lastSeen;
  const running = status?.recording ?? [];

  const pane = $('timer');
  const mine = running.find((r) => r.meetingId === view.meetingId);
  if (pane && mine) pane.textContent = hhmmss(mine.recordingForMs + since);

  // Matched on the meeting, not the guild: two tables can be recording in one
  // Discord, and a guild match would count up whichever of them came first.
  const desk = $('desk-timer');
  const there = desk && running.find((r) => String(r.meetingId) === desk.dataset.meeting);
  if (desk && there) desk.textContent = hhmmss(there.recordingForMs + since);
}, 1000);

// Arriving at the card, from either side of it.
//
// #signin is the landing page's "Log in" link. The card is view state rather
// than a screen with a URL, so without this nothing outside the page could ask
// for it: a link could only drop somebody on the operator's dashboard and leave
// them to find the button themselves. That is a poor door for the person it
// matters most to — a player sent here to read a recap who has never seen this
// page before.
//
// #signin-error=... is the way back from Discord when it did not work. The
// callback is a redirect, so it has no response body to explain itself in; it
// says which of five things happened and the page turns that into a sentence.
//
// Fragments rather than queries so nginx needs no rewrite, and read once and
// then wiped so a refresh does not throw the card back up — or replay an error
// that has since been fixed. Still gated on `me` in renderScreen, so somebody
// who already holds a session lands on the dashboard and this does nothing.
const arrivedAt = location.hash ?? '';
if (arrivedAt === '#signin' || arrivedAt.startsWith('#signin-error=')) {
  view.signingIn = true;
  const trouble = arrivedAt.slice('#signin-error='.length);
  // The one outcome that is nobody's mistake gets a screen of its own; every
  // other one is a sentence under the button.
  if (trouble === 'notinvited') view.notInvited = true;
  else if (SIGNIN_TROUBLE[trouble]) {
    login.failed = true;
    login.message = SIGNIN_TROUBLE[trouble];
  }
  history.replaceState(null, '', location.pathname + location.search);
}

// #welcome opens the threshold for somebody who is not new. It is how the
// screen gets looked at at all — the honest way in happens once per account,
// and "sign in as a person who has never signed in" is not a thing the person
// building it can do twice. Wiped from the URL like the two above, so a
// refresh lands on the dashboard.
if (arrivedAt === '#welcome') {
  welcome.forced = true;
  history.replaceState(null, '', location.pathname + location.search);
}

// An invitation to one table: /app/?join=<token>, made by invite/link.
//
// A query rather than a fragment, unlike the three above, and for the opposite
// reason to theirs — see joinLink() in delivery/dashboard-link.js. Those are
// messages this page sends itself through a redirect it controls; this one is
// pasted into a chat window by a person, and half the clients that would render
// it strip a fragment or mangle it.
//
// Moved straight into sessionStorage and wiped from the address bar, which does
// two jobs at once: the token survives the round trip through Discord's sign-in
// for somebody who did not have a session, and it stops being in a URL that
// gets screenshotted, pasted back, or left in a shared browser's history.
const invitedWith = new URLSearchParams(location.search).get('join');
if (invitedWith) {
  try { sessionStorage.setItem(JOINING, invitedWith); } catch (e) { /* fine */ }
  history.replaceState(null, '', location.pathname);
}

tick();
setInterval(tick, 5000);
