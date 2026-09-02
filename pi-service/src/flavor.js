// Whimsical, randomly-cycled flavor text for everything the bot says in
// Discord. Each category has ~20 variants so the bot doesn't sound like a
// robot reading the same line every session. pick() just grabs a random one
// and fills in {placeholders} — nothing fancier than that is needed here.

function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] ?? ''));
}

export function pick(list, vars = {}) {
  const template = list[Math.floor(Math.random() * list.length)];
  return fmt(template, vars);
}

// {name}
//
// The opening line of a new campaign, and the first sentence Quill says to
// somebody who has just decided to try it. Only the OPENING is cycled — what
// follows it in commands/index.js is a fixed set of facts, because the reply
// that tells you where your notes will live is not a place for twenty
// phrasings of the same sentence. The thematic half varies; the load-bearing
// half does not.
//
// Every one of these names the campaign, on purpose: the name was typed
// seconds ago and getting it back, spelled the way it will be spelled in the
// vault folder forever, is the one check somebody can make before their first
// session rather than after their eleventh.
export const CAMPAIGN_CREATED = [
  '📖 **{name}** — the spine cracks, and the first page is blank.',
  '🕯️ A candle is lit over an empty ledger. **{name}** begins here.',
  '🪶 The quill is cut and the ink is fresh. **{name}** has its first blank page.',
  '📜 A new scroll, unrolled and weighted at the corners: **{name}**.',
  '🗝️ A shelf is cleared in the archive, and a key cut for it. **{name}**.',
  '🧙 The scribe accepts the commission. **{name}** it is.',
  '🐦 The familiar has been given a new name to answer to: **{name}**.',
  '🧾 A fresh ledger, opened and headed **{name}**.',
  '⚗️ Clean bench, empty vessels. **{name}** is ready to be distilled.',
  "🌙 The first night of **{name}** hasn't happened yet. I'm ready for it.",
  '🕰️ The clock is wound and set back to nothing. **{name}** starts here.',
  '🐉 The hoard has a new vault, and it is called **{name}**.',
  '🗿 The first stone is set. **{name}** begins.',
  '📯 Let the record show that **{name}** exists, and that it is yours.',
  '🧝 The chronicler sharpens a nib and writes **{name}** at the top of the page.',
  '⛩️ A new shrine, swept and empty. **{name}** is ready.',
  '🔮 The crystal ball clouds, clears, and shows **{name}** — nothing in it yet.',
  '🧠 A new memory, entirely empty. **{name}** starts filling the moment you sit down.',
  '🎙️ Levels checked, tape threaded. **{name}** is ready to roll.',
  '🕸️ The loom is strung for **{name}**. Not a thread woven yet.',
];

export const JOIN_NO_CHANNEL = [
  "🧙 I can't record a voice channel you're not in. Join one first.",
  '🕯️ Quill needs a room to sit in — hop into a voice channel first.',
  "🐦 A familiar can't follow you if you're nowhere to be found. Join a voice channel first.",
  '📜 There is no scene to record — join a voice channel first.',
  '🗝️ The archive requires a location. Join a voice channel, then try again.',
  "🧝 I'd love to eavesdrop, but you'll need to be in a voice channel first.",
  "🔮 The crystal ball shows... nothing. You're not in a voice channel.",
  '🪶 The quill has nothing to write about — join a voice channel first.',
  "🕰️ History can't be made from an empty room. Join a voice channel first.",
  '📯 The herald has no one to announce — join a voice channel first.',
  "🐉 Even I can't record silence from the void. Join a voice channel first.",
  '📖 This chapter needs a setting — join a voice channel to begin.',
  '🌙 No session brews here. Join a voice channel first.',
  '⚗️ Nothing to distill yet — join a voice channel first.',
  '🕸️ No threads to weave — you need to be in a voice channel first.',
  '🧾 The ledger stays blank until you join a voice channel.',
  "🧠 I can't recall what I never heard — join a voice channel first.",
  "🎙️ Microphone's pointed at an empty room. Join a voice channel first.",
  '🗿 Even ancient stones need a room to echo in. Join a voice channel first.',
  '🧙‍♂️ Step into a voice channel, and the recording shall follow.',
];

