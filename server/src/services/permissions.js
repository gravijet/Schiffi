/**
 * The permission catalogue.
 *
 * Permissions are *code-defined* (they name things the code can do) while
 * roles are *data-defined* (an administrator composes them at runtime).  New
 * permissions are inserted on boot; removed ones are left in place so an
 * existing role never silently loses a grant.
 */

const p = (key, category, description) => ({ key, category, description });

export const PERMISSIONS = [
  // --- users --------------------------------------------------------------
  p('users.view', 'users', 'List and inspect user accounts'),
  p('users.edit', 'users', 'Change usernames, e-mail addresses and locales'),
  p('users.ban', 'users', 'Ban and unban accounts'),
  p('users.delete', 'users', 'Delete accounts and their data'),
  p('users.reset_password', 'users', 'Trigger a password reset e-mail'),
  p('users.revoke_sessions', 'users', 'Revoke a user\'s active sessions'),
  p('users.security_status', 'users', 'View a user\'s security status'),
  p('users.impersonate_never', 'users', 'Reserved: impersonation is not implemented by design'),

  // --- roles --------------------------------------------------------------
  p('roles.view', 'roles', 'View roles and their permissions'),
  p('roles.create', 'roles', 'Create new roles'),
  p('roles.edit', 'roles', 'Rename roles and change their permissions'),
  p('roles.delete', 'roles', 'Delete roles'),
  p('roles.assign', 'roles', 'Assign roles to users and remove them'),

  // --- chat and moderation ------------------------------------------------
  p('chat.moderate', 'moderation', 'Delete chat messages'),
  p('chat.mute', 'moderation', 'Mute users in chat'),
  p('chat.ban', 'moderation', 'Ban users from chat entirely'),
  p('reports.view', 'moderation', 'View player reports'),
  p('reports.handle', 'moderation', 'Resolve player reports'),
  p('names.moderate', 'moderation', 'Approve, reject or change island names'),

  // --- world --------------------------------------------------------------
  p('world.view', 'world', 'View world administration'),
  p('world.manage', 'world', 'Create, open, close and delete worlds'),
  p('world.events', 'world', 'Create and edit world events'),
  p('world.economy', 'world', 'Adjust market parameters'),
  p('world.teleport', 'world', 'Move a character to a position'),
  p('world.grant', 'world', 'Grant coins or goods to a character'),

  // --- content ------------------------------------------------------------
  p('news.view', 'content', 'View unpublished news posts'),
  p('news.publish', 'content', 'Write and publish news'),
  p('ads.view', 'content', 'View submitted adverts'),
  p('ads.approve', 'content', 'Approve or reject adverts'),

  // --- support ------------------------------------------------------------
  p('support.view', 'support', 'View support tickets'),
  p('support.reply', 'support', 'Reply to support tickets'),
  p('support.close', 'support', 'Close support tickets'),

  // --- system -------------------------------------------------------------
  p('audit.view', 'system', 'Read the audit log'),
  p('system.status', 'system', 'View server internals and metrics'),
  p('system.maintenance', 'system', 'Put the server into maintenance mode'),
  p('system.integrations', 'system', 'View and manage external integrations'),
];

export const PERMISSION_KEYS = PERMISSIONS.map((x) => x.key);
export const PERMISSION_SET = new Set(PERMISSION_KEYS);

/** The wildcard an owner role holds; it satisfies every check. */
export const WILDCARD = '*';

export function isKnownPermission(key) {
  return key === WILDCARD || PERMISSION_SET.has(key);
}

/**
 * Roles created on first boot.  `system: 1` only prevents deletion - an
 * administrator can still edit a system role's permissions, except the owner
 * role's wildcard, which the RBAC service refuses to remove.
 */
export const BOOTSTRAP_ROLES = [
  {
    key: 'owner', name: 'Owner', priority: 1000, system: 1,
    description: 'Full access. Still cannot read passwords - nobody can.',
    permissions: [WILDCARD],
  },
  {
    key: 'admin', name: 'Administrator', priority: 800, system: 1,
    description: 'Administers users, roles, worlds and content.',
    permissions: PERMISSION_KEYS.filter((k) => !k.startsWith('system.') && k !== 'users.delete'),
  },
  {
    key: 'moderator', name: 'Moderator', priority: 500, system: 0,
    description: 'Moderates chat, names and player reports.',
    permissions: ['users.view', 'chat.moderate', 'chat.mute', 'chat.ban',
      'reports.view', 'reports.handle', 'names.moderate'],
  },
  {
    key: 'support', name: 'Support', priority: 400, system: 0,
    description: 'Answers support tickets and can trigger password resets.',
    permissions: ['users.view', 'users.security_status', 'users.reset_password',
      'support.view', 'support.reply', 'support.close'],
  },
  {
    key: 'editor', name: 'Editor', priority: 300, system: 0,
    description: 'Writes news and reviews adverts.',
    permissions: ['news.view', 'news.publish', 'ads.view', 'ads.approve'],
  },
];
