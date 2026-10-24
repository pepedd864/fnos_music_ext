import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlatform, discoveryRequest, emptyDiscovery, platformBlock } from '../src/discovery-model.js';
import { initialNavigation, navigationParams } from '../src/navigation-model.js';

const qq = { id: 'qq', enabled: true, capabilities: { search: true, recommend: true, login: true }, auth: { logged_in: true } };
const kugou = { id: 'kugou', enabled: true, capabilities: { search: true, recommend: false, login: false } };

test('search and recommendations have independent routes and old discovery bookmarks open search', () => {
  const pages = ['library', 'search', 'recommendations'];
  assert.deepEqual(initialNavigation('?page=discover', pages), { page: 'search', filter: 'all' });
  for (const page of ['search', 'recommendations']) {
    assert.equal(initialNavigation(`?page=${page}`, pages).page, page);
    assert.equal(navigationParams('?page=discover&variant=A&filter=multi', page, 'all').toString(), `page=${page}`);
  }
});
test('platform selection follows enablement and capabilities without privileging a platform name', () => {
  assert.equal(defaultPlatform([kugou, qq], 'search'), 'kugou');
  assert.equal(defaultPlatform([kugou, qq], 'recommend'), 'qq');
  const other = { ...kugou, capabilities: { ...kugou.capabilities, recommend: true } };
  assert.equal(defaultPlatform([other, qq], 'recommend'), 'kugou');
  assert.equal(defaultPlatform([{ ...qq, enabled: false }, kugou], 'search'), 'kugou');
  assert.equal(defaultPlatform([], 'search'), '');
});
test('unsupported, disabled and expired-account recommendations never issue a request', () => {
  assert.equal(platformBlock(kugou, 'recommend'), 'unsupported');
  assert.equal(platformBlock({ ...qq, enabled: false }, 'recommend'), 'disabled');
  assert.equal(platformBlock({ ...qq, auth: { logged_in: false, state: 'expired' } }, 'recommend'), 'login');
  for (const platform of [kugou, { ...qq, enabled: false }, { ...qq, auth: { logged_in: false } }, undefined]) {
    assert.equal(discoveryRequest('recommend', platform, emptyDiscovery()), null);
  }
  assert.equal(discoveryRequest('search', kugou, emptyDiscovery(), { query: '歌曲' }).path, '/api/console/platforms/kugou/search?q=%E6%AD%8C%E6%9B%B2&page=1');
});
test('editing a draft does not change the query used for next page; a new search resets pagination', () => {
  const state = { ...emptyDiscovery('qq'), query: '原搜索 & 歌手', page: 2, loaded: true };
  const next = discoveryRequest('search', qq, state, { next: true, query: '尚未提交的新关键词' });
  assert.equal(next.query, '原搜索 & 歌手');
  assert.equal(next.page, 3);
  assert.match(next.path, /q=%E5%8E%9F%E6%90%9C%E7%B4%A2%20%26%20%E6%AD%8C%E6%89%8B&page=3$/);
  const first = discoveryRequest('search', qq, state, { query: ' 新关键词 ' });
  assert.equal(first.query, '新关键词');
  assert.equal(first.page, 1);
  assert.equal(discoveryRequest('search', qq, state, { query: '  ' }), null);
});
test('recommendation cursor stays separate from search page and query', () => {
  const search = { ...emptyDiscovery('kugou'), query: '搜索内容', page: 5 };
  const recommendations = { ...emptyDiscovery('qq'), cursor: 20 };
  assert.equal(discoveryRequest('recommend', qq, recommendations, { next: true }).path, '/api/console/platforms/qq/recommend?cursor=20');
  assert.equal(discoveryRequest('recommend', qq, recommendations).path, '/api/console/platforms/qq/recommend?cursor=0');
  assert.equal(search.page, 5);
  assert.equal(search.query, '搜索内容');
  assert.deepEqual(emptyDiscovery('kuwo').items, []);
});

test('public recommendations need no account and NetEase settings map to download tiers', async () => {
  const { acquisitionQuality } = await import('../src/quality-model.js');
  const publicPlatform = { id: 'kuwo', enabled: true, capabilities: { recommend: true, login: false, recommend_kind: 'public' } };
  assert.equal(platformBlock(publicPlatform, 'recommend'), '');
  assert.equal(discoveryRequest('recommend', publicPlatform, emptyDiscovery()).path, '/api/console/platforms/kuwo/recommend?cursor=0');
  const netease = { id: 'netease', capabilities: { qualities: ['mp3_128', 'mp3_320', 'lossless'] } };
  assert.equal(acquisitionQuality(netease, { FNMUSIC_CHANNEL_QUALITIES: '{"netease":"standard"}' }, 'high'), 'mp3_128');
  assert.equal(acquisitionQuality(netease, { FNMUSIC_CHANNEL_QUALITIES: '{"netease":"hires"}' }, 'smooth'), 'lossless');
});