// Two different noes, since the day a second bot user made them different
// things. THIS one is "that room is already being recorded" — a second /join
// into a channel somebody is already recording, which is still one room
// however many bots the install has, and says nothing about the rest of the
// server. The list below is the other: every voice this install has is
// already in a channel here.
export const JOIN_CHANNEL_BUSY = [
  "🧙 I'm already scribbling away in this very channel — no need to ask twice.",
  '📜 The quill is already moving in this room.',
  "🕯️ The candle's already lit in here — this channel is being recorded.",
  '🔮 The crystal ball is already watching this room.',
  "🧾 One scroll per room — I'm already recording this channel.",
  '📖 This chapter is already being written, right here.',
  "⚗️ Already distilling this room's session — can't start a second brew in it.",
  '🎙️ Already rolling in this channel — no double recordings.',
  '🗿 These stones are already echoing. This channel is being recorded.',
  '🐉 One dragon, one ledger — this room already has mine.',
  "🪶 The quill's already dancing in here.",
  '⛩️ One shrine, one scribe — this room is already spoken for.',
];

// Every voice this install has is already in a channel in this Discord. With
// one bot that is the whole of "I'm already recording in this server"; with
// more, handleJoin adds the count, since the number is the thing to act on.
export const JOIN_ALREADY_RECORDING = [
  "🧙 I'm already scribbling away in this server — one session at a time.",
  '📜 The quill is already moving. Already recording in this server.',
  "🕯️ The candle's already lit — I'm already recording here.",
  "🐦 The familiar's already perched and listening. Already recording in this server.",
  '🔮 The crystal ball is already watching this server.',
  "🗝️ The tome's already open — already recording in this server.",
  "🧾 One scroll at a time — I'm already recording this server.",
  '📖 This chapter is already being written. Already recording here.',
  '🌙 The night is already being chronicled in this server.',
  "⚗️ Already distilling this session — can't start a second brew.",
  "🕸️ Already weaving this session's threads — one tapestry at a time.",
  "🧠 I'm already listening in this server, no need to ask twice.",
  '🎙️ Already rolling in this server — no double recordings.',
  "🐉 One dragon, one ledger — I'm already recording here.",
  '🗿 The stones are already echoing this session.',
  '📯 The herald is already on duty in this server.',
  "🧝 Already chronicling this one — can't split my attention across two.",
  "🕰️ Time's already being kept in this server. Already recording.",
  "🪶 The quill's already dancing — already recording in this server.",
  '⛩️ One shrine, one scribe — already recording here.',
];

export const JOIN_STARTED = [
  '🧙 A hooded scribe slips into **{channel}**, quill already scratching against parchment.',
  '📜 The court recorder has entered **{channel}** — speak clearly, adventurers.',
  '🕯️ A spectral quill begins hovering over fresh parchment in **{channel}**.',
  '🐉 The dragon in the corner of **{channel}** cracks open a ledger and starts writing.',
  '🧝 An elven chronicler tucks into **{channel}**, ready to immortalise your legend.',
  '📖 The Tome of Record creaks open in **{channel}**. Every word from here is history.',
  '🕰️ Time itself pauses to listen — recording begins in **{channel}**.',
  '🪶 A raven lands in **{channel}**, quill in beak, ready to transcribe your deeds.',
  '🔮 The crystal ball in **{channel}** flickers to life, watching, listening, recording.',
  "🧙‍♂️ 'Ahem. Testing, testing.' The wizard's notes begin in **{channel}**.",
  '📯 A herald announces: the chronicles of **{channel}** begin now.',
  '🕯️ Candles flicker as the Keeper of Records settles into **{channel}**.',
  '🗝️ A hidden archivist unlocks their notebook in **{channel}**. Let the tale begin.',
  '🐦 A tiny familiar perches nearby, taking down every word spoken in **{channel}**.',
  '📚 The Library of This Very Session opens a new chapter in **{channel}**.',
  '🕸️ Threads of fate are being woven into ink — recording started in **{channel}**.',
  "🧾 The guild scribe unrolls a fresh scroll in **{channel}**. Don't waste it on small talk.",
  "🌙 Under a watchful moon, tonight's tale begins recording in **{channel}**.",
  '⚗️ A memory-bottling ritual begins in **{channel}** — every word, preserved.',
  '🎙️ Recording started in **{channel}**. Quill is listening, and so is history.',
];

