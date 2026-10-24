import test from 'node:test';
import assert from 'node:assert/strict';
import { acquisitionQuality, channelPreference, patchChannelQuality } from '../src/quality-model.js';
import { initialNavigation, navigationParams } from '../src/navigation-model.js';

test('channel editing preserves other preferences and explicit auto overrides legacy QQ', () => {
  const raw = patchChannelQuality('{"netease":"exhigh","lx:kw":"standard"}', 'qq', 'auto');
  assert.deepEqual(JSON.parse(raw), { netease: 'exhigh', 'lx:kw': 'standard', qq: 'auto' });
  assert.equal(channelPreference('qq', { FNMUSIC_QQ_QUALITY: 'mp3_128' }), 'mp3_128');
  assert.equal(channelPreference('qq', { FNMUSIC_QQ_QUALITY: 'mp3_128', FNMUSIC_CHANNEL_QUALITIES: raw }), 'auto');
});
test('acquisition follows advertised capabilities instead of assuming all platforms support QQ tiers', () => {
  const qq = { id: 'qq', capabilities: { qualities: ['mp3_128', 'mp3_320', 'lossless'] } };
  assert.equal(acquisitionQuality(qq, {}, 'smooth'), 'mp3_128');
  assert.equal(acquisitionQuality(qq, {}, 'balanced'), 'mp3_320');
  assert.equal(acquisitionQuality(qq, { FNMUSIC_CHANNEL_QUALITIES: '{"qq":"master"}' }, 'smooth'), 'lossless');
  assert.equal(acquisitionQuality({ id: 'kuwo', capabilities: { qualities: ['original'] } }, {}, 'high'), 'original');
});
test('trash is an independent route and library filters survive reloads', () => {
  const pages = ['library', 'trash'];
  assert.deepEqual(initialNavigation('?page=trash', pages), { page: 'trash', filter: 'all' });
  assert.deepEqual(initialNavigation('?page=versions', pages), { page: 'library', filter: 'multi' });
  assert.deepEqual(initialNavigation('?page=library&filter=multi', pages), { page: 'library', filter: 'multi' });
  assert.equal(navigationParams('?page=library&filter=multi', 'trash', 'multi').toString(), 'page=trash');
});
test('old source settings bookmarks open the consolidated platform settings', () => {
  assert.deepEqual(initialNavigation('?page=source-settings', ['library', 'platforms']), { page: 'platforms', filter: 'all' });
  const migrated = navigationParams('?page=source-settings&variant=A', 'platforms', 'all');
  assert.equal(migrated.get('section'), 'sources');
  assert.equal(migrated.get('page'), 'platforms');
  assert.equal(migrated.has('variant'), false);
  assert.equal(navigationParams(migrated.toString(), 'library', 'all').has('section'), false);
});
