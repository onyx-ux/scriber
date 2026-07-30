export function resolveSpeakerName(db, guildId, userId, discordDisplayName) {
  const characterName = db.getCharacterName(guildId, userId);
  return characterName || discordDisplayName;
}
