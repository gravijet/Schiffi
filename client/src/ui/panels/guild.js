/**
 * Trading company.
 *
 * Everything on this screen is the server's record of the company: the roster,
 * the treasury balance and the ledger behind it. Deposit and withdraw buttons
 * are gated on the rank permissions the server sent, which are the same ones
 * it checks when the action arrives.
 */
import { h, add, clear, tabs, toast, modal, confirmDialog } from '../dom.js';
import { t, tc } from '../../state/i18n.js';
import { api } from '../../net/api.js';
import { currentLocale } from '../../state/i18n.js';
import { FOUNDING_FEE } from '@schiffi/shared/data/costs.js';

const date = (ms) => new Date(ms).toLocaleDateString(currentLocale());
const dateTime = (ms) => new Date(ms).toLocaleString(currentLocale());

export function guildView(ctx) {
  const root = h('div.stack');
  const body = h('div.stack');
  add(root, body);

  async function render() {
    clear(body);
    body.append(h('p.small.muted', null, t('common.loading')));
    try {
      const { guild } = await api.guild(ctx.character.id);
      clear(body);
      if (guild) body.append(memberView(ctx, guild, render));
      else body.append(await browseView(ctx, render));
    } catch (error) {
      clear(body);
      body.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  }

  render();
  return root;
}

/** No company yet: found one, or join one of the world's existing companies. */
async function browseView(ctx, refresh) {
  const root = h('div.stack');
  const { guilds } = await api.guilds(ctx.character.worldId);

  add(root,
    h('div.row', null,
      h('button.primary', { onClick: () => createDialog(ctx, refresh) },
        `${t('guild.create')} · ${tc(FOUNDING_FEE)}`)),
    h('div.card__title', null, t('guild.browse')));

  if (!guilds.length) {
    root.append(h('p.small.muted', null, t('guild.none')));
    return root;
  }
  for (const guild of guilds) {
    root.append(h('div.card', null,
      h('div.row.row--between', null,
        h('div.grow', null,
          h('div', null, `[${guild.tag}] ${guild.name}`),
          h('div.small.muted', null,
            `${t('guild.memberCount', { count: guild.members })} · ${t('guild.founded', { date: date(guild.createdAt) })}`)),
        h('button.ghost', {
          onClick: async () => {
            try {
              await ctx.socket.action('guild.join', { guildId: guild.id });
              toast(t('guild.joined'), 'good');
              refresh();
            } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
          },
        }, t('guild.join'))),
      guild.description ? h('p.small.muted', null, guild.description) : null));
  }
  return root;
}

/** In a company: roster, treasury and the ledger behind it. */
function memberView(ctx, guild, refresh) {
  const root = h('div.stack');
  const pane = h('div.stack');
  let tab = 'members';

  const rank = guild.ranks.find((entry) => entry.key === guild.yourRank);
  const may = (permission) => Boolean(rank?.permissions.includes(permission));
  const isFounder = guild.yourRank === 'founder';

  const header = tabs([
    { key: 'members', label: t('guild.members') },
    { key: 'treasury', label: t('guild.treasury') },
    { key: 'diplomacy', label: t('guild.diplomacy') },
    { key: 'log', label: t('guild.auditLog') },
  ], tab, (key) => { tab = key; renderPane(); });

  async function move(action, amount) {
    try {
      await ctx.socket.action(action, { amount });
      toast(t(action === 'guild.deposit' ? 'guild.deposit' : 'guild.withdraw'), 'good');
      ctx.refreshCharacter?.();
      refresh();
    } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
  }

  function transferDialog(action) {
    const amount = h('input', { type: 'number', min: 1, value: 100 });
    modal({
      title: t(action === 'guild.deposit' ? 'guild.depositAmount' : 'guild.withdrawAmount'),
      body: h('div.field', null,
        h('label', null, t('unit.coins')), amount),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('common.confirm'), primary: true,
          onClick: async () => { await move(action, Number(amount.value) || 0); return true; },
        },
      ],
    });
  }

  function renderPane() {
    clear(pane);
    if (tab === 'members') {
      for (const member of guild.members) {
        const memberRank = guild.ranks.find((entry) => entry.key === member.rank);
        pane.append(h('div.row.row--between', null,
          h('div', null,
            h('div', null, member.name),
            h('div.small.muted', null,
              `${memberRank?.name ?? member.rank} · ${t('profile.level')} ${member.level}`)),
          h('span.small.muted', null, date(member.joinedAt))));
      }
    } else if (tab === 'treasury') {
      add(pane,
        h('div.row.row--between', null,
          h('span', null, t('guild.treasury')),
          h('span.mono', null, tc(guild.treasury))),
        h('div.row', null,
          h('button.primary', {
            disabled: !may('deposit'),
            onClick: () => transferDialog('guild.deposit'),
          }, t('guild.deposit')),
          h('button.ghost', {
            disabled: !may('withdraw'),
            onClick: () => transferDialog('guild.withdraw'),
          }, t('guild.withdraw'))),
        may('deposit') ? null : h('p.small.muted', null, t('guild.noPermission')));
    } else if (tab === 'diplomacy') {
      diplomacyPane(pane, ctx, guild, isFounder, refresh);
    } else if (!guild.ledger.length) {
      pane.append(h('p.small.muted', null, t('guild.emptyLog')));
    } else {
      for (const entry of guild.ledger) {
        pane.append(h('div.row.row--between', null,
          h('div', null,
            h('div.small', null, entry.delta >= 0
              ? t('guild.logDeposit', { player: entry.actor, amount: tc(entry.delta) })
              : t('guild.logWithdraw', { player: entry.actor, amount: tc(-entry.delta) })),
            h('div.small.muted', null, dateTime(entry.at))),
          h('span.mono.muted', null, tc(entry.balance))));
      }
    }
  }

  add(root,
    h('div.row.row--between', null,
      h('div', null,
        h('div.card__title', null, `[${guild.tag}] ${guild.name}`),
        h('div.small.muted', null,
          `${t('guild.rank')}: ${rank?.name ?? guild.yourRank} · ${t('guild.founded', { date: date(guild.createdAt) })}`)),
      h('button.ghost.danger', {
        onClick: async () => {
          const yes = await confirmDialog({
            title: t('guild.leave'), message: t('guild.leave'),
            confirmLabel: t('guild.leave'), danger: true,
          });
          if (!yes) return;
          try {
            await ctx.socket.action('guild.leave', {});
            toast(t('guild.departed'), 'info');
            refresh();
          } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
        },
      }, t('guild.leave'))),
    guild.description ? h('p.small.muted', null, guild.description) : null,
    header, pane);

  renderPane();
  return root;
}

