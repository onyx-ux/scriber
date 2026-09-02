// Where the desk is, and whether this person can get to it.
//
// Two facts that were being spelled out separately in three places, and one of
// the three had it wrong.
//
// THE PATH. The dashboard lives at `/app/`, not at the root — the root is the
// landing page, which moved in when the two were split (see the nginx template:
// "the two serve different people and only one of them should be the first
// thing a stranger meets"). auth-routes.js has always known that and redirects
// there after sign-in. The owner's approval DM did not: it linked to
// `DASHBOARD_URL` bare, so the one message whose entire job is "come and make
// this decision" landed the reader on the marketing page and left them to find
// the dashboard themselves.
//
// `/app/` on its own is also the sign-on page, and that is why nothing here
// appends a fragment to ask for one. DASHBOARD_REQUIRE_LOGIN puts `loginRequired`
// in /me, and the page opens the Continue-with-Discord screen as a full-page
// takeover for anybody arriving without a session — see `gateOpen` in
// dashboard/html/index.html. So a signed-out reader gets the sign-in screen and
// a signed-in one gets their campaigns, off the same address. (The landing
// page's `#signin` fragment exists for the other case: an install running with
// DASHBOARD_REQUIRE_LOGIN off, where /app/ would draw the dashboard for an
// anonymous visitor. Not this one.)
//
// THE INVITATION. Whether to offer the link at all is a different question, and
// it is not "is a URL configured". DASHBOARD_ALLOWED_USERS, once set, is a
// guest list — an account off it can be told the address all day and still be
// refused at sign-in. So the offer is made only to somebody maySignIn will
// actually admit, and otherwise nothing is said at all. That is the same rule
// the gatehouse states for its own address: four out of five people with the
// dashboard open should never be shown a door they cannot go through.
import { maySignIn } from '../web/authority.js';

// The desk, as an address somebody can click in Discord: absolute, or null.
//
// Null rather than a relative path, and that distinction is the whole reason
// this is a second function. A relative `/app/` is a perfectly good answer for
// a browser that is already on the site, which is why dashboardHome() below
// returns one — but pasted into a DM it is not a link at all, just the
// characters "/app/" sitting in a sentence. A message that cannot produce a
// working address is better off saying nothing about one.
export function dashboardLink(cfg) {
  if (!cfg?.dashboardUrl) return null;
  try {
    return new URL('/app/', cfg.dashboardUrl).toString();
  } catch {
    // A malformed DASHBOARD_URL costs a link, not a boot.
    return null;
  }
}

// The same address for a caller that is already inside the site, where the
// relative form works and is the sensible fallback.
export function dashboardHome(cfg) {
  return dashboardLink(cfg) ?? '/app/';
}

// Whether a link is worth putting in front of this person: there has to be an
// address to send them to, and they have to be somebody the door will open for.
export function mayBeSentToDesk(cfg, db, userId) {
  return Boolean(dashboardLink(cfg)) && maySignIn(cfg, userId, db);
}

// The invitation itself, for the reply to /campaign create.
//
// Named for what the dashboard calls itself. "The desk" is the page's own word
// for the page — it says it a dozen times — and inventing a second name for it
// here would mean somebody reads about a dashboard, opens it, and finds a desk.
//
// Returns '' rather than null so callers can concatenate without a guard, the
// same shape unrecordedCaveat() and placesLeft() use.
export function deskInvitation({ cfg, db, userId, campaignName }) {
  if (!mayBeSentToDesk(cfg, db, userId)) return '';

  return (
    `\n\n🕯️ **The desk** — where everything I write ends up: ${dashboardLink(cfg)}\n` +
    `Sign in with Discord and **${campaignName}** is already on it: every session written up, ` +
    'everyone who was at the table, and the names I keep mishearing, so you can put them right. ' +
    'No password, nothing to set up.'
  );
}
