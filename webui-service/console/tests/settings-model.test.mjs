import test from 'node:test';
import assert from 'node:assert/strict';
import { additionalPlatforms, mergeAdditionalPlatforms, changedSettings, editableConfig, patchSettingsDraft, persistSettings, lxSources, neteaseCode, publicEntryKey, publicSelection, selectProvider, settingValue, externalUrl } from '../src/settings-model.js';
const schema = { count: { kind: 'int', min: 0, max: 20, label: '数量' }, flag: { kind: 'bool', label: '开关' }, secret: { kind: 'secret' }, FNMUSIC_CACHE_DIR: { kind: 'dir' } };
test('partial saves retain unrelated credentials, sources and playlist selection', () => {
  assert.deepEqual(changedSettings({ flag: false }, schema), { flag: false });
  assert.deepEqual(changedSettings({}, schema), {});
  assert.deepEqual(changedSettings({ secret: '' }, schema), { secret: '' });
});
test('zero is a valid setting and invalid numeric input cannot reset a setting', () => {
  assert.equal(settingValue('0', schema.count), 0);
  assert.deepEqual(changedSettings({ count: 0 }, schema), { count: 0 });
  for (const count of [NaN, -1, 21, 1.5, null, '']) assert.throws(() => changedSettings({ count }, schema));
  assert.throws(() => changedSettings({ flag: 'false' }, schema));
});
test('saved secrets are reduced to presence and empty typing preserves them', () => {
  const saved = editableConfig({ schema, values: { secret: 'test-only-placeholder', flag: 'true' } });
  assert.equal(saved.secret, true);
  assert.deepEqual(patchSettingsDraft({}, { secret: '', flag: false }, saved, schema), { flag: false });
  assert.deepEqual(patchSettingsDraft({ flag: false }, { flag: true }, saved, schema), {});
});
test('saving a switch sends only that change, preserving directories and explicit empty playlists', async () => {
  const calls = [];
  await persistSettings(async (...args) => { calls.push(args); return { ok: true }; }, { flag: false }, schema);
  assert.deepEqual(calls, [['/api/config', { values: { flag: false } }, 'PUT']]);
});
test('directory write failure stops a config write and a retry retains the same patch', async () => {
  const calls = [];
  const api = async (...args) => { calls.push(args); return { writable: false }; };
  await assert.rejects(persistSettings(api, { FNMUSIC_CACHE_DIR: '/vol1/cache' }, schema), /目录不可写/);
  assert.deepEqual(calls, [['/api/fs-check', { path: '/vol1/cache' }]]);
});
test('direct access without host check can save; network errors cannot falsely claim verification', async () => {
  const calls = [];
  await persistSettings(async (...args) => { calls.push(args); if (args[0] === '/api/fs-check') throw Object.assign(new Error('unavailable'), { status: 501 }); return { ok: true }; }, { FNMUSIC_CACHE_DIR: '/vol1/cache' }, schema);
  assert.deepEqual(calls[1], ['/api/config', { values: { FNMUSIC_CACHE_DIR: '/vol1/cache' } }, 'PUT']);
  await assert.rejects(persistSettings(async () => { throw new Error('offline'); }, { FNMUSIC_CACHE_DIR: '/vol1/cache' }, schema), /offline/);
});
test('directory traversal and relative storage locations are rejected before saving', () => {
  for (const path of ['relative/music', '/music/../private']) assert.throws(() => changedSettings({ FNMUSIC_CACHE_DIR: path }, schema));
});
test('provider selection is mutually exclusive without sending other settings', () => {
  assert.deepEqual(selectProvider('musicbox'), { FNMUSIC_MUSICDL_ENABLED: false, FNMUSIC_NETEASE_ENABLED: true, FNMUSIC_LX_ENABLED: false });
});
test('optional platform edits preserve common switches, including legacy source aliases', () => {
  const raw = 'qq,KuwoMusicClient,MiguMusicClient';
  assert.deepEqual(additionalPlatforms(raw), ['MiguMusicClient']);
  assert.equal(mergeAdditionalPlatforms(raw, ['QianqianMusicClient', 'KugouMusicClient']), 'qq,KuwoMusicClient,QianqianMusicClient');
  assert.equal(mergeAdditionalPlatforms(raw, []), 'qq,KuwoMusicClient');
  assert.equal(mergeAdditionalPlatforms('', ['MiguMusicClient']), 'MiguMusicClient');
});
test('legacy LX activation migrates without erasing explicit inactive selections', () => {
  assert.equal(lxSources({ LX_SOURCE_URL: 'https://test/a.js', LX_SOURCE_LIST: '[{"url":"https://test/a.js"}]' })[0].active, true);
  assert.equal(lxSources({ LX_SOURCE_URL: 'https://test/a.js', LX_SOURCE_LIST: '[{"url":"https://test/a.js","active":false}]' })[0].active, false);
  assert.equal(lxSources({ LX_SOURCE_URL: 'https://test/a.js', LX_SOURCE_LIST: '[]' })[0].active, true);
});
test('public playlist save strips display data and deduplicates the same NetEase playlist', () => {
  const item = { provider: 'musicbox', source: 'netease', kind: 'chart', id: 42, name: 'Name', cover_url: 'https://test/cover' };
  const duplicate = { ...item, kind: 'playlist' };
  assert.equal(publicEntryKey(item), publicEntryKey(duplicate));
  assert.deepEqual(publicSelection([item, duplicate]), [{ provider: 'musicbox', source: 'netease', kind: 'chart', id: '42' }]);
});
test('NetEase QR status accepts its production envelope and legacy flat payload', () => {
  assert.equal(neteaseCode({ ok: true, data: { code: 803 } }), 803);
  assert.equal(neteaseCode({ code: 802 }), 802);
});
test('release links cannot execute scripts or embed credentials', () => {
  assert.equal(externalUrl('javascript:alert(1)'), '');
  assert.equal(externalUrl('https://user:secret@example.com'), '');
  assert.equal(externalUrl('https://github.com/example/releases'), 'https://github.com/example/releases');
});
