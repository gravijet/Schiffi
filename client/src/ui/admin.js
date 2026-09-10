/**
 * Administration.
 *
 * Only rendered for accounts that actually hold the permissions, and every
 * control here calls a permission-gated endpoint - the UI hiding a button is
 * a convenience, not the security boundary.
 *
 * The permission list this file works from is the whole of what the server
 * offers an administrator. There is nothing above it to hint at: no wildcard,
 * no hidden tab, no greyed-out control an administrator could wonder about.
 */
import { h, add, clear, toast, modal, confirmDialog, tabs, debounce } from './dom.js';
import { t, td } from '../state/i18n.js';
import { api } from '../net/api.js';
import { supportTab, newsTab, adsTab } from './adminContent.js';

export function adminView(session) {
  const permissions = new Set(session?.permissions ?? []);
  const can = (permission) => permissions.has(permission);

  const root = h('div');
  let active = can('users.view') ? 'users' : can('roles.view') ? 'roles' : 'system';

  const render = () => {
    clear(root);
    const available = [
      can('users.view') && { key: 'users', label: t('admin.users') },
      can('roles.view') && { key: 'roles', label: t('admin.roles') },
      can('support.view') && { key: 'support', label: t('support.title') },
      can('news.view') && { key: 'news', label: t('news.title') },
      can('ads.view') && { key: 'ads', label: t('ads.title') },
      can('system.status') && { key: 'system', label: t('server.status') },
      can('system.integrations') && { key: 'integrations', label: 'Cloudflare' },
    ].filter(Boolean);

    add(root,
      h('h2', null, t('admin.title')),
      h('p.lede', null, t('admin.lede')),
      tabs(available, active, (key) => { active = key; render(); }),
      h('div', { style: { paddingTop: '12px' } },
        active === 'users' ? usersTab(can)
          : active === 'roles' ? rolesTab(can)
            : active === 'support' ? supportTab(can)
              : active === 'news' ? newsTab(can)
                : active === 'ads' ? adsTab(can)
                  : active === 'integrations' ? integrationsTab()
                    : systemTab()),
    );
  };
  render();
  return root;
}

// --- users -----------------------------------------------------------------

