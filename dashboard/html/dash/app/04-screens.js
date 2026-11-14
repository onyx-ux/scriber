// dashboard/html/dash/app/04-screens.js: Routing between screens.
//
// One of ten classic scripts that together are the dashboard, loaded in
// order by index.html and sharing one global scope. Split out of a single
// inline script on 2026-09-27 without changing a line; see ADR-0002.

// ==========================================================================
// Screens
// ==========================================================================

// Signing in.
//
// One step and no password. You press the button, Discord asks you, and you
// come back. Discord's answer is exactly as strong as "you control that
// account", and that is the only identity this bot has ever had a use for.
//
// This screen used to be two steps: you typed the Discord name the bot knew
// you by, it DMed you six digits, you typed those back. Everything about that
// was a reimplementation of something Discord already does — including the
// three ways it could fail that had nothing to do with you (the bot not
// sharing a server with you, the name typed a shade wrong, DMs turned off for
// the server), none of which exist here.
// What a sign-in can fail on, said in words rather than in the five the server
// puts on the end of the URL. The reason travels as a fragment because the
// callback is a redirect and has no body to put it in — see auth-routes.js.
const SIGNIN_TROUBLE = {
  denied: 'You told Discord no, so nothing happened. Nothing of yours was shared and you are not signed in.',
  state: 'That sign-in had gone stale — they only last ten minutes. Press the button again and it will work.',
  discord: 'Discord did not finish the sign-in. That is usually momentary; try again.',
  config: 'This bot is not set up for Discord sign-in yet, so there is nothing to sign in to.',
  // Handled by its own screen rather than a line of red text -- being turned
  // away is the one outcome here that is nobody's mistake, so it gets an
  // explanation and something to do rather than an error.
  notinvited: null,
  secret: 'This bot has no key to sign sessions with, so it cannot keep you signed in.',
};

// Where the ask got to. Nothing is stored anywhere until the button is
// pressed, so this is the whole of the state: what the server last said, and
// whether the button should still be live.
const invite = { asking: false, asked: false, failed: false, message: null };

