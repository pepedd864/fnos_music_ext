export function initialNavigation(search, pages) {
  const params = new URLSearchParams(search), page = params.get('page');
  if (page === 'versions') return { page: 'library', filter: 'multi' };
  return { page: pages.includes(page) ? page : 'library', filter: page === 'library' && params.get('filter') === 'multi' ? 'multi' : 'all' };
}
export function navigationParams(search, page, filter) {
  const params = new URLSearchParams(search);
  params.delete('variant'); params.set('page', page);
  if (page === 'library' && filter === 'multi') params.set('filter', 'multi'); else params.delete('filter');
  return params;
}