export const LEAVE_NOT_RECORDING = [
  "🧙 There's nothing to stop — I'm not currently recording here.",
  "📜 The quill's already still. Not currently recording.",
  "🕯️ No candle burning here — I'm not recording this server right now.",
  "🐦 The familiar flew off ages ago. Not currently recording.",
  '🔮 The crystal ball is dark. Not currently recording.',
  "🗝️ There's no open tome to close — not currently recording.",
  '🧾 No scroll in progress — not currently recording.',
  '📖 No chapter is being written right now. Not currently recording.',
  "🌙 Quiet night — I'm not recording anything here.",
  "⚗️ Nothing's brewing — not currently recording.",
  "🕸️ No threads being woven right now — not currently recording.",
  "🧠 I've nothing queued in memory — not currently recording.",
  "🎙️ Nothing's rolling — not currently recording.",
  "🐉 The ledger's shut — I'm not recording this server.",
  '🗿 Silent stones — not currently recording.',
  '📯 No herald on duty — not currently recording.',
  "🧝 I've already wandered off — not currently recording here.",
  "🕰️ No time being kept right now — not currently recording.",
  '🪶 The quill is resting — not currently recording.',
  '⛩️ The shrine is empty — not currently recording.',
];

// /leave no longer transcribes — it stops recording and queues the session
// for later (see pipeline/transcribe-schedule.js). These used to say the
// scribe "begins the long work of transcription", which read fine when it was
// true and became a lie the moment transcription moved behind the schedule:
// the table would be told the work was underway while nothing was happening,
// possibly until Monday. So they now describe the tome being CLOSED and set
// aside, which is exactly what happened.
export const LEAVE_START = [
  '⏳ Quill closes the tome and sets it aside for later.',
  '🖋️ Setting down the quill. Tonight\'s pages are safe until the archivist returns.',
  '📜 Rolling up the scroll and tying it off. It keeps.',
  "🧙 'Enough for tonight,' the wizard mutters, stacking the notes with care.",
  '🕯️ The candle is snuffed. Tonight\'s events wait in the dark, unread.',
  '🔍 Every word tonight is on paper. Making sense of it is a job for later.',
  '🪄 The recording sigil dims. What was spoken is captured and sealed.',
  '📖 Closing the Tome of Record. Nothing is lost; nothing is read yet.',
  '🧾 The guild scribe grumbles about everyone talking at once, and files it anyway.',
  '🕰️ The hourglass is turned on its side. Tonight keeps until it is called for.',
  '🐦 The familiar carries tonight\'s pages to the archive and roosts.',
  '🧠 Every word remembered, filed, and left for a quieter hour.',
  '⚗️ Tonight\'s chaos is bottled and shelved, waiting to be distilled.',
  '📚 Tonight\'s chapter is filed unopened in the grand campaign archive.',
  '🕸️ The threads of conversation are gathered up, tangles and all, for later.',
  '🪶 The raven returns to its perch. The reading can wait.',
  '🗝️ Tonight\'s secrets are locked away, safe until someone turns the key.',
  '🌒 The session ends and the ink dries. History can be read another day.',
  '🔮 The crystal ball goes dark, holding tonight\'s events until summoned.',
  '⏳ Recording stopped. Tonight is safely on the shelf.',
];


// {label}
export const SUMMARIZE_UNREACHABLE = [
  "🔮 The Oracle's tower is dark — {label} still isn't reachable. It'll retry automatically too.",
  "🧙 Still no answer from {label}. It'll retry in the background.",
  '📡 Signal lost to {label} — the summarising wizard is still unreachable, but retries continue quietly.',
  "🕯️ Knocked on {label}'s door — no one home yet. Auto-retry is still running.",
  "🐦 The familiar returned empty-winged from {label} — still unreachable. It'll keep trying.",
  "⚗️ The distillation machine ({label}) is still cold. Background retries continue.",
  "🗝️ Still can't reach {label}'s chamber. Retrying automatically.",
  '{label} still isn\'t reachable. It\'ll retry automatically in the background too.',
  "🧾 No reply from {label} yet — the queue will keep knocking.",
  '🌙 {label} sleeps on. Background retries continue.',
  "🕰️ Still waiting on {label} to answer. Retrying automatically in the meantime.",
  '📖 That chapter awaits {label} — still unreachable, retrying quietly.',
  "🧠 My connection to {label} remains silent. Auto-retry continues.",
  '🐉 {label} is still asleep. Retries continue in the background.',
  '🗿 No echo back from {label} yet. Background retries continue.',
  '📯 No herald could reach {label} — still unreachable, retrying automatically.',
  "🧝 The messenger sent to {label} hasn't returned. Retrying automatically.",
  '⛩️ The shrine of {label} remains dark. Auto-retry continues quietly.',
  "🪶 Still no word back from {label}. It'll retry automatically too.",
  "{label} still isn't reachable. It'll retry automatically in the background too.",
];


