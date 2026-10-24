export function channelOverrides(raw) {
  try { const value = JSON.parse(raw || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
export function channelPreference(channel, values) {
  return channelOverrides(values.FNMUSIC_CHANNEL_QUALITIES)[channel] ?? (channel === 'qq' ? values.FNMUSIC_QQ_QUALITY || 'auto' : 'auto');
}
export function patchChannelQuality(raw, channel, quality) {
  return JSON.stringify({ ...channelOverrides(raw), [channel]: quality });
}
export function acquisitionQuality(platform, values, mode) {
  const allowed = platform?.capabilities?.qualities || ['original'];
  const preference = channelPreference(platform?.id, values);
  const normalized = ({ standard: 'mp3_128', higher: 'mp3_320', exhigh: 'mp3_320', hires: 'lossless', jymaster: 'lossless' })[preference] || preference;
  const desired = normalized === 'auto' ? { smooth: 'mp3_128', balanced: 'mp3_320', high: 'lossless' }[mode] : normalized === 'master' ? 'lossless' : normalized;
  return allowed.includes(desired) ? desired : allowed.includes('original') ? 'original' : allowed[0];
}
