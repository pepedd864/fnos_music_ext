import { additionalPlatforms, lxSources } from './settings-model.js';

const known = {
  qq: 'QQ 音乐', kugou: '酷狗音乐', kuwo: '酷我音乐', netease: '网易云音乐', migu: '咪咕音乐',
  bilibili: '哔哩哔哩', qianqian: '千千音乐', bodian: '波点音乐', soda: '汽水音乐',
  ximalaya: '喜马拉雅', qingting: '蜻蜓 FM', lizhi: '荔枝', fivesing: '5sing',
  lrts: '懒人听书', streetvoice: '街声 StreetVoice', apple: 'Apple Music', itunes: 'iTunes',
  audius: 'Audius', deezer: 'Deezer', jamendo: 'Jamendo', jiosaavn: 'JioSaavn', joox: 'JOOX',
  moov: 'MOOV', qobuz: 'Qobuz', soundcloud: 'SoundCloud', spotify: 'Spotify', suno: 'Suno',
  tidal: 'TIDAL', youtube: 'YouTube Music', fma: 'Free Music Archive', wikimediacommons: 'Wikimedia Commons',
};
const commonClients = { qq: 'QQMusicClient', kugou: 'KugouMusicClient', kuwo: 'KuwoMusicClient' };
const lxPlatforms = { kg: 'kugou', kw: 'kuwo', wy: 'netease', mg: 'migu' };
const yes = value => ['true', '1', 'yes'].includes(String(value).toLowerCase());
const csv = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
export const clientPlatform = client => String(client).replace(/MusicClient$/i, '').toLowerCase();
export const clientName = client => known[clientPlatform(client)] || String(client).replace(/MusicClient$/i, '');
const sourceValue = values => values.FNMUSIC_ONLINE_SOURCES || values.MUSICDL_SOURCES || '';

export function platformRows(platforms, channels, values) {
  const rows = new Map(), quality = new Map(channels.map(channel => [channel.id, channel]));
  const sources = csv(sourceValue(values));
  const sourceSet = new Set(sources.map(clientPlatform));
  const lxSelected = new Set(csv(values.LX_SOURCES || 'kg,wy,mg,kw').map(value => ({ kugou: 'kg', kuwo: 'kw', netease: 'wy', '163': 'wy', migu: 'mg' })[value] || value));
  const lxReady = yes(values.FNMUSIC_LX_ENABLED) && lxSources(values).some(item => item.active);
  const ensure = (id, name = known[id] || id, metadata = {}) => {
    if (!rows.has(id)) rows.set(id, { id, name, ...metadata, routes: [] });
    return rows.get(id);
  };
  for (const platform of platforms) {
    const row = ensure(platform.id, platform.name, platform);
    const selected = platform.id === 'netease' ? (Object.hasOwn(values, 'FNMUSIC_CONSOLE_NETEASE_ENABLED') || Object.hasOwn(values, 'FNMUSIC_NETEASE_ENABLED')
      ? yes(values.FNMUSIC_CONSOLE_NETEASE_ENABLED ?? values.FNMUSIC_NETEASE_ENABLED) : platform.enabled)
      : sources.length ? sourceSet.has(platform.id) : platform.enabled;
    const serviceEnabled = platform.id === 'netease' || yes(values.FNMUSIC_MUSICDL_ENABLED);
    row.routes.push({ id: platform.id, kind: 'account', name: platform.capabilities.login ? '账号接入' : '公开接入',
      platform, selected, serviceEnabled, enabled: selected && serviceEnabled, channel: quality.get(platform.id) });
  }
  const aggregateClients = new Map([['migu', 'MiguMusicClient'], ...additionalPlatforms(sourceValue(values)).map(client => [clientPlatform(client), client])]);
  for (const client of aggregateClients.values()) {
    const id = clientPlatform(client), row = ensure(id, clientName(client));
    if (commonClients[id]) continue;
    row.routes.push({ id: 'musicdl:' + client, kind: 'aggregate', client, name: '聚合接入',
      selected: sourceSet.has(id), serviceEnabled: yes(values.FNMUSIC_MUSICDL_ENABLED),
      enabled: sourceSet.has(id) && yes(values.FNMUSIC_MUSICDL_ENABLED), channel: quality.get('musicdl:' + client) });
  }
  for (const [source, id] of Object.entries(lxPlatforms)) {
    ensure(id).routes.push({ id: 'lx:' + source, kind: 'lx', source, name: '洛雪接入',
      selected: lxSelected.has(source), serviceEnabled: lxReady, enabled: lxReady && lxSelected.has(source), channel: quality.get('lx:' + source) });
  }
  return [...rows.values()].map(row => ({ ...row, enabled: row.routes.some(route => route.enabled) }));
}

export function platformStatus(row) {
  const active = row.routes.filter(route => route.enabled);
  if (!active.length) return { status: 'default', text: '未启用' };
  if (active.some(route => route.kind !== 'account' || !route.platform.capabilities.login || route.platform.auth?.logged_in)) return { status: 'success', text: '已启用' };
  const platform = active[0].platform;
  return { status: platform.status === '登录已过期' ? 'warning' : 'default', text: platform.status || '待登录' };
}

export function patchAggregatePlatform(values, client, enabled) {
  const id = clientPlatform(client);
  const sources = csv(sourceValue(values)).filter(value => clientPlatform(value) !== id);
  if (enabled) sources.push(client);
  if (!sources.length) throw new Error('请至少保留一个平台直连接入。');
  const raw = [...new Set(sources)].join(',');
  return { FNMUSIC_ONLINE_SOURCES: raw, MUSICDL_SOURCES: raw };
}

export function patchLxPlatform(values, source, enabled) {
  const aliases = { kugou: 'kg', kuwo: 'kw', netease: 'wy', '163': 'wy', migu: 'mg' };
  const selected = csv(values.LX_SOURCES || 'kg,wy,mg,kw').map(value => aliases[value] || value).filter(value => value !== source);
  if (enabled) selected.push(source);
  if (!selected.length) throw new Error('请至少保留一个洛雪平台；停用整个接入请前往接入管理。');
  return { LX_SOURCES: [...new Set(selected)].join(',') };
}
