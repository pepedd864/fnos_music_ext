export const emptyDiscovery = (platformId = '') => ({ platformId, items: [], query: '', page: 0, cursor: 0, loaded: false, hasMore: false, warning: '' });

export function defaultPlatform(platforms, kind) {
  return (platforms.find(p => p.enabled && p.capabilities?.[kind]) || platforms.find(p => p.capabilities?.[kind]) || platforms[0])?.id || '';
}

export function platformBlock(platform, kind) {
  if (!platform) return 'loading';
  if (!platform.capabilities?.[kind]) return 'unsupported';
  if (!platform.enabled) return 'disabled';
  if (kind === 'recommend' && platform.capabilities.login && !platform.auth?.logged_in) return 'login';
  return '';
}

// Pagination always uses the submitted query, even when the input draft has changed.
export function discoveryRequest(kind, platform, state, { next = false, query = '' } = {}) {
  if (platformBlock(platform, kind)) return null;
  const submitted = kind === 'search' ? (next ? state.query : query.trim()) : '';
  if (kind === 'search' && !submitted) return null;
  const page = next ? state.page + 1 : 1;
  const endpoint = kind === 'search' ? `search?q=${encodeURIComponent(submitted)}&page=${page}` : `recommend?cursor=${next ? state.cursor : 0}`;
  return { path: `/api/console/platforms/${platform.id}/${endpoint}`, query: submitted, page, platformId: platform.id };
}
