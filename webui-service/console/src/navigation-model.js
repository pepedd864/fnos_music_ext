export function initialNavigation(search, pages) {
  const params = new URLSearchParams(search), requested = params.get('page');
  const page = requested === 'source-settings' ? 'platforms' : requested === 'discover' ? 'search' : requested;
  if (page === 'versions') return { page: 'library', filter: 'multi' };
  return { page: pages.includes(page) ? page : 'library', filter: page === 'library' && params.get('filter') === 'multi' ? 'multi' : 'all' };
}
export function navigationParams(search, page, filter) {
  const params = new URLSearchParams(search);
  if (params.get('page') === 'source-settings' && page === 'platforms') params.set('section', 'sources');
  if (page !== 'platforms') params.delete('section');
  params.delete('variant'); params.set('page', page);
  if (page === 'library' && filter === 'multi') params.set('filter', 'multi'); else params.delete('filter');
  return params;
}