// {session}, {channel}, {date}
export const EXPORT_INTRO = [
  "📜 Here's the full transcript for {session} ({channel}, {date}).",
  "🗝️ Unsealing the archive for {session} ({channel}, {date}).",
  '📖 Pulling {session} ({channel}, {date}) off the shelf for you.',
  "🧾 The scroll for {session} ({channel}, {date}), delivered.",
  "🕯️ Dusting off the record of {session} ({channel}, {date}).",
  '🐦 The familiar fetches the transcript for {session} ({channel}, {date}).',
  "🔮 Replaying {session} ({channel}, {date}) from the archive.",
  '🧙 Here is what was said in {session} ({channel}, {date}).',
  "🌙 The record of that night — {session} ({channel}, {date}).",
  '⚗️ The distilled transcript of {session} ({channel}, {date}).',
  '🕰️ Turning back the clock to {session} ({channel}, {date}).',
  '🧠 Everything recalled from {session} ({channel}, {date}).',
  '🎙️ The full tape of {session} ({channel}, {date}).',
  '🐉 The hoard yields the transcript for {session} ({channel}, {date}).',
  '🗿 Carved in full: {session} ({channel}, {date}).',
  '📯 Announcing the transcript for {session} ({channel}, {date}).',
  '🧝 The chronicle of {session} ({channel}, {date}), retrieved.',
  '⛩️ Retrieved from the shrine: {session} ({channel}, {date}).',
  '🪶 The full quill-work of {session} ({channel}, {date}).',
  "Transcript for {session} ({channel}, {date}).",
];

// {name}
export const SETCHARACTER_CONFIRM = [
  "🧙 Noted — you'll appear as **{name}** in every transcript and recap from now on.",
  "📜 Your true name has been inscribed: **{name}**. That's how you'll show up from now on.",
  "🗝️ The archive now knows you as **{name}**.",
  "🧾 Recorded in the ledger: you are **{name}** henceforth.",
  "🕯️ By candlelight, your name is set: **{name}**.",
  "🐦 The familiar will now call you **{name}** in every record.",
  "🔮 The crystal ball now sees you as **{name}**.",
  "🧝 From this session on, you're known in the chronicles as **{name}**.",
  "🌙 Under this name you shall be remembered: **{name}**.",
  "⚗️ Distilled down to one true name: **{name}**.",
  "🕰️ History will record you as **{name}** from here on.",
  "🧠 Committed to memory: you are **{name}**.",
  "🎙️ On record: you're **{name}** from now on.",
  "🐉 Even the dragon will note you as **{name}** going forward.",
  "🗿 Carved into the stone: **{name}**.",
  "📯 Let it be announced: you are **{name}**.",
  "⛩️ The shrine accepts your name: **{name}**.",
  "🪶 Inked in for good: **{name}**.",
  "🧙‍♂️ Got it — you'll show up as **{name}** in transcripts and notes from now on.",
  "Got it — you'll show up as **{name}** in transcripts and notes from now on.",
];


export const RECAP_NONE = [
  '📭 No completed sessions yet — nothing to recap.',
  "📜 The chronicle hasn't its first finished chapter yet.",
  '🗝️ The vault holds no finished tales yet.',
  '🧾 No completed sessions in the ledger yet.',
  "🕯️ No candle has burned through a full recap yet.",
  '🐦 The familiar has nothing finished to recite yet.',
  '🔮 The crystal ball shows no completed sessions yet.',
  '🧙 No recap exists yet — the tale is still being written.',
  '🌙 No night has reached its recap yet.',
  "⚗️ Nothing's been fully distilled into a recap yet.",
  '🕰️ History has no finished chapter to recall yet.',
  '🧠 My memory holds no completed recaps yet.',
  '🎙️ Nothing finished on the tape yet.',
  "🐉 The dragon's hoard has no finished tales yet.",
  '🗿 No stone bears a finished recap yet.',
  '📯 Nothing to proclaim yet — no completed sessions.',
  '🧝 The chronicler awaits a finished tale.',
  '⛩️ The shrine holds no completed recap yet.',
  '🪶 No ink has dried on a finished recap yet.',
  'No completed sessions yet.',
];