function usersTab(can) {
  const root = h('div');
  const list = h('div.stack');
  const search = h('input', { placeholder: t('common.search'), style: { maxWidth: '320px' } });

  const load = async (query = '') => {
    clear(list);
    list.append(h('p.muted', null, t('common.loading')));
    try {
      const { users, total } = await api.adminUsers(query ? `?q=${encodeURIComponent(query)}` : '');
      clear(list);
      list.append(h('p.small.muted', null, `${total} ${t('admin.users')}`));
      const table = h('table', null,
        h('thead', null, h('tr', null,
          h('th', null, 'ID'),
          h('th', null, t('auth.username')),
          h('th', null, t('auth.email')),
          h('th', null, t('profile.joined')),
          h('th', null, t('common.actions')))),
        h('tbody', null, ...users.map((user) =>
          h('tr', null,
            h('td.mono', null, String(user.id)),
            h('td', null, user.username, user.bannedUntil ? h('span.bad.small', null, ' ⛔') : null),
            h('td.small', null, user.email),
            h('td.small.muted', null, td(user.createdAt)),
            h('td', null, h('button.ghost.small', {
              onClick: () => userDialog(user.id, can),
            }, t('common.edit')))))));
      list.append(table);
    } catch (error) {
      clear(list);
      list.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  };

  search.addEventListener('input', debounce(() => load(search.value.trim()), 250));
  root.append(h('div.row', { style: { marginBottom: '10px' } }, search), list);
  load();
  return root;
}

async function userDialog(userId, can) {
  const [detail, roles] = await Promise.all([api.adminUser(userId), api.adminRoles().catch(() => ({ roles: [] }))]);
  const body = h('div.stack');

  const security = h('div.card', null, h('p.muted', null, t('common.loading')));
  if (can('users.security_status')) {
    api.adminUserSecurity(userId).then(({ status }) => {
      clear(security);
      security.append(
        h('div.card__title', null, t('admin.securityStatus')),
        h('dl.kv', null,
          h('dt', null, t('admin.passwordAlgorithm')), h('dd.mono', null, status.passwordAlgorithm),
          h('dt', null, t('auth.sessions')), h('dd', null, String(status.activeSessions)),
          h('dt', null, t('admin.failedLogins24h')), h('dd', null, String(status.failedLogins24h)),
          h('dt', null, t('auth.verifyEmail')), h('dd', null, status.emailVerified ? '✓' : '✗')));
    }).catch(() => { clear(security); security.append(h('p.bad', null, t('error.forbidden'))); });
  }

  const roleRows = h('div.stack');
  const renderRoles = (assigned) => {
    clear(roleRows);
    for (const role of roles.roles ?? []) {
      const has = assigned.some((r) => String(r.id) === String(role.id));
      roleRows.append(h('label.row.row--between', { style: { cursor: 'pointer' } },
        h('span', null, role.name, h('span.small.muted', null, ` (${role.key})`)),
        h('input', {
          type: 'checkbox', checked: has, disabled: !can('roles.assign'),
          style: { width: 'auto' },
          onChange: async (event) => {
            try {
              if (event.target.checked) await api.adminAssignRole(userId, role.id);
              else await api.adminRemoveRole(userId, role.id);
              toast(t('common.ok'), 'good');
            } catch (error) {
              event.target.checked = !event.target.checked;
              toast(t(error.code ?? 'error.generic'), 'bad');
            }
          },
        })));
    }
  };
  renderRoles(detail.roles ?? []);

  const characterRows = h('div.stack');
  for (const character of detail.characters ?? []) {
    const amount = h('input', { type: 'number', step: 1, value: 100, style: { maxWidth: '150px' } });
    const summary = h('div.small.muted', null,
      `#${character.id} · ${character.coins} ${t('unit.coins')} · ${t('profile.level')} ${character.level}`);
    characterRows.append(h('div.card.card--tight', null,
      h('div.row.row--between', null,
        h('div', null,
          h('strong', null, character.name),
          summary),
        can('world.grant') ? h('div.row', null,
          amount,
          h('button.primary.small', {
            onClick: async () => {
              const delta = Math.trunc(Number(amount.value));
              if (!Number.isSafeInteger(delta) || delta === 0) return;
              const result = await api.adminGrantEconomy(character.id, { coins: delta });
              character.coins = result.character.coins;
              summary.textContent = `#${character.id} · ${character.coins} ${t('unit.coins')} · ${t('profile.level')} ${character.level}`;
              toast(`${delta > 0 ? '+' : ''}${delta} ${t('unit.coins')}`, 'good');
            },
          }, t('common.apply'))) : null)));
  }

  add(body,
    h('div.card', null,
      h('div.card__title', null, detail.user.username),
      h('dl.kv', null,
        h('dt', null, t('auth.email')), h('dd', null, detail.user.email),
        h('dt', null, t('profile.joined')), h('dd', null, td(detail.user.createdAt)),
        h('dt', null, t('menu.language')), h('dd', null, detail.user.locale))),
    security,
    h('div.card', null, h('div.card__title', null, t('admin.roles')), roleRows),
    h('div.card', null,
      h('div.card__title', null, `${t('server.world')} / ${t('unit.coins')}`),
      characterRows.childElementCount ? characterRows : h('p.small.muted', null, t('common.empty'))),
    h('div.card', null,
      h('div.card__title', null, t('common.actions')),
      h('div.row', { style: { flexWrap: 'wrap' } },
        can('users.reset_password') ? h('button', {
          onClick: async () => {
            await api.adminTriggerReset(userId);
            toast(t('auth.resetSent'), 'good');
          },
        }, t('admin.triggerReset')) : null,
        can('users.revoke_sessions') ? h('button', {
          onClick: async () => {
            const { revoked } = await api.adminRevokeSessions(userId);
            toast(`${t('admin.revokeSessions')}: ${revoked}`, 'good');
          },
        }, t('admin.revokeSessions')) : null,
        can('users.ban') ? h('button.danger', {
          onClick: async () => {
            const ok = await confirmDialog({
              title: t('admin.ban'), message: detail.user.username,
              confirmLabel: t('admin.ban'), cancelLabel: t('common.cancel'), danger: true,
            });
            if (!ok) return;
            await api.adminBan(userId, 0, 'admin');
            toast(t('admin.ban'), 'good');
          },
        }, t('admin.ban')) : null,
        can('users.ban') ? h('button.ghost', {
          onClick: async () => { await api.adminUnban(userId); toast(t('admin.unban'), 'good'); },
        }, t('admin.unban')) : null)),
  );

  modal({ title: `${t('admin.users')} #${userId}`, body, wide: true, actions: [{ label: t('common.close') }] });
}

// --- roles -----------------------------------------------------------------

function rolesTab(can) {
  const root = h('div');
  const list = h('div.stack');

  const load = async () => {
    clear(list);
    const [{ roles }, { permissions }] = await Promise.all([api.adminRoles(), api.adminPermissions()]);
    clear(list);

    if (can('roles.create')) {
      list.append(h('button.primary', {
        onClick: () => roleDialog(null, permissions, load),
      }, t('admin.createRole')));
    }

    for (const role of roles) {
      add(list, h('div.card', null,
        h('div.row.row--between', null,
          h('div', null,
            h('strong', null, role.name),
            h('span.small.muted', null, ` ${role.key}`),
            role.system ? h('span.small.warn', null, ' · system') : null,
            !role.active ? h('span.small.bad', null, ' · inactive') : null,
            h('div.small.muted', null, role.description)),
          h('div.row', null,
            h('span.small.muted', null, `${role.memberCount} · ${role.permissions.length}p`),
            can('roles.edit') ? h('button.ghost', {
              onClick: () => roleDialog(role, permissions, load),
            }, t('common.edit')) : null,
            can('roles.create') ? h('button.ghost', {
              onClick: () => duplicateDialog(role, load),
            }, t('admin.duplicateRole')) : null,
            can('roles.delete') && !role.system ? h('button.danger', {
              onClick: async () => {
                const ok = await confirmDialog({
                  title: t('admin.deleteRole'), message: role.name,
                  confirmLabel: t('common.delete'), cancelLabel: t('common.cancel'), danger: true,
                });
                if (!ok) return;
                try { await api.adminDeleteRole(role.id); load(); } catch (error) {
                  toast(t(error.code ?? 'error.generic'), 'bad');
                }
              },
            }, t('common.delete')) : null))));
    }
  };

  load().catch(() => list.append(h('p.bad', null, t('error.forbidden'))));
  root.append(list);
  return root;
}

function roleDialog(role, permissions, onDone) {
  const key = h('input', { value: role?.key ?? '', disabled: Boolean(role?.system) });
  const name = h('input', { value: role?.name ?? '' });
  const description = h('input', { value: role?.description ?? '' });
  const active = h('input', { type: 'checkbox', checked: role ? role.active : true, style: { width: 'auto' } });
  const selected = new Set(role?.permissions ?? []);

  const byCategory = new Map();
  for (const permission of permissions) {
    if (!byCategory.has(permission.category)) byCategory.set(permission.category, []);
    byCategory.get(permission.category).push(permission);
  }

  const permissionList = h('div.stack');
  for (const [category, items] of byCategory) {
    permissionList.append(h('div.card', null,
      h('div.card__title', null, category),
      ...items.map((permission) => h('label.row.row--between', { style: { cursor: 'pointer' } },
        h('span', null,
          h('span.mono.small', null, permission.key),
          h('div.small.muted', null, permission.description)),
        h('input', {
          type: 'checkbox', checked: selected.has(permission.key), style: { width: 'auto' },
          onChange: (event) => {
            if (event.target.checked) selected.add(permission.key);
            else selected.delete(permission.key);
          },
        })))));
  }

  modal({
    title: role ? t('admin.renameRole') : t('admin.createRole'),
    wide: true,
    body: h('div.stack', null,
      h('div.field', null, h('label', null, 'Key'), key),
      h('div.field', null, h('label', null, t('common.name')), name),
      h('div.field', null, h('label', null, t('support.message')), description),
      h('label.row', null, active, h('span', null, t('admin.roleActive'))),
      h('div.card__title', null, t('admin.permissions')),
      permissionList),
    actions: [
      { label: t('common.cancel') },
      {
        label: t('common.save'), primary: true,
        onClick: async () => {
          try {
            if (role) {
              await api.adminUpdateRole(role.id, {
                name: name.value, description: description.value,
                active: active.checked, permissions: [...selected],
              });
            } else {
              await api.adminCreateRole({
                key: key.value.trim(), name: name.value.trim(),
                description: description.value, permissions: [...selected],
              });
            }
            onDone();
          } catch (error) {
            toast(error.message ?? t('error.generic'), 'bad');
            return false;
          }
          return true;
        },
      },
    ],
  });
}

function duplicateDialog(role, onDone) {
  const key = h('input', { value: `${role.key}_copy` });
  const name = h('input', { value: `${role.name} (copy)` });
  modal({
    title: t('admin.duplicateRole'),
    body: h('div', null,
      h('div.field', null, h('label', null, 'Key'), key),
      h('div.field', null, h('label', null, t('common.name')), name)),
    actions: [
      { label: t('common.cancel') },
      {
        label: t('admin.duplicateRole'), primary: true,
        onClick: async () => {
          try {
            await api.adminDuplicateRole(role.id, key.value.trim(), name.value.trim());
            onDone();
          } catch (error) { toast(error.message, 'bad'); return false; }
          return true;
        },
      },
    ],
  });
}

// --- system and integrations -----------------------------------------------

function systemTab() {
  const root = h('div');
  const load = () => api.adminSystem().then((info) => {
    clear(root);
    add(root,
      h('div.card', null,
        h('div.card__title', null, t('server.status')),
        h('dl.kv', null,
          h('dt', null, 'Node'), h('dd.mono', null, info.node),
          h('dt', null, 'Environment'), h('dd.mono', null, info.env),
          h('dt', null, 'Database'), h('dd.mono', null, info.database),
          h('dt', null, t('perf.memory')), h('dd.mono', null, `${(info.memory.heapUsed / 1048576).toFixed(1)} / ${(info.memory.rss / 1048576).toFixed(1)} MB`),
          h('dt', null, 'WebSocket'), h('dd.mono', null, `${info.websocket.players} / ${info.websocket.connections}`))),
      ...info.worlds.map((world) => h('div.card', null,
        h('div.card__title', null, world.name),
        h('dl.kv', null,
          h('dt', null, t('server.seed')), h('dd.mono', null, String(world.seed)),
          h('dt', null, t('server.players')), h('dd.mono', null, String(world.players)),
          h('dt', null, 'NPC'), h('dd.mono', null, String(world.npcs)),
          h('dt', null, t('weather.storm')), h('dd.mono', null, String(world.storms)),
          h('dt', null, t('server.tick')), h('dd.mono', null, `${world.tps.toFixed(1)} /s · ${world.tickMs} ms`)))),
      h('button.ghost', { onClick: load }, t('common.retry')),
    );
  }).catch(() => { clear(root); root.append(h('p.bad', null, t('error.forbidden'))); });
  load();
  return root;
}

function integrationsTab() {
  const root = h('div');
  api.adminCloudflare().then((info) => {
    clear(root);
    if (!info.configured) {
      root.append(h('p.muted', null, info.note));
      return;
    }
    add(root, h('div.card', null,
      h('div.card__title', null, 'Cloudflare'),
      h('dl.kv', null,
        h('dt', null, 'Auth method'), h('dd.mono', null, info.authMethod),
        h('dt', null, 'Zones'), h('dd.mono', null, String(info.zones.length))),
      info.warning ? h('p.small.warn', null, info.warning) : null,
      h('ul.small', null, ...info.zones.map((zone) => h('li', null, `${zone.name} — ${zone.status}`)))));
  }).catch(() => { clear(root); root.append(h('p.bad', null, t('error.forbidden'))); });
  return root;
}
