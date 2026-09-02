// Where a live progress line should go.
//
// "Transcribing 99/3454 (2%) — ~17m left" is operational: it is about the
// owner's hardware and the owner's queue, not about the game. Posting it into
// the table's channel narrates the plumbing at people who just want their
// notes, so progress goes to the owner's DM instead.
//
// The session notes themselves are NOT routed through here — those are the
// deliverable and stay public, along with the thematic join and leave lines.
//
// Falls back to the channel when there is no owner to DM (or the DM cannot be
// opened, which Discord allows anyone to arrange): a status line in the wrong
// place is better than a long silent job that looks like a crash.
export async function resolveProgressTarget(discordClient, cfg, meeting) {
  if (!discordClient) return null;

  if (cfg.ownerUserId) {
    try {
      const user = await discordClient.users.fetch(cfg.ownerUserId);
      return await user.createDM();
    } catch {
      // DMs closed or the user is unreachable — fall back below.
    }
  }

  const channelId = cfg.notesChannelId || meeting?.channel_id;
  if (!channelId) return null;
  return discordClient.channels?.fetch(channelId).catch(() => null);
}