// {channel}, {date}
export const RECAP_HEADER = [
  '📜 **Recap — {channel} ({date})**',
  '🧙 **The Tale So Far — {channel} ({date})**',
  '🗝️ **From the Archive — {channel} ({date})**',
  '🕯️ **By Candlelight — {channel} ({date})**',
  '🐦 **As the Familiar Recalls — {channel} ({date})**',
  '🔮 **The Crystal Ball Remembers — {channel} ({date})**',
  '🌙 **Last We Left Off — {channel} ({date})**',
  '⚗️ **Distilled Memory — {channel} ({date})**',
  '🕰️ **A Look Back — {channel} ({date})**',
  '🧠 **What I Remember — {channel} ({date})**',
  '🎙️ **Previously, on {channel} ({date})**',
  '🐉 **From the Hoard — {channel} ({date})**',
  '🗿 **Carved in Stone — {channel} ({date})**',
  '📯 **Hear Ye — {channel} ({date})**',
  '🧝 **The Chronicler Speaks — {channel} ({date})**',
  '⛩️ **From the Shrine — {channel} ({date})**',
  '🪶 **Ink Still Fresh — {channel} ({date})**',
  '📖 **Last Chapter — {channel} ({date})**',
  '🧾 **On the Ledger — {channel} ({date})**',
  '📜 **Recap — {channel} ({date})**',
];

// {channel}, {date}
export const POST_SESSION_HEADER = [
  '# 🐉 Session Recap — {channel} ({date})',
  '# 🧙 The Wizard\'s Notes — {channel} ({date})',
  '# 📜 Chronicle Entry — {channel} ({date})',
  '# 🕯️ By Candlelight — {channel} ({date})',
  '# 🗝️ From the Archive — {channel} ({date})',
  '# 🐦 The Familiar Reports — {channel} ({date})',
  '# 🔮 The Crystal Ball Recalls — {channel} ({date})',
  '# 🌙 Last Night\'s Tale — {channel} ({date})',
  '# ⚗️ Distilled Memories — {channel} ({date})',
  '# 🕰️ A Look Back — {channel} ({date})',
  '# 🧠 What Was Remembered — {channel} ({date})',
  '# 🎙️ Previously... — {channel} ({date})',
  '# 🗿 Carved in Stone — {channel} ({date})',
  '# 📯 Hear Ye, Hear Ye — {channel} ({date})',
  '# 🧝 The Chronicler\'s Account — {channel} ({date})',
  '# ⛩️ From the Shrine of Record — {channel} ({date})',
  '# 🪶 Fresh Ink — {channel} ({date})',
  '# 📖 Another Chapter Closes — {channel} ({date})',
  '# 🧾 The Guild Ledger — {channel} ({date})',
  '# 🐉 Session Recap — {channel} ({date})',
];

export const POST_SESSION_ATTACHMENT_CAPTION = [
  '📎 Full session markdown (transcript + notes) — drop into Obsidian:',
  '📎 The complete chronicle, ready for your Obsidian vault:',
  '📎 Everything that happened, in full — for Obsidian:',
  '📎 The unabridged record (transcript + notes), Obsidian-ready:',
  '📎 A copy for the archive — drop this into Obsidian:',
  '📎 The full scroll, transcript and all, for Obsidian:',
  '📎 Complete notes attached — Obsidian-ready as always:',
  '📎 The whole session, transcribed and summarised, for your vault:',
  '📎 Here\'s the full write-up (transcript + notes) for Obsidian:',
  '📎 Filed and ready — full session markdown for Obsidian:',
  '📎 The complete record, transcript included, Obsidian-ready:',
  '📎 Nothing left out — full markdown for your Obsidian vault:',
  '📎 The definitive account (transcript + notes) — Obsidian-ready:',
  '📎 Everything said and summarised, packaged for Obsidian:',
  '📎 The full session file, ready to drop into your vault:',
  '📎 Complete transcript + notes, Obsidian-formatted:',
  '📎 The whole record, start to finish, for Obsidian:',
  '📎 A full accounting of tonight, Obsidian-ready:',
  '📎 The archive copy — transcript and notes, for Obsidian:',
  '📎 Full session markdown (transcript + notes) — drop into Obsidian:',
];

