// Renaming a campaign, from Discord (/campaign rename) or from the dashboard.
//
// A campaign's name is also the folder its notes live in and the start of every
// session reference (Cipher_02), so a rename checks that the name leaves
// something behind once path characters are stripped, that no other campaign
// already files there, and then moves the existing vault folder across.
// Leaving the folder behind is worse than untidy: the ledger is what tells the
// next session which NPCs the campaign already knows.
//
// Who may: the campaign's DM (its manager), and the bot owner, who can act on
// any campaign. Deliberately narrower than "may manage", which also admits the
// owner of the Discord server: a server owner can help run a table's roster
// without deciding what the table's game is called.
import { campaignNameClash, nameIsUsable, campaignLabel } from './resolve.js';
import { campaignFolderFor } from '../export/naming.js';
import { refSlug } from './session-ref.js';
import { moveCampaignFolder } from './vault-migrate.js';
import { runsThisBot } from '../access/operators.js';

export function mayRename({ campaign, userId, cfg, db = null }) {
  if (!campaign || !userId) return false;
  return campaign.manager_user_id === userId || runsThisBot(db, cfg, userId);
}

export async function renameCampaign({ db, cfg, campaignId, name, move = moveCampaignFolder }) {
  const target = db.getCampaign(campaignId);
  if (!target) return { ok: false, message: '⚠️ No such campaign.' };

  const trimmed = String(name ?? '').trim();
  if (!trimmed) return { ok: false, message: '⚠️ Give the campaign a name.' };
  if (trimmed.length > 100) return { ok: false, message: '⚠️ Keep the name under 100 characters.' };

  if (!nameIsUsable(trimmed)) {
    return {
      ok: false,
      message:
        `⚠️ Quill can't file anything under "${trimmed}". A campaign's name becomes the folder its notes live in ` +
        'and the start of every session reference, and that one leaves nothing behind once emoji and path ' +
        'characters are stripped. Give it at least one letter or number.',
    };
  }

  const clash = campaignNameClash(db, trimmed, target.id);
  if (clash) {
    return { ok: false, message: `⚠️ **${campaignLabel(clash)}** already files its notes there. Pick a different name.` };
  }

  const previous = target.name;
  const previousFolder = campaignFolderFor(target);
  const folder = campaignFolderFor({ ...target, name: trimmed });
  db.setCampaignName(target.id, trimmed);

  let carried = '';
  if (previousFolder !== folder) {
    try {
      const result = await move({ cfg, from: previousFolder, to: folder });
      if (result?.moved) carried = `\n\n_Moved the existing \`${previousFolder}/\` folder across, notes and ledger included._`;
      if (result?.skipped?.length) {
        carried += `\n⚠️ Left behind in \`${previousFolder}/\` (something with the same name was already in \`${folder}/\`): ${result.skipped.join(', ')}`;
      }
    } catch (err) {
      console.error('[campaign] folder move failed:', err);
      carried = `\n\n⚠️ Couldn't move \`${previousFolder}/\`. The old notes are still there; new ones will go to \`${folder}/\`.`;
    }
  }

  return {
    ok: true,
    campaignId: target.id,
    name: trimmed,
    previous,
    folder,
    message:
      `📖 Campaign renamed to **${trimmed}**.\n` +
      `Session notes are filed in \`${folder}/\`, and sessions now read \`${refSlug(trimmed)}_01\`.` +
      (previous && previous !== trimmed ? `\n\n_Previously **${previous}**._` : '') +
      carried,
  };
}
