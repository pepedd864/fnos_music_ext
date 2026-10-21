import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Flex, Input, List, Select, Space, Tag, Typography } from 'antd';
import { CloudDownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { defaultPlatform, discoveryRequest, emptyDiscovery, platformBlock } from './discovery-model.js';

const { Text } = Typography;
const duration = seconds => `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, '0')}`;

// Search and recommendations share presentation, but keep separate state in Console.
export function Discovery({ kind, state, setState, query = '', setQuery, m, api, Cover, PlatformLogo }) {
  const recommending = kind === 'recommend';
  const pid = state.platformId || defaultPlatform(m.platforms, kind);
  const platform = m.platforms.find(p => p.id === pid), blocked = platformBlock(platform, kind);
  const [loading, setLoading] = useState(false);
  const epoch = useRef(0), controller = useRef(null), revision = useRef(m.discoveryRevision);
  const cancel = () => { epoch.current++; controller.current?.abort(); };
  useEffect(() => { cancel(); setLoading(false); return cancel; }, [pid, blocked]);
  useEffect(() => { if (!state.platformId && pid) setState(current => ({ ...current, platformId: pid })); }, [pid]);

  const run = async (next = false, submitted = query) => {
    const request = discoveryRequest(kind, platform, state, { next, query: submitted });
    if (!request) return;
    cancel(); const version = epoch.current;
    controller.current = new AbortController();
    setLoading(true); setState(current => ({ ...current, warning: '' }));
    try {
      const result = await api(request.path, undefined, undefined, controller.current.signal);
      if (version !== epoch.current) return;
      setState({ platformId: request.platformId, items: result.items || [], query: request.query, page: request.page,
        cursor: result.next_cursor || 0, loaded: true, hasMore: Boolean(result.has_more), warning: result.warning || '' });
      m.contentRef.current?.scrollTo({ top: 0 });
    } catch (err) {
      if (version === epoch.current && err.name !== 'AbortError') setState(current => ({ ...current, warning: err.message }));
    } finally { if (version === epoch.current) setLoading(false); }
  };
  useEffect(() => {
    if (revision.current === m.discoveryRevision) return;
    revision.current = m.discoveryRevision;
    if (state.loaded && !blocked) run(false, state.query);
  }, [m.discoveryRevision]);

  const switchPlatform = value => { cancel(); setLoading(false); setState(emptyDiscovery(value)); };
  const unavailable = {
    loading: '正在读取音乐平台…',
    unsupported: recommending ? '该平台暂未接入个人推荐' : '该平台暂未接入歌曲搜索',
    disabled: '请先启用该平台',
    login: platform?.auth?.state === 'expired' ? '登录已过期，请重新登录后获取推荐' : '登录后获取个人推荐',
  };
  return <Space direction="vertical" size={20} style={{ width: '100%' }}>
    <Flex className="discovery-toolbar" gap={12} wrap align="center">
      <Select aria-label={recommending ? '推荐平台' : '搜索平台'} value={pid || undefined} placeholder="选择音乐平台" loading={!m.platforms.length} onChange={switchPlatform} className="discovery-platform"
        options={m.platforms.map(p => ({ value: p.id, label: <Space size={8}><PlatformLogo platform={p} size={22} />{p.name}</Space> }))} />
      {recommending ? <Button type="primary" icon={<ReloadOutlined />} disabled={!!blocked} loading={loading} onClick={() => run()}>{state.loaded ? '重新获取' : '获取推荐'}</Button> :
        <Input.Search aria-label="搜索平台歌曲" value={query} maxLength={200} allowClear onChange={e => setQuery(e.target.value)} onSearch={value => run(false, value)} placeholder="歌曲、歌手或专辑" enterButton="搜索" loading={loading} className="discovery-search" disabled={!!blocked} />}
    </Flex>
    {state.warning && !blocked && <Alert type="warning" title={state.warning} showIcon />}
    <Card className="discovery-results" title={!blocked && state.loaded ? <Flex align="center" gap={8} wrap><Text strong>{recommending ? '为你推荐' : `“${state.query}”的搜索结果`}</Text><Tag>{platform.name}</Tag>{!recommending && <Text type="secondary" style={{ fontSize: 13 }}>第 {state.page} 页</Text>}</Flex> : undefined}>
      {blocked ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={unavailable[blocked]}>
        {blocked === 'disabled' && <Button type="primary" loading={m.busy === pid} onClick={() => m.togglePlatform(platform, true)}>启用平台</Button>}
        {blocked === 'login' && <Button type="primary" onClick={() => m.setAccount(pid)}>登录账号</Button>}
      </Empty> : <>
        <List loading={loading} dataSource={state.items} rowKey={track => `${track.platform}:${track.id || track.mid || track.title}:${track.artist}`}
          locale={{ emptyText: <Empty description={state.loaded ? (recommending ? '本次没有获取到推荐，请稍后重试' : '没有找到匹配的歌曲') : (recommending ? '获取所选平台的个人推荐' : '输入关键词，搜索所选平台的歌曲')} /> }}
          renderItem={track => <List.Item actions={[<Button key="save" icon={<CloudDownloadOutlined />} onClick={() => m.setAcquire(track)}>保存到 NAS</Button>]}><List.Item.Meta avatar={<Cover song={track} size={42} />} title={track.title} description={`${track.artist || '未知歌手'} · ${track.album || '未知专辑'} · ${duration(track.duration_s)}`} /></List.Item>} />
        {state.hasMore && <Flex justify="space-between" align="center" className="discovery-pagination"><Text type="secondary">{recommending ? '继续发现更多歌曲' : `“${state.query}” · 第 ${state.page} 页`}</Text><Button disabled={loading} onClick={() => run(true)}>{recommending ? '换一批' : '下一页'}</Button></Flex>}
      </>}
    </Card>
  </Space>;
}