export const FUNNY_NONE = [
  "🤷 Nothing funny on record yet — either you've all been very sensible, or nobody's cast Fireball indoors yet.",
  "😐 No memorable chaos recorded so far. Give it time.",
  '🧙 The scribe has yet to write down anything worth laughing about. A quiet campaign, so far.',
  "📜 The archive of foolishness is empty. Surely that won't last.",
  "🎭 No blooper reel yet — this campaign is being suspiciously well-behaved.",
  '🧾 Nothing filed under "chaos" yet.',
  "🕯️ Not a single recorded disaster yet. Impressive, honestly.",
  "🐦 The familiar hasn't overheard anything worth repeating yet.",
  '🔮 The crystal ball shows a distinct lack of tomfoolery so far.',
  "🌙 No embarrassing moments on the books yet.",
  "⚗️ Nothing chaotic enough to bottle yet.",
  "🕰️ History hasn't recorded a single blunder yet.",
  "🧠 I've got nothing funny filed away yet — ask again after a few more sessions.",
  "🎙️ Nothing on the blooper tape yet.",
  "🐉 Even the dragon hasn't seen anything worth laughing at yet.",
  '🗿 No moment has been carved into the "hall of shame" yet.',
  "📯 Nothing embarrassing enough to announce yet.",
  "🧝 The chronicler hasn't caught anyone doing anything silly yet.",
  "⛩️ The shrine of chaos stands empty, for now.",
  "🪶 Not a single funny quill-mark yet — give the party time.",
];

// {channel}, {date}, {moment}
export const FUNNY_HEADER = [
  '😂 Remember when, back in **{channel}** ({date})... {moment}',
  '🎭 A moment worth remembering, from **{channel}** ({date}):\n\n{moment}',
  '🧙 Pulled from the archive — **{channel}** ({date}):\n\n{moment}',
  '📜 Straight from the record books, **{channel}** ({date}):\n\n{moment}',
  '🐦 The familiar recalls, from **{channel}** ({date}):\n\n{moment}',
  '🔮 The crystal ball shows a memory from **{channel}** ({date}):\n\n{moment}',
  '🌙 A blast from the past — **{channel}** ({date}):\n\n{moment}',
  '⚗️ A distilled memory from **{channel}** ({date}):\n\n{moment}',
  '🕰️ Turning back the clock to **{channel}** ({date})...\n\n{moment}',
  '🧠 I remember this one — **{channel}** ({date}):\n\n{moment}',
  '🎙️ Pulled at random from the tape — **{channel}** ({date}):\n\n{moment}',
  '🐉 From the hoard of chaos, **{channel}** ({date}):\n\n{moment}',
  '🗿 Carved into the hall of shame — **{channel}** ({date}):\n\n{moment}',
  '📯 Hear ye — a moment from **{channel}** ({date}):\n\n{moment}',
  '🧝 The chronicler grins and recalls, from **{channel}** ({date}):\n\n{moment}',
  '⛩️ From the shrine of chaos, **{channel}** ({date}):\n\n{moment}',
  '🪶 A moment worth re-inking — **{channel}** ({date}):\n\n{moment}',
  '📖 Flipping back to **{channel}** ({date})...\n\n{moment}',
  '🧾 On record, from **{channel}** ({date}):\n\n{moment}',
  '😂 A random moment worth remembering — **{channel}** ({date}):\n\n{moment}',
];

// {error}
export const JOIN_FAILED = [
  "🧙 The scribe tried to slip into the room but the door wouldn't open: {error}",
  '📜 The quill snapped before a single word was written: {error}',
  "🕯️ The candle refused to light — couldn't establish the connection: {error}",
  '🔮 The crystal ball stayed dark — voice connection failed: {error}',
  "🗝️ The lock wouldn't turn — couldn't join the voice channel: {error}",
  '🐦 The familiar flew into a window — connection failed: {error}',
  "🧾 The scroll never unrolled — joining failed: {error}",
  '📖 That chapter refused to open — voice connection failed: {error}',
  "🌙 Something in the ether blocked the way — couldn't connect: {error}",
  "⚗️ The ritual fizzled before it began — connection failed: {error}",
  "🕸️ The threads snapped before they could weave — couldn't connect: {error}",
  "🧠 Lost the signal before it even started — connection failed: {error}",
  '🎙️ Nothing came through — voice connection failed: {error}',
  "🐉 Even the dragon couldn't force the door — connection failed: {error}",
  '🗿 The stones stayed silent — connection failed: {error}',
  "📯 The herald never made it through — connection failed: {error}",
  "🧝 The chronicler got turned away at the door — connection failed: {error}",
  '⛩️ The shrine remained sealed — connection failed: {error}',
  '🪶 The quill never touched parchment — connection failed: {error}',
  "😬 Couldn't actually start recording — the voice connection failed: {error}. Nothing was recorded — try `/campaign join` again.",
];

