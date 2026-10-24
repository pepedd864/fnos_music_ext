import test from 'node:test';
import assert from 'node:assert/strict';
import { patchAggregatePlatform, patchLxPlatform, platformRows, platformStatus } from '../src/platform-model.js';
import { channelPreference, patchChannelQuality } from '../src/quality-model.js';
const platforms = ['qq', 'kugou', 'kuwo', 'netease'].map(id => ({ id, name: id, enabled: id === 'qq',
  status: '待登录', capabilities: { login: id !== 'kuwo' }, auth: { logged_in: false } }));
const values = { FNMUSIC_ONLINE_SOURCES: 'qq,KuwoMusicClient,MiguMusicClient,NeteaseMusicClient',
  FNMUSIC_MUSICDL_ENABLED: 'true', LX_SOURCES: 'kg,wy,mg,kw', LX_SOURCE_LIST: '[{"url":"https://test/source.js","active":true}]',
  FNMUSIC_LX_ENABLED: 'true' };

test('the same platform groups account, aggregate and LX connections without merging their quality IDs', () => {
  const channels = ['kugou', 'netease', 'musicdl:NeteaseMusicClient', 'musicdl:MiguMusicClient', 'lx:kg', 'lx:wy', 'lx:mg'].map(id => ({ id }));
  const rows = platformRows(platforms, channels, values);
  assert.deepEqual(rows.map(row => row.id), ['qq', 'kugou', 'kuwo', 'netease', 'migu']);
  assert.deepEqual(rows.find(row => row.id === 'netease').routes.map(route => route.channel.id), ['netease', 'musicdl:NeteaseMusicClient', 'lx:wy']);
  assert.deepEqual(rows.find(row => row.id === 'migu').routes.map(route => route.id), ['musicdl:MiguMusicClient', 'lx:mg']);
  const raw = patchChannelQuality('{"netease":"standard","lx:wy":"lossless"}', 'netease', 'exhigh');
  assert.equal(channelPreference('lx:wy', { FNMUSIC_CHANNEL_QUALITIES: raw }), 'lossless');
});

test('a public LX connection does not inherit an expired direct-account status', () => {
  const rows = platformRows(platforms, [], values);
  assert.equal(platformStatus(rows.find(row => row.id === 'kugou')).text, '已启用');
  const inactive = platformRows(platforms, [], { ...values, FNMUSIC_LX_ENABLED: 'false' });
  assert.equal(platformStatus(inactive.find(row => row.id === 'kugou')).text, '未启用');
  assert.equal(platformStatus(inactive.find(row => row.id === 'qq')).text, '待登录');
});

test('configured LX platform choices are not shown as active without an enabled script', () => {
  const row = platformRows(platforms, [], { ...values, LX_SOURCE_LIST: '[]' }).find(row => row.id === 'kugou');
  assert.equal(row.enabled, false);
  assert.equal(row.routes.find(route => route.kind === 'lx').selected, true);
});

test('platform connection edits preserve every unrelated platform and refuse an empty implicit-default list', () => {
  assert.equal(patchAggregatePlatform(values, 'MiguMusicClient', false).FNMUSIC_ONLINE_SOURCES, 'qq,KuwoMusicClient,NeteaseMusicClient');
  assert.equal(patchLxPlatform(values, 'wy', false).LX_SOURCES, 'kg,mg,kw');
  assert.throws(() => patchLxPlatform({ LX_SOURCES: 'wy' }, 'wy', false));
  assert.throws(() => patchAggregatePlatform({ FNMUSIC_ONLINE_SOURCES: 'MiguMusicClient' }, 'MiguMusicClient', false));
  assert.equal(platformRows(platforms, [], { ...values, FNMUSIC_ONLINE_SOURCES: 'qq,migu,MiguMusicClient' }).filter(row => row.id === 'migu')[0].routes.length, 2);
});
