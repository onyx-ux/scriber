// Fixing what Whisper keeps mishearing, from Discord.
//
// These existed only on the dashboard, which quietly made the dashboard
// compulsory: correcting a mangled name is the single most common thing a DM
// does with a transcription bot, and needing a web page for it means the web
// page is not optional at all.
//
// Every one of these calls the same function the dashboard's buttons call. The
// blast-radius guard comes with them — a correction that would rewrite a large
// share of the campaign comes back as a question rather than being applied,
// because the rewrite is not reversible and afterwards there is no telling
// which words were changed.

import { MessageFlags } from 'discord.js';

import { addCorrection, removeCorrection, replayCorrections } from '../pipeline/job-actions.js';
import { applyCorrections } from '../campaign/corrections.js';
import { campaignLabel } from '../campaign/resolve.js';

const say = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

const rewriteOne = (text, from, to) => applyCorrections(text, [{ wrong_text: from, correct_text: to }]);

export async function handleCorrect(interaction, db, target) {
  const result = addCorrection(db, {
    campaignId: target.id,
    wrong: interaction.options.getString('heard'),
    right: interaction.options.getString('write'),
    rewrite: rewriteOne,
    // The dashboard shows the count in a confirm box before it will proceed.
    // Discord has no dialog, so the count comes back in the refusal and the
    // same option re-run carries the answer.
    force: interaction.options.getBoolean('confirm') ?? false,
  });

  if (result.needsConfirming) {
    return say(
      interaction,
      `${result.message}\n\nTo do it anyway, run the same command again with \`confirm:True\`.`
    );
  }
  return say(interaction, result.message);
}

export async function handleUncorrect(interaction, db, target) {
  const result = removeCorrection(db, {
    campaignId: target.id,
    wrong: interaction.options.getString('heard'),
  });
  return say(interaction, result.message);
}

export async function handleCorrections(interaction, db, target) {
  const rules = db.listCorrections(target.id);
  const label = campaignLabel(target);

  if (rules.length === 0) {
    return say(
      interaction,
      `**${label}** has no corrections yet.\n` +
        'Add one with `/campaign correct heard:"Kaylen" write:"Kaelen"` — it applies to every future ' +
        'transcript and rewrites the ones already recorded.'
    );
  }

  const lines = rules.map((r) => `\`${r.wrong_text}\` → **${r.correct_text}**`);
  return say(
    interaction,
    `**${label}** — ${rules.length} correction${rules.length === 1 ? '' : 's'}\n${lines.join('\n')}\n\n` +
      'Remove one with `/campaign uncorrect heard:"…"`.'
  );
}

export async function handleReplay(interaction, db, target) {
  const result = replayCorrections(db, {
    campaignId: target.id,
    rewrite: (text, rules) => applyCorrections(text, rules),
  });
  return say(interaction, result.message);
}
