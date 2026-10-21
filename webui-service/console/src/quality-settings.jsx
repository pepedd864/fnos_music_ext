import { useEffect, useState } from 'react';
import { Alert, Button, Card, Collapse, List, Select, Space, Tag, Typography } from 'antd';
import { SettingFields } from './settings-fields.jsx';
import { channelPreference, patchChannelQuality } from './quality-model.js';
const { Text } = Typography;

export function QualitySettings({ api, base, s }) {
  const [channels, setChannels] = useState([]), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    api('/api/console/quality').then(result => { if (alive) { setChannels(result.channels || []); setError(''); } }).catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [revision, s.saved.FNMUSIC_MUSICDL_ENABLED, s.saved.FNMUSIC_NETEASE_ENABLED, s.saved.FNMUSIC_LX_ENABLED, s.saved.FNMUSIC_ONLINE_SOURCES, s.saved.LX_SOURCES]);
  const values = { ...s.saved, ...s.changes };
  const list = items => <List dataSource={items} locale={{ emptyText: '尚未启用在线渠道' }} renderItem={channel => <List.Item><List.Item.Meta title={<Space wrap><Text strong>{channel.name}</Text><Tag>{channel.route}</Tag></Space>} description={channel.note} /><Select aria-label={channel.name + ' · ' + channel.route + '音质'} value={channel.configurable ? channelPreference(channel.id, values) : 'original'} options={channel.options} disabled={!channel.configurable || s.saving} onChange={quality => s.set('FNMUSIC_CHANNEL_QUALITIES', patchChannelQuality(s.value('FNMUSIC_CHANNEL_QUALITIES'), channel.id, quality))} className="channel-quality-select" /></List.Item>} />;
  return <Card title="在线音质"><Space direction="vertical" size={20} className="settings-stack"><SettingFields api={api} base={base} s={s} keys={['FNMUSIC_QUALITY_MODE']} />
    <div><Text strong>各渠道音质</Text><div style={{ marginTop: 8 }}><Text type="secondary">默认跟随全局设置，也可为每个渠道单独指定优先档位。实际可用音质取决于账号和音源。</Text></div></div>
    {error && <Alert type="error" title={error} showIcon action={<Button onClick={() => setRevision(value => value + 1)}>重试</Button>} />}
    {list(channels.filter(channel => channel.enabled))}
    {channels.some(channel => !channel.enabled) && <Collapse items={[{ key: 'inactive', label: '未启用的渠道', children: list(channels.filter(channel => !channel.enabled)) }]} />}
    <Text type="secondary">对之后的在线解析生效；已保存的本地文件保留实际音质。</Text>
  </Space></Card>;
}