async function askForInvite() {
  if (invite.asking || invite.asked) return;
  invite.asking = true;
  invite.message = null;
  renderScreen();

  try {
    const res = await fetch(`${API}/auth/ask`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    const payload = await res.json().catch(() => ({}));
    invite.asked = res.ok && payload.ok === true;
    invite.failed = !invite.asked;
    invite.message = payload.message ?? 'That did not go through. Try signing in again.';
  } catch {
    invite.failed = true;
    invite.message = `Could not reach the bot at ${API}. Try again in a moment.`;
  } finally {
    invite.asking = false;
    renderScreen();
  }
}

// Turned away at the door.
//
// Discord vouched for them and this bot's list did not, which is not an error
// and not their fault. So: say what Quill is, say plainly that the door is
// shut for now, and give them the one thing they can actually do about it.
function notInvitedScreen() {
  return `
    <div class="gate">
      <div class="gate-inner">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M20.5 2.6c-7 .9-11.8 5-14 11.4l-1.7 4.9 4.8-1.7C16 15 20 10.2 20.5 2.6Z" stroke="#2434A8" stroke-width="1.4" stroke-linejoin="round"/>
          <path d="M5.1 19.6 2.6 22.2" stroke="#2434A8" stroke-width="1.5" stroke-linecap="round"/>
        </svg>

        <p class="gate-eyebrow">Pre-alpha</p>
        <h1>Quill is not open yet.</h1>

        <p class="gate-say">
          Discord vouched for you — that part worked. Quill itself is still in pre-alpha and only
          lets in people it has been told about, so there is nothing behind this door for you today.
        </p>

        ${invite.asked
          ? `<p class="gate-msg">${esc(invite.message ?? 'Asked.')}</p>
             <p class="gate-say">
               Nothing else to do. Whoever runs this bot decides, and you will simply be able to
               sign in the next time you try.
             </p>`
          : `
          <div class="gate-btns">
            <button class="gate-btn discord" type="button" data-ask-invite ${invite.asking ? 'disabled' : ''}>
              ${invite.asking ? 'Asking…' : 'Request an invite'}
            </button>
          </div>
          <p class="gate-say quiet-say">
            This puts your Discord name in a queue for whoever runs Quill. Nothing else is sent and
            nothing is shared.
          </p>`}

        ${invite.failed && invite.message
          ? `<p class="gate-msg bad">${esc(invite.message)}</p>`
          : ''}

        <p class="gate-foot">
          Quill records a table's session, writes up what happened, and keeps the campaign's notes in
          one place. It asked Discord for one thing, the smallest it offers: who you are. Not your
          email, not your servers, and nothing it could post or change on your behalf.
        </p>

        <a class="gate-back" href="/">&larr; Back to the landing page</a>
      </div>
    </div>`;
}

function signInScreen() {
  return `
    <div class="gate">
      <div class="gate-inner">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M20.5 2.6c-7 .9-11.8 5-14 11.4l-1.7 4.9 4.8-1.7C16 15 20 10.2 20.5 2.6Z" stroke="#2434A8" stroke-width="1.4" stroke-linejoin="round"/>
          <path d="M5.1 19.6 2.6 22.2" stroke="#2434A8" stroke-width="1.5" stroke-linecap="round"/>
        </svg>

        <p class="gate-eyebrow">One step</p>
        <h1>Sign in to Quill.</h1>

        <p class="gate-say">
          Quill asks Discord who you are — nothing else. There is no password to set, no username to
          spell right and no code to wait for; you say yes on Discord&rsquo;s own screen and come
          straight back here.
        </p>

        ${me && !me.signInAvailable ? `
          <p class="gate-msg bad">
            This bot is not set up for Discord sign-in, so nobody can sign in yet.
            Set <code>${esc(me.signInMissing ?? 'DISCORD_CLIENT_SECRET')}</code> in <code>pi-service/.env</code>.
          </p>` : `
          <div class="gate-btns">
            <a class="gate-btn discord" href="${API}/auth/discord">
              <svg width="21" height="16" viewBox="0 0 71 55" fill="currentColor" aria-hidden="true">
                <path d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.440769 45.4204 0.525289C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.525289C25.5141 0.443589 25.4218 0.40133 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309 -0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C6.45866 50.0174 12.3413 52.7249 18.1147 54.5195C18.2071 54.5477 18.305 54.5139 18.3638 54.4378C19.7295 52.5728 20.9469 50.6063 21.9907 48.5383C22.0523 48.4172 21.9935 48.2735 21.8676 48.2256C19.9366 47.4931 18.0979 46.6001 16.3292 45.5858C16.1893 45.5041 16.1781 45.304 16.3068 45.2082C16.679 44.9293 17.0513 44.6391 17.4067 44.3461C17.4711 44.2926 17.5606 44.2813 17.6362 44.3151C29.2558 49.6202 41.8354 49.6202 53.3179 44.3151C53.3935 44.2785 53.4831 44.2898 53.5502 44.3433C53.9057 44.6363 54.2779 44.9293 54.6529 45.2082C54.7816 45.304 54.7732 45.5041 54.6333 45.5858C52.8646 46.6198 51.0259 47.4931 49.0921 48.2228C48.9662 48.2707 48.9102 48.4172 48.9718 48.5383C50.038 50.6035 51.2554 52.57 52.5959 54.435C52.6519 54.5139 52.7526 54.5477 52.845 54.5195C58.6464 52.7249 64.529 50.0174 70.6019 45.5576C70.6551 45.5182 70.6887 45.459 70.6943 45.3942C72.1747 30.0791 68.2147 16.7757 60.1968 4.9823C60.1772 4.9429 60.1437 4.9147 60.1045 4.8978ZM23.7259 37.3253C20.2276 37.3253 17.3451 34.1136 17.3451 30.1693C17.3451 26.2249 20.1717 23.0132 23.7259 23.0132C27.3081 23.0132 30.1626 26.2531 30.1066 30.1693C30.1066 34.1136 27.2801 37.3253 23.7259 37.3253ZM47.3178 37.3253C43.8196 37.3253 40.9371 34.1136 40.9371 30.1693C40.9371 26.2249 43.7636 23.0132 47.3178 23.0132C50.9 23.0132 53.7545 26.2531 53.6986 30.1693C53.6986 34.1136 50.9 37.3253 47.3178 37.3253Z"/>
              </svg>
              Continue with Discord
            </a>
          </div>`}

        ${login.message
          ? `<p class="gate-msg${login.failed ? ' bad' : ''}">${esc(login.message)}</p>`
          : ''}

        ${me?.loginRequired ? '' : `
          <div class="gate-btns">
            <button class="gate-btn plain" type="button" data-signin-cancel>Not now — keep looking as the operator</button>
          </div>`}

        <p class="gate-foot">
          Quill asks Discord for one thing, the smallest it offers: who you are. Not your email, not
          your servers, and nothing it could ever post or change on your behalf. It keeps your Discord
          id and the name attached to it, and nothing else — what you can see is worked out from what
          that account owns, runs and plays in.
        </p>

        <a class="gate-back" href="/">&larr; Back to the landing page</a>
      </div>
    </div>`;
}

// ==========================================================================
// Which screen is drawn
// ==========================================================================
//
// Moved here from 05-threshold.js on 2026-11-14, unchanged. It decides between
// every screen the page has, of which the threshold is one, and that file had
// reached the 1,500 lines docs/adr/0002 says to stop and look at.

function renderScreen() {
  const el = $('screen');

  const arriving = Date.now() < entersUntil ? 'arriving' : '';

  // The threshold comes before everything, including the gate: somebody who
  // has just signed in for the first time gets this screen and no dashboard
  // behind it. Drawn once per step rather than on every poll — the writing is
  // in the DOM and a five-second repaint would start it over.
  if (welcome.open) {
    document.body.classList.remove('gate-open');
    document.body.classList.add('thr-open');
    const key = `thr-${welcome.step}`;
    if (welcomeKey !== key) {
      welcomeKey = key;
      el.className = '';
      morph(el, welcomeScreen());
      // After the markup has actually landed, and through whichever of the two
      // exists — the render harness has no frames to wait for.
      if (window.requestAnimationFrame) window.requestAnimationFrame(welcomeWrite);
      else setTimeout(welcomeWrite, 0);
    }
    return;
  }
  document.body.classList.remove('thr-open');

  // Nobody home. Shown instead of the app rather than over it: a dashboard
  // that renders its chrome and then refuses every request is a worse way to
  // learn you are signed out than being asked to sign in.
  // Sign-in is shown when this install demands it, and also when somebody
  // asks for it. Without the second case there was no way to sign in at all
  // while DASHBOARD_REQUIRE_LOGIN was off — which made the one safe order
  // for turning it on (sign in first, so you cannot lock yourself out)
  // impossible to follow.
  // Toggled here rather than in paint() so the class and the screen can never
  // disagree: whatever this function decides to draw is what the body is
  // dressed for. body.gate-open folds away the top bar and turns the page to
  // paper, because the gate is a full-page takeover in the landing
  // page's world rather than a card floating in the dark tool.
  const gateOpen = Boolean(me && !me.signedIn && (me.loginRequired || view.signingIn));
  document.body.classList.toggle('gate-open', gateOpen);

  if (gateOpen) {
    el.className = '';
    // Turned away is its own screen, not a red line under the sign-in button.
    // Offering Continue with Discord again to somebody Discord has already
    // vouched for is a loop, and the loop is what makes it read as a fault.
    morph(el, view.notInvited ? notInvitedScreen() : signInScreen());
    return;
  }

  // The desk. Answered before everything else because it is where the page
  // starts and where the quill goes back to.
  if (view.screen === 'desk' && status?.campaigns?.length) {
    el.className = arriving;
    morph(el, deskScreen());
    return;
  }

  // The ledger of tables, one step in from the desk.
  if (view.screen === 'campaigns' && status?.campaigns?.length) {
    el.className = arriving;
    morph(el, campaignsScreen());
    return;
  }

  if (view.screen === 'transcript') { el.className = 'split'; morph(el, transcriptScreen()); return; }
  if (view.screen === 'servers')    { el.className = arriving; morph(el, serversScreen()); return; }
  if (view.screen === 'usage')      { el.className = arriving; morph(el, usageScreen()); return; }

  if (status && !status.campaigns?.length) { el.className = ''; morph(el, firstRun()); return; }

  // The campaign column is a column on a wide window, folded away when its
  // reader asks, and a drawer over the page on a narrow one. Whichever way it
  // is not showing, the ribbon over the pane is the way back to it.
  const wide = railWide();
  const folded = wide && railFolded();
  const drawer = !wide && view.drawer;
  document.body.classList?.toggle?.('drawer-lock', drawer);
  el.className = `split ${arriving}${folded ? ' rail-folded' : ''}${drawer ? ' drawer-open' : ''}`.trim();
  morph(el, `
    <div class="sessions" id="campaign-column"${wide ? '' : ` role="dialog" aria-label="This campaign"${drawer ? ' aria-modal="true"' : ' inert'}`}>
      ${columnBar(wide)}
      <div class="shelf-slider ${view.shelfPicking ? 'picking' : 'picked'}">
        <div class="shelf-page chooser" ${view.shelfPicking ? '' : 'aria-hidden="true"'}>
          ${shelfChooser()}
        </div>
        <div class="shelf-page list" ${view.shelfPicking ? 'aria-hidden="true"' : ''}>
          ${shelfHeader()}
          ${columnList()}
          ${view.shelf === 'sessions' && cap('machinery') ? `
            <div class="foot">
              <button class="btn wide" data-import>${detail?.sessions?.length ? 'Import a recording' : 'Import a recording instead'}</button>
            </div>` : ''}
        </div>
      </div>
    </div>
    ${wide ? '' : '<div class="drawer-scrim" data-rail-close aria-hidden="true"></div>'}
    <div class="pane">
      ${ribbon(wide, folded, drawer)}
      <div class="pane-main${view.tab === 'notes' && view.shelf === 'sessions' && marking() ? ' marking' : ''}">
        ${tabsBar()}
        ${paneBody()}
      </div>
      ${view.tab === 'notes' && view.shelf === 'sessions' ? factsRail() : ''}
    </div>`);
}

// --- the first run ---------------------------------------------------------

function firstRun() {
  const h = status?.health ?? {};
  return `
    <div class="center">
      <div class="kicker">Nothing has been recorded yet</div>
      <h1 class="display" style="font-size:44px;margin-top:18px">Quill is on your server and listening for a table.</h1>
      <div class="say-2" style="font-size:16px">Four things to do once, then it runs on its own.</div>
      <div class="steps" style="margin-top:36px">
        <div>
          <span class="mark done">✓</span>
          <div style="flex:1">
            <div class="what">Quill is signed in${status?.servers?.length ? ` on ${plural(status.servers.length, 'server')}` : ''}</div>
            <div class="sub">${esc(status?.bot?.user || 'connecting…')}${status?.bot?.uptimeMs ? ` · ${uptime(status.bot.uptimeMs)}` : ''}</div>
          </div>
        </div>
        <div class="now">
          <span class="mark" style="border-color:var(--brass);color:var(--brass)">2</span>
          <div style="flex:1">
            <div class="what" style="font-weight:500">Make a campaign</div>
            <div class="sub" style="font-family:var(--sans);font-size:13px">One per game. It holds the roster, the corrections and every session.</div>
          </div>
          ${canCreate()
            ? `<button type="button" class="btn sm go" data-new-campaign>New campaign</button>`
            : `<code>/campaign create</code>`}
        </div>
        <div>
          <span class="mark">3</span>
          <div style="flex:1">
            <div class="what" style="color:var(--dim)">Point it at a voice channel</div>
            <div class="sub" style="font-family:var(--sans);font-size:13px">Run it from the channel you are playing in. Quill records until somebody ends the session with <code>/campaign leave</code>.</div>
          </div>
          <code>/campaign join</code>
        </div>
        <div>
          <span class="mark">4</span>
          <div style="flex:1">
            <div class="what" style="color:var(--dim)">Ask the table</div>
            <div class="sub" style="font-family:var(--sans);font-size:13px">Nobody is recorded until they say yes in a DM.</div>
          </div>
          <code>/campaign invite</code>
        </div>
      </div>
      <div class="quiet" style="margin-top:26px">
        The transcriber runs on your own machine —
        ${h.whisperServer === false ? 'Quill cannot reach it right now.' : h.whisperServer ? 'Quill can reach it.' : 'Quill has not checked yet.'}
        ${status?.health?.cloudTranscribe ? '' : 'Nothing is uploaded to be transcribed.'}
      </div>
    </div>`;
}