// {query}
export const SEARCH_NONE = [
  '🔍 Nothing in the archive matches "{query}".',
  '📜 The scribe flipped through every scroll and found no mention of "{query}".',
  '🕯️ No record of "{query}" anywhere in the chronicle.',
  '🗝️ The vault holds nothing matching "{query}".',
  '🐦 The familiar searched the whole archive and came back with nothing for "{query}".',
  '🔮 The crystal ball shows no memory of "{query}".',
  '🧙 "{query}"? I have no recollection of that being said.',
  '🧾 Not a single line in the ledger mentions "{query}".',
  '📖 No chapter contains "{query}".',
  '🌙 Nothing on record for "{query}".',
  '⚗️ Nothing in the archive distills down to "{query}".',
  '🕸️ No thread in the tapestry matches "{query}".',
  '🧠 I have no memory of "{query}" being spoken.',
  '🎙️ Nothing on any tape matches "{query}".',
  '🐉 The dragon\'s hoard contains no "{query}".',
  '🗿 No stone bears the words "{query}".',
  '📯 Nothing to announce — no matches for "{query}".',
  '🧝 The chronicler cannot recall "{query}" at all.',
  '⛩️ The shrine holds no record of "{query}".',
  '🪶 No ink was ever spilled on "{query}".',
];

// {query}, {count}
export const SEARCH_HEADER = [
  '🔍 Found {count} mention(s) of "{query}" in the archive:',
  '📜 The scribe dug up {count} mention(s) of "{query}":',
  '🗝️ Unsealed {count} record(s) mentioning "{query}":',
  '🕯️ By candlelight, {count} mention(s) of "{query}":',
  '🐦 The familiar retrieved {count} mention(s) of "{query}":',
  '🔮 The crystal ball replays {count} moment(s) mentioning "{query}":',
  '🧙 I remember "{query}" — {count} time(s), in fact:',
  '🧾 The ledger records {count} mention(s) of "{query}":',
  '📖 {count} passage(s) mention "{query}":',
  '🌙 {count} moment(s) in the chronicle mention "{query}":',
  '⚗️ Distilled {count} mention(s) of "{query}" from the archive:',
  '🕰️ Turning back the clock — {count} mention(s) of "{query}":',
  '🧠 {count} memory(s) surfaced for "{query}":',
  '🎙️ {count} moment(s) on tape mention "{query}":',
  '🐉 The hoard yields {count} mention(s) of "{query}":',
  '🗿 {count} inscription(s) mention "{query}":',
  '📯 Announcing {count} mention(s) of "{query}":',
  '🧝 The chronicler recalls {count} mention(s) of "{query}":',
  '⛩️ The shrine surrenders {count} mention(s) of "{query}":',
  '🪶 {count} line(s) of ink mention "{query}":',
];

