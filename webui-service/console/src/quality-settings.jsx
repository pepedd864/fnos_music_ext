import { useEffect, useState } from 'react';
import { Alert, Button, List, Select, Space, Spin, Typography } from 'antd';
import { channelPreference, patchChannelQuality, qualityChannelsForScope } from './quality-model.js';
const { Text, Title } = Typography;

export function QualitySettings({ api, s, scope }) {
  const [channels, setChannels] = useState([]), [error, setError] = useState(''), [revision, setRevision] = useState(0), [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api('/api/console/quality').then(result => { if (alive) { setChannels(result.channels || []); setError(''); } }).catch(error => { if (alive) setError(error.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [revision, s.saved.FNMUSIC_MUSICDL_ENABLED, s.saved.FNMUSIC_NETEASE_ENABLED, s.saved.FNMUSIC_CONSOLE_NETEASE_ENABLED, s.saved.FNMUSIC_LX_ENABLED, s.saved.FNMUSIC_ONLINE_SOURCES, s.saved.LX_SOURCES]);
  const values = { ...s.saved, ...s.changes };
  const visible = qualityChannelsForScope(channels, scope);
  return <section className="platform-detail-section"><Title level={5}>{scope === 'other' ? '其他音源音质' : '音质'}</Title><Spin spinning={loading}><Space direction="vertical" size={16} className="settings-stack">
    {error && <Alert type="error" title={error} showIcon action={<Button onClick={() => setRevision(value => value + 1)}>重试</Button>} />}
    <List dataSource={visible} locale={{ emptyText: error ? '音质设置暂不可用' : '此音源未提供可配置的音质' }} renderItem={channel => <List.Item><List.Item.Meta title={scope === 'other' ? `${channel.name} · ${channel.route}` : '优先音质'} description={channel.note} /><Select aria-label={channel.name + ' · ' + channel.route + '音质'} value={channel.configurable ? channelPreference(channel.id, values) : 'original'} options={channel.options} disabled={!channel.configurable || s.saving || s.loading || !s.schema.FNMUSIC_CHANNEL_QUALITIES} onChange={quality => s.set('FNMUSIC_CHANNEL_QUALITIES', patchChannelQuality(s.value('FNMUSIC_CHANNEL_QUALITIES'), channel.id, quality))} className="channel-quality-select" /></List.Item>} />
    <Text type="secondary">实际音质取决于账号权限，已保存的文件保持原样。</Text>
  </Space></Spin></section>;
}
