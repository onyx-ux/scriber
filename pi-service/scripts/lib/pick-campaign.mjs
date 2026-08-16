// Turns whatever a maintenance script was given on the command line into a
// campaign row.
//
// These scripts have always been invoked with a guild id, because a guild WAS
// a campaign. Now it is not, so the argument is taken as a campaign id, a
// guild id or a campaign name — and a guild holding several campaigns is an
// error rather than a guess. Picking the oldest silently would rewrite the
// wrong table's vault notes, which is exactly what these scripts do too much
// of to get wrong quietly.
export function pickCampaign(db, which) {
  const wanted = String(which ?? '').trim();
  const all = db.listCampaigns();

  const byId = all.find((c) => String(c.id) === wanted);
  if (byId) return byId;

  const byName = all.find((c) => (c.name || '').toLowerCase() === wanted.toLowerCase());
  if (byName) return byName;

  const inGuild = all.filter((c) => c.guild_id === wanted);
  if (inGuild.length === 1) return inGuild[0];
  if (inGuild.length > 1) {
    const list = inGuild.map((c) => `  ${c.id}  ${c.name ?? '(unnamed)'}  (${c.sessions} sessions)`).join('\n');
    throw new Error(`guild ${wanted} holds ${inGuild.length} campaigns — name one:\n${list}`);
  }

  const list = all.map((c) => `  ${c.id}  ${c.name ?? '(unnamed)'}  guild ${c.guild_id}`).join('\n');
  throw new Error(`no campaign matches "${wanted}". Known campaigns:\n${list}`);
}