/** Treaty controls deliberately live with the company roster: diplomacy changes all members' territory. */
function diplomacyPane(pane, ctx, guild, isFounder, refresh) {
  const treaties = guild.alliances ?? [];
  const current = treaties.find((entry) => entry.status === 'active');
  const incoming = treaties.find((entry) => entry.status === 'pending' && entry.incoming);
  const outgoing = treaties.find((entry) => entry.status === 'pending' && !entry.incoming);
  const action = async (name, payload, success) => {
    try {
      await ctx.socket.action(name, payload);
      toast(t(success), 'good');
      refresh();
    } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
  };

  pane.append(h('p.small.muted', null, t('guild.diplomacyHint')));
  if (current) {
    pane.append(h('div.card', null,
      h('div.card__title', null, `${t('guild.allianceActive')} · [${current.partnerTag}] ${current.partnerName}`),
      h('div.small.muted', null, t('guild.allianceSharedControl')),
      isFounder ? h('button.ghost.danger', {
        onClick: () => action('guild.alliance.respond', { allianceId: current.id, accept: false }, 'guild.allianceEnded'),
      }, t('guild.endAlliance')) : null));
  } else if (incoming) {
    pane.append(h('div.card', null,
      h('div.card__title', null, `[${incoming.partnerTag}] ${incoming.partnerName}`),
      h('div.small.muted', null, t('guild.allianceIncoming')),
      isFounder ? h('div.row', null,
        h('button.primary', { onClick: () => action('guild.alliance.respond', { allianceId: incoming.id, accept: true }, 'guild.allianceAccepted') }, t('guild.acceptAlliance')),
        h('button.ghost.danger', { onClick: () => action('guild.alliance.respond', { allianceId: incoming.id, accept: false }, 'guild.allianceDeclined') }, t('guild.declineAlliance'))) : null));
  } else if (outgoing) {
    pane.append(h('div.card', null,
      h('div.card__title', null, `[${outgoing.partnerTag}] ${outgoing.partnerName}`),
      h('div.small.muted', null, t('guild.alliancePending')),
      isFounder ? h('button.ghost.danger', { onClick: () => action('guild.alliance.respond', { allianceId: outgoing.id, accept: false }, 'guild.allianceEnded') }, t('guild.cancelAlliance')) : null));
  } else {
    pane.append(h('div.card__title', null, t('guild.proposeAlliance')));
    const candidates = guild.allianceCandidates ?? [];
    if (!candidates.length) pane.append(h('p.small.muted', null, t('guild.noAllianceCandidates')));
    for (const candidate of candidates) {
      pane.append(h('div.row.row--between', null,
        h('div', null, `[${candidate.tag}] ${candidate.name}`),
        h('button.ghost', {
          disabled: !isFounder,
          onClick: () => action('guild.alliance.propose', { guildId: candidate.id }, 'guild.allianceProposed'),
        }, t('guild.proposeAlliance'))));
    }
  }
  if (!isFounder) pane.append(h('p.small.muted', null, t('guild.diplomacyFounderOnly')));
}

function createDialog(ctx, refresh) {
  const name = h('input', { placeholder: t('guild.namePlaceholder'), maxLength: 40 });
  const tag = h('input', { placeholder: t('guild.tagPlaceholder'), maxLength: 5 });
  const description = h('textarea', { rows: 3, maxLength: 500 });

  modal({
    title: t('guild.create'),
    body: h('div.stack', null,
      h('p.small.muted', null, `${t('common.price')}: ${tc(FOUNDING_FEE)}`),
      h('div.field', null, h('label', null, t('common.name')), name),
      h('div.field', null, h('label', null, t('guild.tag')), tag),
      h('div.field', null, h('label', null, t('common.more')), description)),
    actions: [
      { label: t('common.cancel') },
      {
        label: t('guild.create'), primary: true,
        onClick: async () => {
          try {
            await ctx.socket.action('guild.create', {
              name: name.value.trim(),
              tag: tag.value.trim().toUpperCase(),
              description: description.value.trim(),
            });
            toast(t('guild.created'), 'good');
            ctx.refreshCharacter?.();
            refresh();
          } catch (error) {
            toast(t(error.code ?? 'error.generic'), 'bad');
            return false;
          }
          return true;
        },
      },
    ],
  });
}
