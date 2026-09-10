/**
 * Friends and convoys.
 *
 * A friend list is an account-level thing, a convoy is a per-world sailing
 * arrangement, and both are worked through the same server actions the rest of
 * the game uses. Positions of convoy mates come from the server's live view,
 * so a mate at sea shows where they really are.
 */
import { h, add, clear, tabs, toast, modal, confirmDialog } from '../dom.js';
import { t } from '../../state/i18n.js';
import { api } from '../../net/api.js';

export function friendsView(ctx) {
  const root = h('div.stack');
  const pane = h('div.stack');
  let tab = 'friends';

  const header = tabs([
    { key: 'friends', label: t('social.friends') },
    { key: 'convoy', label: t('social.convoy') },
  ], tab, (key) => { tab = key; render(); });

  add(root, header, pane);

  async function act(name, payload, successKey) {
    try {
      await ctx.socket.action(name, payload);
      toast(t(successKey), 'good');
      await render();
    } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
  }

  async function render() {
    clear(pane);
    pane.append(h('p.small.muted', null, t('common.loading')));
    try {
      pane.replaceChildren(tab === 'friends' ? await friendsPane(act) : await convoyPane(ctx, act));
    } catch (error) {
      clear(pane);
      pane.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  }

  render();
  return root;
}

async function friendsPane(act) {
  const root = h('div.stack');
  const { friends, incoming, outgoing } = await api.friends();

  const name = h('input', { placeholder: t('social.usernamePlaceholder'), maxLength: 32 });
  add(root,
    h('div.row', null, name,
      h('button.primary', {
        onClick: () => {
          const value = name.value.trim();
          if (!value) return;
          name.value = '';
          act('friend.add', { username: value }, 'social.requestSent');
        },
      }, t('social.addFriend'))));

  if (incoming.length) {
    root.append(h('div.card__title', null, t('social.requests')));
    for (const request of incoming) {
      root.append(h('div.row.row--between', null,
        h('span', null, request.username),
        h('div.row', null,
          h('button.ghost', {
            onClick: () => act('friend.accept', { userId: request.id }, 'social.accept'),
          }, t('social.accept')),
          h('button.ghost.danger', {
            onClick: () => act('friend.remove', { userId: request.id }, 'social.decline'),
          }, t('social.decline')))));
    }
  }

  root.append(h('div.card__title', null, t('social.friends')));
  if (!friends.length) root.append(h('p.small.muted', null, t('social.noFriends')));
  for (const friend of friends) {
    root.append(h('div.row.row--between', null,
      h('div', null,
        h('span', null, friend.username),
        h('span.small', { class: friend.online ? 'good' : 'muted' },
          ` · ${t(friend.online ? 'social.online' : 'social.offline')}`)),
      h('button.ghost', {
        onClick: async () => {
          const yes = await confirmDialog({
            title: t('social.removeFriend'), message: friend.username,
            confirmLabel: t('social.removeFriend'), danger: true,
          });
          if (yes) act('friend.remove', { userId: friend.id }, 'social.removeFriend');
        },
      }, t('social.removeFriend'))));
  }

  if (outgoing.length) {
    root.append(h('div.card__title', null, t('social.outgoing')));
    for (const request of outgoing) {
      root.append(h('p.small.muted', null, request.username));
    }
  }
  return root;
}

async function convoyPane(ctx, act) {
  const root = h('div.stack');
  const { convoy } = await api.convoy(ctx.character.id);

  if (!convoy) {
    const name = h('input', { placeholder: t('social.convoyName'), maxLength: 40 });
    const joinId = h('input', { placeholder: t('social.convoyId') });
    add(root,
      h('p.small.muted', null, t('social.noConvoy')),
      h('div.row', null, name,
        h('button.primary', {
          onClick: () => act('convoy.create', { name: name.value.trim() }, 'social.createConvoy'),
        }, t('social.createConvoy'))),
      h('div.row', null, joinId,
        h('button.ghost', {
          onClick: () => act('convoy.join', { convoyId: joinId.value.trim() }, 'social.joined'),
        }, t('social.joinConvoy'))));
    return root;
  }

  const self = ctx.socket.self;
  add(root,
    h('div.row.row--between', null,
      h('div', null,
        h('div.card__title', null, convoy.name || t('social.convoy')),
        h('div.small.muted', null, `${t('social.convoyId')}: ${convoy.id}`)),
      h('button.ghost.danger', {
        onClick: () => act('convoy.leave', {}, 'social.departed'),
      }, t('social.leaveConvoy'))));

  for (const member of convoy.members) {
    const away = self ? Math.round(Math.hypot(member.x - self.x, member.y - self.y)) : null;
    root.append(h('div.row.row--between', null,
      h('div', null,
        h('span', null, member.name),
        String(member.characterId) === String(convoy.leaderId)
          ? h('span.small.muted', null, ` · ${t('social.leader')}`)
          : null,
        h('div.small.muted', null,
          `${t(member.docked ? 'social.inPort' : 'social.atSea')}`
          + (away !== null ? ` · ${t('combat.distance')} ${away}` : ''))),
      h('span.small', { class: member.online ? 'good' : 'muted' },
        t(member.online ? 'social.online' : 'social.offline'))));
  }
  return root;
}
