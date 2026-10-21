export const providerKeys = { musicdl: 'FNMUSIC_MUSICDL_ENABLED', musicbox: 'FNMUSIC_NETEASE_ENABLED', lxmusic: 'FNMUSIC_LX_ENABLED' };
export const providerNames = { musicdl: 'musicdl 聚合音源', musicbox: '网易云音乐盒子', lxmusic: '洛雪自定义源' };
export const settingPages = {
  'playback-settings': ['播放与推荐', '设置在线音质、漫游和推荐歌单。'],
  'storage-settings': ['储存与下载', '管理边听边存、歌曲缓存和下载目录。'],
  'search-settings': ['搜索设置', '调整搜索等待时间和翻页方式。'],
  'source-settings': ['音源设置', '管理运行音源、其他平台、网易账号和洛雪脚本。'],
  'llm-settings': ['大模型', '配置用于推荐的 OpenAI 兼容服务。'],
  'service-status': ['运行状态', '查看当前音源和服务连接情况。'],
  about: ['关于', '版本信息、更新检查和诊断日志。'],
};
export function parseArray(raw) {
  try { const value = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(value) ? value : []; } catch { return []; }
}
export function settingValue(raw, spec = {}) {
  const value = raw ?? spec.default ?? '';
  if (spec.kind === 'bool') return value === true || ['true', '1', 'yes'].includes(String(value).toLowerCase());
  if (spec.kind === 'int') return Number(value);
  return String(value);
}
export function changedSettings(changes, schema) {
  const result = {};
  for (const [key, value] of Object.entries(changes)) {
    const spec = schema[key];
    if (!spec) throw new Error('未知设置项：' + key);
    if (spec.kind === 'int' && (value === null || value === '' || !Number.isInteger(Number(value)) || Number(value) < spec.min || Number(value) > spec.max)) throw new Error(spec.label + '超出允许范围');
    if (spec.kind === 'enum' && !spec.values.includes(value)) throw new Error(spec.label + '选项无效');
    if (spec.kind === 'bool' && typeof value !== 'boolean') throw new Error(spec.label + '需要开关值');
    result[key] = value;
  }
  const directories = ['FNMUSIC_TEE_SAVE_DIR', 'FNMUSIC_CACHE_DIR'];
  for (const key of directories) {
    const path = result[key];
    if (path && (!path.startsWith('/') || path.split('/').includes('..'))) throw new Error('目录必须是绝对路径，且不能包含 ..');
  }
  return result;
}
export function editableConfig(data) {
  return Object.fromEntries(Object.entries(data.values).map(([key, value]) => [key, data.schema[key]?.kind === 'secret' ? Boolean(value) : value]));
}
export function patchSettingsDraft(previous, updates, saved, schema) {
  const next = { ...previous };
  for (const [key, value] of Object.entries(updates)) {
    if (schema[key]?.kind === 'secret' && value === '') delete next[key];
    else if (schema[key]?.kind !== 'secret' && value === settingValue(saved[key], schema[key])) delete next[key];
    else next[key] = value;
  }
  return next;
}
export async function persistSettings(api, changes, schema) {
  const values = changedSettings(changes, schema);
  for (const [key, path] of Object.entries(values)) {
    if (schema[key]?.kind !== 'dir' || !path) continue;
    try { const check = await api('/api/fs-check', { path }); if (!check.writable) throw new Error('目录不可写：' + path); }
    catch (error) { if (error.status !== 501) throw error; }
  }
  return api('/api/config', { values }, 'PUT');
}
export function selectProvider(provider) {
  return Object.fromEntries(Object.entries(providerKeys).map(([id, key]) => [key, id === provider]));
}
export function currentProvider(values) {
  return Object.entries(providerKeys).find(([, key]) => settingValue(values[key], { kind: 'bool' }))?.[0] || '';
}
export function lxSources(values) {
  const saved = String(values.LX_SOURCE_URL || '').trim();
  const items = parseArray(values.LX_SOURCE_LIST).filter(item => item && typeof item.url === 'string').map(item => ({ ...item }));
  if (items.length && !items.some(item => 'active' in item)) items.forEach(item => { item.active = item.url === saved; });
  if (saved && !items.some(item => item.url === saved)) items.unshift({ name: saved.split('/').pop() || '洛雪源', url: saved, active: true });
  return items;
}
export function publicEntryKey(item) {
  return [item.provider, item.source, item.provider === 'musicbox' ? 'playlist' : item.kind, String(item.id)].join('|');
}
export function publicSelection(items) {
  const seen = new Set();
  return items.filter(item => { const key = publicEntryKey(item); if (seen.has(key)) return false; seen.add(key); return true; })
    .map(({ provider, source, kind, id }) => ({ provider, source, kind, id: String(id) }));
}
export function neteaseCode(result) { return result?.data?.code ?? result?.code; }
export function externalUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
