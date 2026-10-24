import { useEffect, useState } from 'react';
import { Alert, Button, Form, Select, Typography } from 'antd';
import { channelPreference, patchChannelQuality } from './quality-model.js';
const { Text } = Typography;

export function useQualityChannels(api, saved) {
  const [channels, setChannels] = useState([]), [error, setError] = useState(''), [revision, setRevision] = useState(0), [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api('/api/console/quality').then(result => { if (alive) { setChannels(result.channels || []); setError(''); } }).catch(error => { if (alive) setError(error.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [revision, saved.FNMUSIC_MUSICDL_ENABLED, saved.FNMUSIC_NETEASE_ENABLED, saved.FNMUSIC_CONSOLE_NETEASE_ENABLED, saved.FNMUSIC_LX_ENABLED, saved.FNMUSIC_ONLINE_SOURCES, saved.LX_SOURCES]);
  return { channels, loading, feedback: error && <Alert type="warning" title="音质设置暂时无法读取" description={error} showIcon action={<Button onClick={() => setRevision(value => value + 1)}>重试</Button>} /> };
}

export function ChannelQuality({ channel, s }) {
  if (!channel) return <Text type="secondary">启用此接入后可查看音质设置。</Text>;
  const values = { ...s.saved, ...s.changes };
  return <Form layout="vertical"><Form.Item label="优先音质" extra={channel.configurable ? undefined : channel.note}><Select aria-label={channel.name + ' · ' + channel.route + '音质'} value={channel.configurable ? channelPreference(channel.id, values) : 'original'} options={channel.options} disabled={!channel.configurable || s.saving || s.loading || !s.schema.FNMUSIC_CHANNEL_QUALITIES} onChange={quality => s.set('FNMUSIC_CHANNEL_QUALITIES', patchChannelQuality(s.value('FNMUSIC_CHANNEL_QUALITIES'), channel.id, quality))} /></Form.Item></Form>;
}