// {session}, {channel}, {date}, {count}
export const APPROVAL_REQUEST = [
  '📜 The transcript for **{channel}** ({date}) is written — {count} lines, {session}. The oracle awaits your word before it starts thinking.',
  '🧙 {session} (**{channel}**, {date}) is transcribed: {count} lines. The summarising wizard sleeps until you say so.',
  '🕯️ {count} lines copied out from **{channel}** ({date}). {session} is ready whenever your machine is.',
  '🐦 The familiar has finished its scribbling for **{channel}** ({date}) — {count} lines. {session} is waiting to go to the oracle.',
  '⏳ {session} (**{channel}**, {date}) is transcribed and waiting — {count} lines. Nothing will touch your GPU until you say so.',
  '🗝️ The vault holds {count} fresh lines from **{channel}** ({date}). {session} awaits your approval.',
  '📖 {session} — **{channel}** ({date}), {count} lines — is ready to be turned into a recap. Your call.',
  '🔮 The crystal ball has recorded {count} lines from **{channel}** ({date}). Summoning the summary is up to you ({session}).',
  '🧾 The ledger for **{channel}** ({date}) is complete: {count} lines. {session} is parked until you approve.',
  '🌙 {count} lines from **{channel}** ({date}) are safely written down. {session} waits on your word.',
  '⚗️ The raw ingredients are ready — {count} lines from **{channel}** ({date}). {session} is waiting to be distilled.',
  '🕰️ {session} (**{channel}**, {date}) transcribed: {count} lines. Held back so it doesn\'t steal your GPU mid-fight.',
  '🧠 I\'ve memorised {count} lines from **{channel}** ({date}). {session} is ready when you are.',
  '🎙️ The tape is cut — {count} lines from **{channel}** ({date}). Approve {session} when your machine is free.',
  '🐉 The hoard has grown by {count} lines (**{channel}**, {date}). {session} awaits your blessing.',
  '🗿 {count} lines carved from **{channel}** ({date}). {session} is parked, awaiting approval.',
  '📯 Hear ye: {session} (**{channel}**, {date}) is transcribed — {count} lines — and awaiting your go-ahead.',
  '🧝 The chronicler has finished **{channel}** ({date}) — {count} lines. {session} needs your nod before summarising.',
  '⛩️ {count} lines offered at the shrine from **{channel}** ({date}). {session} rests until you approve.',
  '🪶 The ink is dry on {count} lines from **{channel}** ({date}). {session} is ready for the summariser — your call.',
];


// {name}
export const WHOAMI_SET = [
  '🧙 You appear in every transcript and recap as **{name}**.',
  "📜 The archive knows you as **{name}**.",
  "🗝️ Your recorded name is **{name}**.",
  "🧾 On the ledger, you're **{name}**.",
  "🕯️ By candlelight you're known as **{name}**.",
  "🐦 The familiar calls you **{name}**.",
  "🔮 The crystal ball sees you as **{name}**.",
  "🧝 You're chronicled as **{name}**.",
  "🌙 Under this name you're remembered: **{name}**.",
  "🎙️ On record, you're **{name}**.",
];

// {discordName}
export const WHOAMI_UNSET = [
  "🧙 No character name set — you'll show up as your Discord name, **{discordName}**. Set one with `/campaign setchar`.",
  "📜 Nothing inscribed yet — transcripts use **{discordName}** until you `/campaign setchar`.",
  "🗝️ No true name on file. Currently recorded as **{discordName}** — `/campaign setchar` to change that.",
  "🧾 The ledger has you as **{discordName}** (your Discord name). Use `/campaign setchar` to set something else.",
  "🕯️ Unset — you appear as **{discordName}** for now. `/campaign setchar` to give yourself a proper name.",
  "🐦 The familiar only knows your Discord name, **{discordName}**. `/campaign setchar` fixes that.",
  "🧝 No character name yet — **{discordName}** it is, until you `/campaign setchar`.",
];


export const ARCHIVE_SENT = [
  '🗺️ The full campaign archive — download and open in any browser.',
  '📖 Everything the campaign remembers, in one page.',
  '🧾 The complete archive, ready to open locally.',
  '🔮 A whole campaign, distilled into one file.',
];

export const GENERIC_ERROR = [
  '💥 The spell fizzled: {message}',
  '🧙 Something went wrong in the workshop: {message}',
  '📜 The ink spilled: {message}',
  '🕯️ The candle blew out mid-sentence: {message}',
  "⚗️ That brew didn't go as planned: {message}",
  '🐦 The familiar dropped the message: {message}',
  '🗝️ The lock jammed: {message}',
  '🧾 The scroll tore: {message}',
  '🌙 Something went bump in the dark: {message}',
  '🕰️ Time slipped: {message}',
  '🧠 My memory glitched: {message}',
  '🎙️ Static on the line: {message}',
  '🐉 Even the dragon stumbled: {message}',
  '🗿 The stone cracked: {message}',
  '📯 The herald tripped over their words: {message}',
  '🧝 The chronicler dropped their quill: {message}',
  '⛩️ The ritual faltered: {message}',
  '🪶 The quill snapped: {message}',
  '🔮 The crystal ball cracked: {message}',
  'Something went wrong: {message}',
];
