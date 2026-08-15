export function resolveSpeakerName(db, guildId, userId, discordDisplayName) {
  const characterName = db.getCharacterName(guildId, userId);
  return characterName || discordDisplayName;
}

// Every name the people at this table answer to, for telling a summariser who
// is NOT an NPC.
//
// A player whose character is called something other than their Discord name
// used to be extracted as an NPC: the transcript is labelled "Brett", the
// table calls him BenTen, the model is handed an attendee list of Discord
// names, and BenTen looks for all the world like someone they met. So both
// halves go in — the label on the transcript AND the character behind it.
//
// Historic transcripts matter here as much as the current mapping. Speaker
// labels are resolved when the audio is captured, so a session recorded
// before /dm character was run is still labelled with the Discord name, and
// one recorded after is labelled with the character. Taking the union means a
// summary of either reads correctly.
export function rosterNames(db, guildId) {
  const names = new Set();

  // Every label the transcripts have ever used, not just the current one:
  // a session recorded as "Brett" and one recorded as "BenTen" are the same
  // player, and a summary of either has to know it.
  for (const displayName of db.listSpeakerNames(guildId)) names.add(displayName);

  for (const { characterName } of db.listRoster(guildId)) {
    if (characterName) names.add(characterName);
  }
  // The characters table can name someone who has not spoken yet — a player
  // set up before their first session.
  for (const { character_name: characterName } of db.listCharacters(guildId)) {
    if (characterName) names.add(characterName);
  }

  return [...names];
}
