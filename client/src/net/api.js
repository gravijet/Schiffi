/**
 * REST client.
 *
 * The session cookie is HttpOnly, so there is no token in JavaScript to steal;
 * every request just sends credentials. Errors carry a translation key, which
 * is what the UI shows - the server never dictates the player's language.
 */

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code || 'error.generic';
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, signal, raw = false } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(0, 'error.network', error.message);
  }

  if (raw) return response;
  if (response.status === 204) return null;

  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { message: text }; }
  }
  if (!response.ok) {
    throw new ApiError(response.status, payload?.code, payload?.message, payload?.details);
  }
  return payload;
}

/**
 * Cached sign-in state.
 *
 * Optional account syncs (storing the chosen language, for instance) consult
 * this instead of firing a request that would 401 for a signed-out visitor and
 * fill the console with errors for an entirely expected situation.
 */
let authenticated = false;

export const api = {
  ApiError,
  isAuthenticated: () => authenticated,
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
  raw: (path, options) => request(path, { ...options, raw: true }),

  // --- auth ---------------------------------------------------------------
  register: async (data) => {
    const result = await request('/api/auth/register', { method: 'POST', body: data });
    authenticated = true;
    return result;
  },
  login: async (identifier, password) => {
    const result = await request('/api/auth/login', { method: 'POST', body: { identifier, password } });
    authenticated = true;
    return result;
  },
  logout: async () => {
    authenticated = false;
    return request('/api/auth/logout', { method: 'POST' });
  },
  me: async () => {
    const result = await request('/api/auth/me');
    authenticated = Boolean(result?.user);
    return result;
  },
  updateMe: (data) => request('/api/auth/me', { method: 'PATCH', body: data }),
  changePassword: (currentPassword, newPassword) =>
    request('/api/auth/password', { method: 'POST', body: { currentPassword, newPassword } }),
  forgotPassword: (email) => request('/api/auth/password/forgot', { method: 'POST', body: { email } }),
  resetPassword: (token, newPassword) =>
    request('/api/auth/password/reset', { method: 'POST', body: { token, newPassword } }),
  verifyEmail: (token) => request('/api/auth/email/verify', { method: 'POST', body: { token } }),
  resendVerification: () => request('/api/auth/email/resend', { method: 'POST' }),
  sessions: () => request('/api/auth/sessions'),
  revokeSession: (id) => request(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  revokeAllSessions: () => request('/api/auth/sessions/revoke-all', { method: 'POST' }),
  exportData: () => request('/api/auth/export'),
  /** The blob is already WebP at the stored size; it goes up as raw bytes. */
  uploadAvatar: async (blob) => {
    const response = await fetch('/api/auth/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'image/webp' },
      body: blob,
      credentials: 'same-origin',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(response.status, payload?.code, payload?.message, payload?.details);
    }
    return payload;
  },
  removeAvatar: () => request('/api/auth/avatar', { method: 'DELETE' }),
  deleteAccount: (password) => request('/api/auth/delete', { method: 'POST', body: { password } }),

  // --- game ---------------------------------------------------------------
  status: () => request('/api/status'),
  worlds: () => request('/api/worlds'),
  world: (id) => request(`/api/worlds/${id}`),
  worldStatus: (id) => request(`/api/worlds/${id}/status`),
  terrain: (id) => request(`/api/worlds/${id}/terrain`, { raw: true }),
  characters: () => request('/api/characters'),
  createCharacter: (data) => request('/api/characters', { method: 'POST', body: data }),
  character: (id) => request(`/api/characters/${id}`),
  deleteCharacter: (id) => request(`/api/characters/${id}`, { method: 'DELETE' }),
  port: (worldId, portId, characterId) =>
    request(`/api/worlds/${worldId}/ports/${portId}${characterId ? `?characterId=${characterId}` : ''}`),
  priceHistory: (worldId, portId, goodId) =>
    request(`/api/worlds/${worldId}/ports/${portId}/prices/${goodId}`),
  chatHistory: (worldId, channel = 'global') =>
    request(`/api/worlds/${worldId}/chat?channel=${encodeURIComponent(channel)}`),
  leaderboard: (worldId, board) => request(`/api/worlds/${worldId}/leaderboard?board=${board}`),
  discoveries: (worldId) => request(`/api/worlds/${worldId}/discoveries`),
  goods: (lang) => request(`/api/data/goods${lang ? `?lang=${lang}` : ''}`),
  shipData: () => request('/api/data/ships'),
  crewData: () => request('/api/data/crew'),
  factions: () => request('/api/data/factions'),

  // --- gameplay -----------------------------------------------------------
  progressionData: () => request('/api/data/progression'),
  discoveryData: () => request('/api/data/discoveries'),
  portMissions: (worldId, portId) => request(`/api/worlds/${worldId}/ports/${portId}/missions`),
  activeMissions: (characterId) => request(`/api/characters/${characterId}/missions`),
  album: (characterId) => request(`/api/characters/${characterId}/album`),
  achievements: (characterId) => request(`/api/characters/${characterId}/achievements`),
  friends: () => request('/api/friends'),
  guild: (characterId) => request(`/api/characters/${characterId}/guild`),
  guilds: (worldId) => request(`/api/worlds/${worldId}/guilds`),
  convoy: (characterId) => request(`/api/characters/${characterId}/convoy`),
  market: (worldId, { goodId, limit } = {}) => {
    const query = new URLSearchParams();
    if (goodId) query.set('goodId', String(goodId));
    if (limit) query.set('limit', String(limit));
    const suffix = query.toString();
    return request(`/api/worlds/${worldId}/market${suffix ? `?${suffix}` : ''}`);
  },
  bounties: (worldId) => request(`/api/worlds/${worldId}/bounties`),
  routes: (characterId) => request(`/api/characters/${characterId}/routes`),
  outposts: (worldId, characterId) =>
    request(`/api/worlds/${worldId}/outposts${characterId ? `?characterId=${characterId}` : ''}`),
  insurance: (characterId) => request(`/api/characters/${characterId}/insurance`),
  report: (data) => request('/api/reports', { method: 'POST', body: data }),

  warehouses: (characterId) => request(`/api/characters/${characterId}/warehouses`),
  charts: (characterId) => request(`/api/characters/${characterId}/charts`),
  rumours: (worldId, portId) => request(`/api/worlds/${worldId}/ports/${portId}/rumours`),
  relations: (worldId) => request(`/api/worlds/${worldId}/relations`),
  seasons: () => request('/api/seasons'),
  seasonBoard: (seasonId, worldId, board) =>
    request(`/api/seasons/${seasonId}/leaderboard?worldId=${worldId}&board=${board}`),
  playerTrades: (characterId) => request(`/api/characters/${characterId}/trades`),

  tutorial: (characterId) => request(`/api/characters/${characterId}/tutorial`),
  skipTutorial: (characterId) =>
    request(`/api/characters/${characterId}/tutorial/skip`, { method: 'POST' }),
  resumeTutorial: (characterId) =>
    request(`/api/characters/${characterId}/tutorial/resume`, { method: 'POST' }),
  tutorialSteps: () => request('/api/data/tutorial'),

  // --- support, news and adverts -------------------------------------------
  createTicket: (data) => request('/api/support/tickets', { method: 'POST', body: data }),
  tickets: () => request('/api/support/tickets'),
  ticket: (id) => request(`/api/support/tickets/${id}`),
  replyTicket: (id, body) =>
    request(`/api/support/tickets/${id}/messages`, { method: 'POST', body: { body } }),
  closeTicket: (id) => request(`/api/support/tickets/${id}/close`, { method: 'POST' }),
  news: (locale) => request(`/api/news${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`),
  ads: () => request('/api/ads'),
  adClick: (id) => request(`/api/ads/${id}/click`, { method: 'POST' }),
  submitAd: (data) => request('/api/ads', { method: 'POST', body: data }),

  adminTickets: (status) => request(`/api/admin/support/tickets${status ? `?status=${status}` : ''}`),
  adminUpdateTicket: (id, data) =>
    request(`/api/admin/support/tickets/${id}`, { method: 'PATCH', body: data }),
  adminNews: () => request('/api/admin/news'),
  adminCreateNews: (data) => request('/api/admin/news', { method: 'POST', body: data }),
  adminUpdateNews: (id, data) => request(`/api/admin/news/${id}`, { method: 'PATCH', body: data }),
  adminDeleteNews: (id) => request(`/api/admin/news/${id}`, { method: 'DELETE' }),
  adminAds: (status) => request(`/api/admin/ads${status ? `?status=${status}` : ''}`),
  adminReviewAd: (id, status, note) =>
    request(`/api/admin/ads/${id}`, { method: 'POST', body: { status, note } }),

  // --- admin --------------------------------------------------------------
  adminRoles: () => request('/api/admin/roles'),
  adminPermissions: () => request('/api/admin/permissions'),
  adminCreateRole: (data) => request('/api/admin/roles', { method: 'POST', body: data }),
  adminUpdateRole: (id, data) => request(`/api/admin/roles/${id}`, { method: 'PATCH', body: data }),
  adminDeleteRole: (id) => request(`/api/admin/roles/${id}`, { method: 'DELETE' }),
  adminDuplicateRole: (id, key, name) =>
    request(`/api/admin/roles/${id}/duplicate`, { method: 'POST', body: { key, name } }),
  adminUsers: (query = '') => request(`/api/admin/users${query}`),
  adminUser: (id) => request(`/api/admin/users/${id}`),
  adminUserSecurity: (id) => request(`/api/admin/users/${id}/security`),
  adminTriggerReset: (id) => request(`/api/admin/users/${id}/reset-password`, { method: 'POST' }),
  adminRevokeSessions: (id) => request(`/api/admin/users/${id}/revoke-sessions`, { method: 'POST' }),
  adminBan: (id, days, reason) => request(`/api/admin/users/${id}/ban`, { method: 'POST', body: { days, reason } }),
  adminUnban: (id) => request(`/api/admin/users/${id}/unban`, { method: 'POST' }),
  adminAssignRole: (userId, roleId) => request(`/api/admin/users/${userId}/roles/${roleId}`, { method: 'POST' }),
  adminRemoveRole: (userId, roleId) => request(`/api/admin/users/${userId}/roles/${roleId}`, { method: 'DELETE' }),
  adminAudit: (query = '') => request(`/api/admin/audit${query}`),
  adminSystem: () => request('/api/admin/system'),
  adminCloudflare: () => request('/api/admin/integrations/cloudflare'),
};

export { ApiError };
