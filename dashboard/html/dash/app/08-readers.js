// dashboard/html/dash/app/08-readers.js: The transcript reader, the servers screen, and the dialogs.
//
// One of ten classic scripts that together are the dashboard, loaded in
// order by index.html and sharing one global scope. Split out of a single
// inline script on 2026-09-27 without changing a line; see ADR-0002.

// ==========================================================================
// The transcript reader
// ==========================================================================

function transcriptScreen() {
  if (!script) return '<div class="pane-main"><div class="quiet">Opening the transcript…</div></div>';

  const term = view.search.trim().toLowerCase();
  const lines = script.lines.filter((l) =>
    (!view.speaker || l.userId === view.speaker) && (!term || l.text.toLowerCase().includes(term)));

  // Every line needs to know two things about whoever said it — whether they
  // own the campaign, and what colour they are written in. Built once here
  // rather than scanned per line: a four-hour session is thousands of lines
  // against a handful of speakers, and this used to be a find() inside the
  // map.
  const voices = new Map(script.speakers.map((sp) => [sp.userId, sp]));

  return `
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;min-height:0">
        <div class="tr-bar">
          <input class="in" id="tsearch" style="flex:0 0 300px" placeholder="Search ${n(script.total)} lines"
                 value="${esc(view.search)}" aria-label="Search the transcript">
          <div class="row-btns" style="gap:7px">
            <button class="chip ${view.speaker ? '' : 'on'}" data-key="chip-all" data-speaker="">everyone</button>
            ${script.speakers.map((sp) => `
              <button class="chip${view.speaker === sp.userId ? ' on' : ''}${voiceClass(sp.userId, sp.colour)}"
                      data-key="chip-${esc(sp.userId)}" data-speaker="${esc(sp.userId)}">${esc(sp.name)}</button>`).join('')}
          </div>
          <span class="mono" style="margin-left:auto;font-size:11.5px;color:var(--dim)">
            ${lines.length === script.lines.length ? n(script.total) : `${n(lines.length)} of ${n(script.total)}`} lines
          </span>
        </div>
        <div class="lines">
          ${lines.length ? lines.map((l) => `
            <div class="line" data-key="line-${l.ms}-${l.userId}">
              <span class="t">${esc(clock(l.ms))}</span>
              <span class="who ${voices.get(l.userId)?.manager ? 'owner' : ''}${voiceClass(l.userId, voices.get(l.userId)?.colour)}">${esc(l.speaker)}</span>
              <span class="said">${highlight(l.text, term)}</span>
            </div>`).join('')
            : `<div class="quiet" style="padding:40px 0">Nothing matches “${esc(view.search)}”.</div>`}
          ${script.truncated ? '<div class="quiet" style="padding:20px 0">This transcript is longer than the reader shows — download the .txt for all of it.</div>' : ''}
        </div>
      </div>

      <aside class="facts" style="flex:0 0 320px;padding:26px">
        <div>
          <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:14px">
            <div class="cap">Who spoke</div>
            ${otherVoices() ? `
              <button type="button" class="chip ${voicesShown() ? 'on' : ''}" data-voices style="margin-left:auto"
                      title="${voicesShown() ? 'Stop drawing the rest of the table in their own colours, on this browser' : 'Draw the rest of the table in their own colours again'}">colours</button>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:11px">
            ${script.speakers.map((sp) => {
              const ink = voiceClass(sp.userId, sp.colour);
              const mine = Boolean(me?.signedIn && sp.userId && String(sp.userId) === String(me.userId));
              return `
              <div class="${ink.trim()}" style="display:flex;align-items:center;gap:11px">
                ${mine
                  ? `<button type="button" class="voice-pick${ink ? ' voiced' : ''}" data-voice-for="${esc(sp.userId)}"
                             title="${sp.colour ? `${esc(voiceName(sp.colour))} — press to change how your name is written here`
                               : 'Pick the colour your name is written in here'}">
                       <i class="voice-dot tiny${sp.colour && realVoice(sp.colour) ? '' : ' unset'}"><i class="swatch"></i></i>
                       <span>${esc(sp.name)}</span></button>`
                  : `<span class="${ink ? 'voiced' : ''}" style="font-size:13.5px;width:104px;${!ink && sp.manager ? 'color:var(--brass)' : ''}">${esc(sp.name)}</span>`}
                <i style="flex:1;height:5px;border-radius:3px;background:var(--line);display:block;overflow:hidden">
                  <b style="display:block;height:100%;width:${sp.share}%;background:var(--voice, ${sp.manager ? 'var(--brass)' : 'var(--edge)'})"></b>
                </i>
                <span class="mono" style="font-size:11px;color:var(--dim);width:34px;text-align:right">${sp.share}%</span>
              </div>`;
            }).join('')}
          </div>
          ${myVoiceRow()}
        </div>
        ${script.corrections.length ? `
          <div class="keep">
            <div class="cap">Corrections in force</div>
            <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
              ${script.corrections.map((c) => `
                <div style="font-size:13.5px;color:var(--text-2)">“${esc(c.wrong)}” → <b style="color:var(--text)">${esc(c.right)}</b></div>`).join('')}
            </div>
            <div class="quiet" style="margin-top:12px">
              These were applied as the transcript was written, so what you are reading is already corrected.
            </div>
          </div>` : ''}
        <div>
          <div class="cap" style="margin-bottom:12px">This session</div>
          <div class="mono" style="font-size:12.5px;color:var(--text-2);line-height:2">
            ${esc(longDate(script.startedAt))}<br>
            ${esc(n(script.total))} lines · ${plural(script.speakers.length, 'voice')}<br>
            ${esc(script.channel ? `#${script.channel}` : '')}
          </div>
          ${howItWasMade()}
        </div>
        <div class="quiet" style="margin-top:auto">
          ${script.hasNotes
            ? 'The notes for this session are written — close this to read them.'
            : 'No notes exist for this session yet.'}
        </div>
      </aside>`;
}

// What made this transcript, and what that means for the lines above.
//
// It sits under the date and the line count because it is the same kind of
// fact — how this evening was turned into words — and both readings say what
// they are worth, not just the awkward one. A page that only spoke up when
// something was approximate would make silence mean "exact", and silence here
// already means something else: a session recorded before any of this was
// written down, which gets nothing at all rather than a flattering guess.
//
// The brass is on the grade and not on the sentence. `rough` marks a
// transcript whose line breaks are approximate — the Pi’s batched whisper path
// as much as Gemini — and it borrows the colour this page already uses for
// "held" and "paused" rather than the red it uses for "broken", because these
// are working transcripts with one soft edge, not failed ones.
function howItWasMade() {
  const p = script?.provenance;
  if (!p) return '';
  return `
    <div class="made${p.lineBreaks === 'approximate' ? ' rough' : ''}">
      <span class="mono">${esc(p.how)}</span>
      ${p.say ? `<div class="why">${esc(p.say)}</div>` : ''}
    </div>`;
}

// Whether anybody OTHER THAN THE READER has picked a colour here.
//
// The switch turns off other people, so on a table where the reader is the
// only one who has chosen it would be a button that visibly does nothing —
// worse than absent, because it looks broken rather than unnecessary.
function otherVoices() {
  return (script?.speakers ?? []).some(
    (sp) => sp.colour && !(me?.signedIn && String(sp.userId) === String(me.userId))
  );
}

function highlight(text, term) {
  if (!term) return esc(text);
  const at = text.toLowerCase().indexOf(term);
  if (at < 0) return esc(text);
  return `${esc(text.slice(0, at))}<mark>${esc(text.slice(at, at + term.length))}</mark>${esc(text.slice(at + term.length))}`;
}

// ==========================================================================
// Servers, and access
// ==========================================================================

function serversScreen() {
  const servers = status?.servers ?? [];
  return `
    <div class="pane-main">
      <div class="say-2" style="margin-top:0;max-width:78ch">
        One bot, one transcriber, one queue. Everything Quill records on any of these servers goes through
        the same machine, so a busy Saturday on one table delays the other.
      </div>
      ${servers.map((g) => {
        const here = (status.campaigns ?? []).filter((c) => c.guildId === g.id);
        const missing = (g.permissions ?? []).filter((p) => !p.ok);
        return `
          <div class="card" style="margin-top:24px;padding:26px 28px">
            <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
              <span style="width:36px;height:36px;flex:0 0 36px;border-radius:8px;background:var(--raise);
                           display:flex;align-items:center;justify-content:center;font-family:var(--serif);
                           font-size:17px;color:var(--dim)">${esc((g.name || '?').slice(0, 1).toUpperCase())}</span>
              <div>
                <div style="font-family:var(--serif);font-size:24px">${esc(g.name || g.id)}</div>
                <div class="mono" style="font-size:11.5px;color:var(--dim);margin-top:4px">
                  ${plural(here.length, 'campaign')} · ${esc(g.id)}
                </div>
              </div>
              ${g.recording ? '<span class="pill recording" style="margin-left:0">recording now</span>' : ''}
              ${missing.length ? `<span class="pill approval" style="margin-left:0">${
                missing.length === 1 ? 'needs one permission' : `needs ${missing.length} permissions`
              }</span>` : ''}
            </div>
            <div style="border-top:1px solid var(--line);margin-top:20px;padding-top:18px;
                        display:flex;gap:40px;align-items:flex-start;flex-wrap:wrap">
              <div style="flex:1;min-width:280px">
              <div class="cap">Campaigns here</div>
              ${here.length ? here.map((c) => `
                <div style="display:flex;align-items:baseline;gap:12px;margin-top:12px;flex-wrap:wrap">
                  <span class="dot ${c.recording ? 'live' : c.claimed ? 'warn' : ''}"></span>
                  <button class="charbtn" data-campaign="${c.id}" style="font-size:15px;font-weight:500">${esc(c.name || 'unnamed')}</button>
                  <span class="mono" style="font-size:12px;color:var(--dim)">
                    ${esc(c.channel || '')}${c.output === 'dm' ? ' → DM' : ''}
                  </span>
                  <span class="mono" style="margin-left:auto;font-size:12px;color:var(--dim)">
                    ${c.sessions ? plural(c.sessions, 'session') : 'no sessions'}
                  </span>
                </div>`).join('')
                : '<div class="quiet" style="margin-top:12px">Quill is here but no campaign has been made yet — <code>/campaign create</code>.</div>'}
              ${here.length > 1 ? `<div class="quiet" style="margin-top:14px">
                These campaigns share one server. Quill decides which one it is recording from who joins.
              </div>` : ''}
              </div>
              ${g.permissions ? `
                <div style="flex:0 0 340px">
                  <div class="cap">Permissions</div>
                  <div style="display:flex;flex-direction:column;gap:9px;margin-top:12px">
                    ${g.permissions.map((p) => `
                      <div style="display:flex;gap:12px;align-items:baseline;font-size:13.5px;
                                  color:${p.ok ? 'var(--text-2)' : 'var(--brass-lit)'}">
                        <span class="mono" style="font-size:11px;width:22px;flex:0 0 22px;
                              color:${p.ok ? 'var(--sage-lit)' : 'var(--amber)'}">${p.ok ? 'ok' : 'no'}</span>
                        <span>${esc(p.what)}</span>
                      </div>`).join('')}
                  </div>
                  ${missing.length ? `<div class="quiet" style="margin-top:12px">
                    Granted per role in Discord's server settings. Until then a session can record and still
                    fail to arrive.
                  </div>` : ''}
                </div>` : ''}
            </div>
          </div>`;
      }).join('')}
      ${servers.length ? '' : '<div class="quiet" style="margin-top:24px">Quill is not in any server yet.</div>'}
    </div>`;
}

// Your usage. A PLACEHOLDER.
//
// Per-account limits are planned (see "Limits behind the tiers" in the
// roadmap) and not built. This screen shows the shape they will take, with
// dummy figures, so the page has a place for them and the words can be
// settled early. Nothing here is read from the bot and nothing is enforced.
// The operator's real figures for the whole bot are in the gatehouse, under
// Usage.
const USAGE_PREVIEW = [
  { what: 'Sessions recorded', used: 3, limit: 8, unit: 'session' },
  { what: 'Hours transcribed', used: 9.5, limit: 24, unit: 'hour' },
  { what: 'Questions asked with /campaign ask', used: 12, limit: 50, unit: 'question' },
  { what: 'Write-ups regenerated', used: 1, limit: 4, unit: 'write-up' },
];

function usageScreen() {
  // Name and figure on one line, the bar under both at full width, so every
  // bar starts and ends at the same place whatever the figure says.
  const row = ({ what, used, limit, unit }) => `
    <div style="padding:16px 0;border-bottom:1px solid var(--rule)">
      <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline;flex-wrap:wrap">
        <div class="what">${esc(what)}</div>
        <div class="mono" style="font-size:13px;color:var(--text-2);white-space:nowrap">${used} of ${plural(limit, unit)}</div>
      </div>
      <div class="bar" style="height:8px;margin-top:10px" role="img" aria-label="${used} of ${limit} (example)">
        <i style="width:${Math.round((used / limit) * 100)}%"></i></div>
    </div>`;

  return `
    <div class="pane-main pane-wide">
      <div class="kicker">Your usage <span class="pill" style="margin-left:8px">preview</span></div>
      <h1 class="display" style="margin-top:14px">Your account this month</h1>
      <div class="say-2 measure">
        Each account will have a monthly allowance for recording, transcribing and asking questions,
        set by its plan. <b>These figures are examples.</b> Limits are not switched on yet, so nothing
        you do is counted or stopped.
      </div>

      <div style="display:flex;gap:40px;align-items:flex-start;flex-wrap:wrap;margin-top:34px">
        <div style="flex:1;min-width:300px;max-width:640px">
          <div class="cap">Plan: Adventurer (example)</div>
          ${USAGE_PREVIEW.map(row).join('')}
          <div class="quiet" style="margin-top:14px">Resets on the 1st of each month (example).</div>
        </div>
        <div class="aside">
          <div class="card">
            <div class="cap">What happens at the limit</div>
            <div class="quiet" style="margin-top:10px">
              A recording that has already been made is always transcribed and written up. What stops
              is starting new ones, and asking new questions, until the month resets.
            </div>
          </div>
          ${cap('everything') ? `
            <div class="card">
              <div class="cap">The whole bot</div>
              <div class="quiet" style="margin-top:10px">What the models have cost, and which one does which
                job, is in the gatehouse.</div>
              <a class="btn wide" style="display:flex;justify-content:center;margin-top:14px;text-decoration:none"
                 href="/gatehouse/#usage">Open the gatehouse</a>
            </div>` : ''}
        </div>
      </div>
    </div>`;
}

// ==========================================================================
// The import dialog
// ==========================================================================

// Rendered only when it opens or closes, never on a poll.
//
// It is the one part of the page you type a URL into, and a five-second
// repaint that replaced the dialog would throw away whatever was half-typed.
// Everything the dialog says about the world it says once, when it opens.
// Starting a campaign. Two fields, because that is the whole act: what it is
// called, and which Discord it belongs to. Everything else a campaign has —
// roster, corrections, where the notes go — is set afterwards, from inside it.
function createDialog() {
  const servers = status?.canCreateIn ?? [];
  return `
    <div class="backdrop" data-backdrop>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="New campaign">
        <div class="kicker">Campaigns</div>
        <h1>Start a campaign</h1>
        <div class="say-2" style="font-size:14.5px;margin-top:12px">
          One per game. It holds the roster, the corrections, and every session you record.
          You will run it.
          ${
            // How many places are left, said BEFORE the button rather than
            // after it. A ceiling somebody only meets as a refusal is a
            // ceiling they had no way to plan around, and this one is small
            // enough to reach in an afternoon of setting tables up.
            //
            // Only when a limit applies: 0 is unlimited, which is what the
            // operator and anybody on the house tier have, and telling them
            // they have "unlimited of unlimited left" is noise.
            me?.campaignLimit > 0 ? `
            <div class="mono" style="font-size:11px;color:var(--dim);margin-top:10px">
              ${esc(String(me.campaignsHeld))} of ${esc(String(me.campaignLimit))} used${
                me.campaignsHeld >= me.campaignLimit
                  ? ' — delete one you have finished with to free a place'
                  : ''
              }. Tables you only play at never count.
            </div>` : ''
          }
        </div>

        <form data-act="campaign/create">
          <div class="field">
            <label for="new-name">Name</label>
            <input class="in" id="new-name" name="name" required autocomplete="off" placeholder="Cipher">
            <div class="mono" style="font-size:11px;color:var(--dim);margin-top:9px">
              becomes the folder its notes live in, and the start of every session reference
            </div>
          </div>
          <div class="field">
            <label for="new-guild">Server</label>
            ${servers.length === 1
              ? `<input type="hidden" name="guildId" value="${esc(servers[0].id)}">
                 <div class="in" style="opacity:.7">${esc(servers[0].name)}</div>`
              : `<select class="in" id="new-guild" name="guildId" required>
                   ${servers.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}
                 </select>`}
          </div>
          <div class="foot">
            <button class="btn go big" type="submit" ${can() ? '' : 'disabled'}>Start it</button>
            <button class="btn big" type="button" data-close-modal>Cancel</button>
          </div>
        </form>
      </div>
    </div>`;
}

// Renaming a campaign. The DM's and the bot owner's, from the pencil beside
// the name or the Name row in Settings. The bot checks the name leaves a
// usable folder and does not clash, and moves the notes folder with it.
function renameDialog() {
  const name = detail?.name || detail?.label || '';
  return `
    <div class="backdrop" data-backdrop>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Rename campaign">
        <div class="kicker">${esc(name)}</div>
        <h1>Rename this campaign</h1>
        <div class="say-2" style="font-size:14.5px;margin-top:12px">
          The new name is also the folder its notes are filed in and the start of every session
          reference. The notes folder moves with it, and nothing already written changes.
        </div>
        <form data-act="campaign/rename" data-campaign="${detail?.id ?? ''}">
          <div class="field">
            <label for="rename-name">New name</label>
            <input class="in" id="rename-name" name="name" required maxlength="100" autocomplete="off"
                   value="${esc(name)}">
          </div>
          <div class="foot">
            <button class="btn go big" type="submit">Rename</button>
            <button class="btn big" type="button" data-close-modal>Cancel</button>
          </div>
        </form>
      </div>
    </div>`;
}

// Deleting a campaign.
//
// The name has to be typed. Not a yes/no box — the whole purpose is to make the
// hand slow down and read which campaign this actually is, and a button you can
// hit twice in a temper is not a confirmation. The bot checks the typed name
// again on arrival, so this is a courtesy to whoever is looking at the screen
// rather than the thing standing between a campaign and its deletion.
function deleteDialog() {
  const name = detail?.name || detail?.label || '';
  return `
    <div class="backdrop" data-backdrop>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Delete campaign">
        <div class="kicker" style="color:var(--red-lit)">${esc(name)}</div>
        <h1>Delete this campaign?</h1>
        <div class="say-2" style="font-size:14.5px;margin-top:12px">
          It leaves every list straight away. <b>Nothing is erased</b> — every session, every line and
          every correction stays exactly where it is. It moves to the archive, where the bot owner can bring
          it back for ${RESTORE_DAYS} days; ask them with <code>/campaign restore</code> in Discord.
        </div>

        <form data-act="campaign/delete" data-campaign="${detail?.id ?? ''}">
          <div class="field">
            <label for="del-name">Type <b>${esc(name)}</b> to confirm</label>
            <input class="in" id="del-name" name="confirm" required autocomplete="off"
                   placeholder="${esc(name)}">
          </div>
          <div class="foot">
            <button class="btn go big danger" type="submit" ${can() ? '' : 'disabled'}>Delete it</button>
            <button class="btn big" type="button" data-close-modal>Keep it</button>
          </div>
        </form>
      </div>
    </div>`;
}

function voiceDialog() {
  // Always about the person who opened it — there is one place to open it
  // from now, and it is your own name in the transcript legend.
  //
  // Both lists are still read for what is already TAKEN: the roster knows the
  // whole table, the legend knows only who spoke tonight, and whichever is to
  // hand is better than neither. Sharing a colour is allowed, but nobody
  // should arrive at it by accident.
  const from = detail?.roster?.length ? detail.roster : (script?.speakers ?? []);
  const p = from.find((r) => String(r.userId) === String(view.picking));
  const label = p?.characterName || p?.name || (p ? whoIs(p) : 'you');

  const taken = new Map();
  for (const r of from) {
    if (r.colour && String(r.userId) !== String(view.picking)) {
      taken.set(r.colour, r.characterName || r.name || whoIs(r));
    }
  }

  return `
    <div class="backdrop" data-backdrop>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Pick a colour">
        <div class="kicker">${esc(label)}</div>
        <h1>How your name is written</h1>
        <div class="say-2" style="font-size:14.5px;margin-top:12px;max-width:58ch">
          In transcripts, and in corrections you make to a write-up. Nowhere else, and
          nobody else&rsquo;s: it changes nothing about what is recorded, what the notes say,
          or what anybody is called &mdash; only how quickly you can find one voice in four
          hours of talking. Per table, so the ranger you play on Tuesdays and the wizard
          you play on Fridays need not be the same colour.
        </div>

        <div class="voices">
          ${VOICE_FAMILIES.map(([family, name]) => {
            const holders = ['deep', 'bright'].map((s) => taken.get(`${family}-${s}`)).filter(Boolean);
            return `
            <div class="voice-row">
              <span class="fam">${esc(name)}</span>
              ${holders.length ? `<span class="taken">${esc(holders.join(', '))}</span>` : ''}
              ${['deep', 'bright'].map((shade) => {
                const slug = `${family}-${shade}`;
                const owner = taken.get(slug);
                return `<button type="button" class="voice-dot pick big v-${slug}${p?.colour === slug ? ' on' : ''}${owner ? ' taken' : ''}"
                          data-pick-voice="${slug}"
                          title="${esc(voiceName(slug))}${owner ? ` — already ${esc(owner)}` : ''}"><i class="swatch"></i></button>`;
              }).join('')}
            </div>`;
          }).join('')}
        </div>

        <div class="foot">
          <button class="btn big" type="button" data-pick-voice="">No colour</button>
          <button class="btn big" type="button" data-close-modal>Cancel</button>
        </div>
      </div>
    </div>`;
}

let modalShowing = null;

function renderModal() {
  const wanted = view.deleting
    ? 'delete'
    : view.renaming && detail ? `rename:${detail.id}`
    : view.creating ? 'create'
    : view.importing && detail ? `import:${detail.id}`
    : view.picking ? `voice:${view.picking}`
    : null;
  if (wanted === modalShowing) return;
  modalShowing = wanted;

  if (!wanted) { morph($('modal'), ''); return; }

  if (view.deleting) {
    morph($('modal'), deleteDialog());
    $('del-name')?.focus();
    return;
  }

  if (view.renaming) {
    morph($('modal'), renameDialog());
    $('rename-name')?.focus();
    $('rename-name')?.select?.();
    return;
  }

  if (view.picking) {
    morph($('modal'), voiceDialog());
    return;
  }

  if (view.creating) {
    morph($('modal'), createDialog());
    $('new-name')?.focus();
    return;
  }

  if (!detail) { morph($('modal'), ''); return; }
  const busy = (status?.recording ?? []).some((r) => r.guildId === detail.guildId);

  morph($('modal'), `
    <div class="backdrop" data-backdrop>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Import a recording">
        <div class="kicker">${esc(detail.label || detail.name)}</div>
        <h1>Import a recording</h1>
        <div class="say-2" style="font-size:14.5px;margin-top:12px">
          For a game played at a real table, or anything recorded outside Discord. It runs through the same
          transcribe, summarise and post pipeline.
        </div>

        <form data-act="import" data-campaign="${detail.id}">
          <div class="field">
            <label for="imp-url">The audio</label>
            <input class="in mono" id="imp-url" name="url" type="url" required
                   placeholder="https://…/session-15.m4a">
            <div class="mono" style="font-size:11px;color:var(--dim);margin-top:9px">
              a direct link Quill can download · m4a · mp3 · wav
            </div>
          </div>
          <div class="field">
            <label for="imp-speaker">Speaker label</label>
            <input class="in" id="imp-speaker" name="speaker" placeholder="The Table">
          </div>
          <div class="warnbox">
            <b>Every line will be attributed to one label.</b> A single microphone has no per-speaker
            channels, so Quill cannot tell your players apart. The notes will read as one voice describing
            the session.
          </div>
          ${busy ? `<div class="warnbox" style="border-color:var(--red)">
            That server is recording right now. Stop it with <code>/campaign leave</code> before importing, or the
            two sessions will interleave.</div>` : ''}
          <div class="foot">
            <button class="btn go big" type="submit" ${busy || !can() ? 'disabled' : ''}>Start the import</button>
            <button class="btn big" type="button" data-close-modal>Cancel</button>
            <span class="mono" style="font-size:11.5px;color:var(--dim);margin-left:auto">
              ${status?.working?.transcribing?.length ? 'joins the queue behind what is transcribing' : 'next in the queue · nothing is transcribing'}
            </span>
          </div>
        </form>
      </div>
    </div>`);

  $('imp-url')?.focus();
}

// Land on a line in a ledger and say which one. The wash names what you
// arrived at and then goes: a highlight that stayed would still be there the
// next time the shelf was opened, answering a question nobody had asked.
//
// The list is one document, so this is the whole of what following a name
// does — no page is opened and nothing is left behind to go back to.
function reveal(id) {
  const target = document.getElementById(id);
  if (!target) return;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView?.({ block: 'start', behavior: still ? 'auto' : 'smooth' });
  target.classList?.remove('flash');
  void target.offsetWidth;
  target.classList?.add('flash');
}

