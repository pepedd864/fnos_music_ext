import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, App, Avatar, Badge, Breadcrumb, Button, Card, Col, Collapse, ConfigProvider,
  Descriptions, Drawer, Empty, Flex, Form, Input, Layout, List, Menu, Modal, Pagination,
  Popconfirm, Row, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AppstoreOutlined, CheckCircleFilled, CloudDownloadOutlined, CloudOutlined, DeleteOutlined,
  FileOutlined, FolderOpenOutlined, LinkOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
  MoreOutlined, PlayCircleOutlined, ReloadOutlined, SettingOutlined, SoundOutlined, SwapOutlined, UndoOutlined } from '@ant-design/icons';
import 'antd/dist/reset.css';
import './style.css';

const { Header, Sider, Content } = Layout;
const { Title, Text, Paragraph } = Typography;
const BASE = location.pathname.startsWith('/app/fnmusic-ext') ? '/app/fnmusic-ext' : '';
const qualities = [{ value: 'mp3_128', label: '一般 · MP3 128k' }, { value: 'mp3_320', label: '高品质 · MP3 320k' }, { value: 'lossless', label: '无损 · FLAC' }, { value: 'original', label: '音源实际音质' }];
const qualityLabel = value => qualities.find(q => q.value === value)?.label || '自动';
const names = { qq: 'QQ 音乐', kugou: '酷狗音乐', kuwo: '酷我音乐' };
const duration = seconds => `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, '0')}`;
const bytes = n => `${((n || 0) / 1048576).toFixed(1)} MB`;
const rate = file => file.bitrate ? `${Math.round(file.bitrate / 1000)}k` : file.sample_rate ? `${file.sample_rate / 1000} kHz` : '';
const preferred = song => song.files.find(f => f.id === song.preferred) || song.files[0];
const pages = [
  { key: 'library', label: '我的曲库', icon: <SoundOutlined /> },
  { key: 'platforms', label: '音乐平台', icon: <AppstoreOutlined /> },
  { key: 'discover', label: '搜索与推荐', icon: <CloudOutlined /> },
  { key: 'tasks', label: '下载任务', icon: <CloudDownloadOutlined /> },
  { key: 'directories', label: '音乐目录', icon: <FolderOpenOutlined /> },
];
const headings = {
  library: ['我的曲库', '歌曲聚合展示，音质与文件版本在一处管理。'],
  platforms: ['音乐平台', '连接常用账号，分别管理平台启用状态与登录状态。'],
  discover: ['搜索与推荐', '发现歌曲，按需保存到 NAS。'],
  tasks: ['下载任务', '查看音质获取与文件整理的进度和结果。'],
  directories: ['音乐目录', '管理你选中的 NAS 目录，包含已有本地音乐。'],
};

async function api(path, body, method) {
  const response = await fetch(BASE + path, { credentials: 'same-origin', cache: 'no-store',
    method: method || (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(typeof data.detail === 'string' ? data.detail : data.error || `请求失败（${response.status}）`);
  return data;
}
const library = body => api('/api/library', body);

function Cover({ song, size = 46 }) {
  return <Avatar shape="square" size={size} src={song?.cover_url || undefined} alt={song?.album || song?.title || '专辑封面'} icon={<SoundOutlined />} style={{ flexShrink: 0, background: '#dce8ed', color: '#507387' }} />;
}
function PlatformLogo({ platform, size = 44 }) {
  return <Avatar shape="square" size={size} src={platform.logo} alt={`${platform.name}图标`} style={{ background: '#fff', border: '1px solid #f0f0f0', flexShrink: 0 }} />;
}
function Metrics({ m }) {
  const stats = m.data?.stats || {};
  return <Row gutter={[16, 16]} className="metrics">{[
    ['歌曲', stats.songs || 0, '首', <SoundOutlined />], ['本地文件', stats.files || 0, '份', <FileOutlined />],
    ['多版本歌曲', stats.multi || 0, '首', <SwapOutlined />], ['音乐目录', m.roots.length, '个', <FolderOpenOutlined />],
  ].map(([title, value, unit, icon]) => <Col xs={12} md={6} key={title}><Card><Statistic title={title} value={value} prefix={icon} suffix={<Text type="secondary" style={{ fontSize: 13 }}>{unit}</Text>} /></Card></Col>)}</Row>;
}
function Library({ m }) {
  const footerRef = useRef(null), [footerHeight, setFooterHeight] = useState(0);
  useEffect(() => {
    const footer = footerRef.current;
    if (!footer) return;
    const measure = () => setFooterHeight(Math.ceil(footer.getBoundingClientRect().height));
    const observer = new ResizeObserver(measure);
    observer.observe(footer);
    measure();
    return () => observer.disconnect();
  }, [m.filter]);
  const columns = [
    { title: '歌曲 / 歌手', width: 310, render: (_, song) => <Space size={12}><Cover song={song} /><div className="song-name"><Button type="link" className="title-button" onClick={() => m.setSelected(song.id)}>{song.title}</Button><Text type="secondary" className="subline">{song.artist || '未知歌手'}</Text></div></Space> },
    { title: '专辑', dataIndex: 'album', ellipsis: true, width: 210, render: text => <Text type="secondary">{text || '—'}</Text> },
    { title: '默认版本', width: 140, render: (_, s) => preferred(s) ? <Tag color="blue">{preferred(s).format} {rate(preferred(s))}</Tag> : '—' },
    { title: '文件版本', width: 110, render: (_, s) => <Button type={s.files.length > 1 ? 'link' : 'text'} onClick={() => m.setSelected(s.id)}>{s.files.length} 个版本</Button> },
    { title: '时长', width: 80, render: (_, s) => duration(s.duration_s) },
    { title: '', width: 92, render: (_, s) => <Space size={0}><Tooltip title="播放默认版本"><Button type="text" aria-label={`播放 ${s.title}`} disabled={!preferred(s) || preferred(s).state !== 'available'} icon={<PlayCircleOutlined />} onClick={() => m.setPlaying(preferred(s))} /></Tooltip><Button type="text" aria-label={`管理 ${s.title}`} icon={<MoreOutlined />} onClick={() => m.setSelected(s.id)} /></Space> },
  ];
  return <>
    <Flex className="library-toolbar" justify="space-between" align="center" wrap gap={16}>
      <Tabs activeKey={m.filter} onChange={m.setFilter} items={[{ key: 'all', label: '全部歌曲' }, { key: 'multi', label: '多个音质版本' }, { key: 'trash', label: <Space>回收站{m.trash.length > 0 && <Badge count={m.trash.length} color="#8c8c8c" />}</Space> }]} />
      <Input.Search allowClear placeholder="搜索歌曲、歌手或专辑" aria-label="搜索曲库" className="song-search" onSearch={value => { m.setQuery(value); m.setPageNumber(1); }} />
    </Flex>
    {m.filter === 'trash' ? <Trash m={m} /> : <>
      <Flex gap={12} align="center" wrap style={{ marginBottom: 16 }}><Select aria-label="按音乐目录筛选" value={m.rootFilter} onChange={value => { m.setRootFilter(value); m.setPageNumber(1); }} options={[{ value: '', label: '全部音乐目录' }, ...m.roots.map(r => ({ value: r.id, label: r.path }))]} style={{ minWidth: 220 }} />
        {Boolean(m.data?.stats?.exact_copies) && <Tag>完全相同的副本 {m.data.stats.exact_copies} 份</Tag>}</Flex>
      <Table columns={columns} rowKey="id" dataSource={m.songs} loading={m.loading} pagination={false} scroll={{ x: 950 }} sticky={{ getContainer: () => m.contentRef.current, offsetScroll: footerHeight }} className="library-table" locale={{ emptyText: <Empty description={m.roots.length ? '没有匹配的歌曲，扫描曲库后会显示音频文件' : '先添加一个音乐目录'}>{!m.roots.length && <Button type="primary" onClick={() => m.navigate('directories')}>添加音乐目录</Button>}</Empty> }} />
      <div ref={footerRef} className="library-footer"><Pagination current={m.pageNumber} pageSize={50} total={m.data?.total || 0} onChange={m.setPageNumber} showSizeChanger={false} />
      <Paragraph type="secondary" className="library-note">同一录音的不同音质聚合展示；Live、伴奏等版本独立保留。</Paragraph></div>
    </>}
  </>;
}
function Platforms({ m }) {
  return <Space direction="vertical" size={24} style={{ width: '100%' }}>
    <Flex justify="space-between" align="center" wrap gap={12}><Text type="secondary">常用平台优先展示，按需启用。</Text><Select aria-label="默认音质" value={m.quality} options={qualities.filter(q => q.value !== 'original')} onChange={m.changeQuality} style={{ width: 230 }} /></Flex>
    <Row gutter={[20, 20]}>{m.platforms.map(p => <Col xs={24} lg={8} key={p.id}><Card className="platform-card" title={<Space size={12}><PlatformLogo platform={p} /><Text strong>{p.name}</Text></Space>} extra={<Switch checked={p.enabled} loading={m.busy === p.id} aria-label={`${p.enabled ? '停用' : '启用'}${p.name}`} onChange={value => m.togglePlatform(p, value)} />}>
      <Space direction="vertical" size={18} style={{ width: '100%' }}><Badge status={p.auth?.logged_in ? 'success' : p.status === '登录已过期' ? 'warning' : 'default'} text={p.status} /><Flex justify="space-between" align="center"><Tag color={p.enabled ? 'blue' : 'default'}>{p.enabled ? '参与搜歌' : '尚未启用'}</Tag><Button type="link" onClick={() => m.setAccount(p.id)}>{p.auth?.logged_in ? '管理账号' : '登录'}<LinkOutlined /></Button></Flex></Space>
    </Card></Col>)}</Row>
    <Collapse items={[{ key: 'advanced', label: '其他来源与高级接入', children: <Space direction="vertical" size={14}><Space><CloudOutlined /><Text>网易云音乐</Text></Space><Space><CloudOutlined /><Text>洛雪自定义源</Text></Space><Button href={BASE + '/advanced'} target="_blank" icon={<SettingOutlined />}>打开高级设置</Button></Space> }]} />
  </Space>;
}
function Account({ m }) {
  const p = m.platforms.find(p => p.id === m.account);
  const [qr, setQr] = useState(null), [state, setState] = useState(''), [busy, setBusy] = useState(false), [kind, setKind] = useState('qq');
  const epoch = useRef(0);
  useEffect(() => { epoch.current++; setQr(null); setState(''); setBusy(false); return () => { epoch.current++; }; }, [m.account]);
  useEffect(() => {
    if (!qr) return;
    const version = epoch.current;
    const deadline = Date.now() + qr.expires_in * 1000;
    let timer;
    const poll = async () => {
      if (version !== epoch.current) return;
      if (Date.now() > deadline) { setState('二维码已过期，请重新生成'); setQr(null); return; }
      try {
        const result = await api('/api/qq/auth/login/check', { session_id: qr.session_id });
        if (version !== epoch.current) return;
        setState({ scan: '等待扫码', conf: '已扫码，请在手机上确认', done: '登录凭据已保存', timeout: '二维码已过期', refuse: '已取消授权' }[result.state] || '等待扫码');
        if (['done', 'timeout', 'refuse'].includes(result.state)) { setQr(null); await m.loadPlatforms(); return; }
      } catch (err) { if (version === epoch.current) setState(err.message); }
      if (version === epoch.current) timer = setTimeout(poll, 2400);
    };
    timer = setTimeout(poll, 2200);
    return () => clearTimeout(timer);
  }, [qr]);
  const login = async () => {
    const version = ++epoch.current; setBusy(true); setQr(null); setState('正在生成二维码');
    try {
      const result = await api('/api/qq/auth/login', { kind });
      if (version === epoch.current) { setQr(result); setState('请扫码并在手机上确认'); }
    } catch (err) { if (version === epoch.current) setState(err.message); }
    finally { if (version === epoch.current) setBusy(false); }
  };
  const action = async op => { setBusy(true); setQr(null); epoch.current++; try { const r = await api('/api/qq/auth/' + op, {}); await m.loadPlatforms(); setState(op === 'logout' ? '已退出登录' : r.verified ? '账号验证成功' : '账号需要重新登录'); } catch (err) { setState(err.message); } finally { setBusy(false); } };
  return <Modal title={p ? <Space><PlatformLogo platform={p} size={28} />{p.name} · {p.auth?.logged_in ? '账号管理' : '登录'}</Space> : '账号管理'} open={!!p} onCancel={() => { epoch.current++; m.setAccount(null); }} footer={null} destroyOnHidden>
    {p && <Space direction="vertical" size={20} style={{ width: '100%', marginTop: 12 }}>
      {p.capabilities.login ? <>
        <Descriptions column={1} items={[{ key: 'state', label: '登录状态', children: p.status }, { key: 'account', label: '账号', children: p.auth.account || '—' }, { key: 'expires', label: '凭据到期', children: p.auth.expires_at ? new Date(p.auth.expires_at * 1000).toLocaleString() : '由平台决定' }]} />
        {qr && <img src={qr.image} alt="QQ 音乐登录二维码" style={{ width: 220, alignSelf: 'center' }} />}
        {state && <Text role="status">{state}</Text>}
        <Flex gap={10} wrap><Select value={kind} onChange={setKind} options={[{ value: 'qq', label: 'QQ 扫码' }, { value: 'wx', label: '微信扫码' }]} /><Button type="primary" loading={busy} onClick={login}>{qr ? '重新生成' : '扫码登录'}</Button><Button loading={busy} disabled={!p.auth.logged_in && p.auth.state !== 'expired'} onClick={() => action('verify')}>验证 / 刷新</Button>
          <Popconfirm title="退出 QQ 音乐账号？" onConfirm={() => action('logout')}><Button danger disabled={!p.auth.logged_in && p.auth.state !== 'expired'}>退出登录</Button></Popconfirm></Flex>
      </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该平台暂未接入账号登录；启用后可尝试搜索和保存公开可用的歌曲。" />}
    </Space>}
  </Modal>;
}
function VersionFiles({ song, m }) {
  return <Space direction="vertical" size={12} style={{ width: '100%' }}>{song.files.map(file => <Card key={file.id} size="small" className={file.id === song.preferred ? 'file-card preferred-file' : 'file-card'}>
    <Flex justify="space-between" align="center" gap={8}><Text strong>{file.format} {rate(file)}</Text>{file.id === song.preferred ? <Tag color="blue" icon={<CheckCircleFilled />}>默认版本</Tag> : <Button size="small" type="link" disabled={file.state !== 'available'} onClick={() => m.mutate({ action: 'prefer', id: file.id }, '已设置默认版本')}>设为默认</Button>}</Flex>
    <Paragraph type="secondary" className="file-meta">{bytes(file.size)} · {names[file.provider] || '本地导入'} · {file.sample_rate ? `${file.sample_rate / 1000} kHz` : ''}</Paragraph>
    <Paragraph type="secondary" className="file-path" copyable>{file.path}</Paragraph>
    <Flex justify="space-between" align="center" gap={6} wrap><Badge status={file.state === 'available' ? 'success' : 'warning'} text={file.state === 'available' ? '本地已保存' : '文件缺失，请扫描'} />
      <Space wrap><Button size="small" disabled={file.state !== 'available'} icon={<PlayCircleOutlined />} onClick={() => m.setPlaying(file)}>试听</Button><Button size="small" disabled={file.state !== 'available'} onClick={() => m.setConvert(file)}>转换</Button>
        <Popconfirm title="移入回收站？" description="只移动所选音频文件，其他版本保留。" okText="移入回收站" cancelText="取消" onConfirm={() => m.mutate({ action: 'trash', id: file.id }, '已移入回收站，可以恢复')}><Button danger type="text" size="small" disabled={m.playing?.id === file.id || file.state !== 'available'} icon={<DeleteOutlined />}>移入回收站</Button></Popconfirm></Space>
    </Flex>
    {file.sha256 && song.files.some(f => f.id !== file.id && f.sha256 === file.sha256) && <Tag style={{ marginTop: 12 }}>内容完全相同的副本</Tag>}
  </Card>)}</Space>;
}
function SongDrawer({ m }) {
  const song = m.songs.find(s => s.id === m.selected);
  return <Drawer title="歌曲详情" open={!!song} width={540} onClose={() => m.setSelected(null)} destroyOnHidden>{song && <Space direction="vertical" size={24} style={{ width: '100%' }}>
    <Space size={18} align="start"><Cover song={song} size={82} /><div><Title level={4} style={{ margin: '0 0 8px' }}>{song.title}</Title><Text type="secondary">{song.artist || '未知歌手'}</Text></div></Space>
    <Descriptions column={1} size="small" items={[{ key: 'album', label: '专辑', children: song.album || '—' }, { key: 'duration', label: '时长', children: duration(song.duration_s) }]} />
    <div><Title level={5}>已有音质版本 <Text type="secondary">{song.files.length} 份</Text></Title><VersionFiles song={song} m={m} /></div>
    <Button icon={<CloudDownloadOutlined />} onClick={() => { m.setDiscoverQuery(`${song.title} ${song.artist}`); m.navigate('discover'); }}>查找其他音质</Button>
    <Text type="secondary">默认版本当前用于管理页试听，尚未同步到飞牛音乐。</Text>
  </Space>}</Drawer>;
}
function Trash({ m }) {
  return <Card><List dataSource={m.trash} locale={{ emptyText: <Empty description="回收站为空" /> }} renderItem={file => <List.Item actions={[<Button key="restore" icon={<UndoOutlined />} onClick={() => m.mutate({ action: 'restore', id: file.id }, '文件已恢复')}>恢复文件</Button>]}><List.Item.Meta avatar={<Avatar icon={<FileOutlined />} />} title={file.title} description={<Space direction="vertical"><Text type="secondary">{file.format} {rate(file)} · {bytes(file.size)}</Text><Text type="secondary">{file.path}</Text>{['moving', 'restoring'].includes(file.state) && <Text type="warning">操作曾中断，请检查原路径是否已有文件</Text>}</Space>} /></List.Item>} /></Card>;
}
const taskStates = { queued: ['待处理', 'default'], running: ['处理中', 'processing'], done: ['已完成', 'success'], failed: ['失败', 'error'], interrupted: ['已中断', 'warning'], cancelled: ['已取消', 'default'] };
function Tasks({ m }) {
  return <Card title="音质获取与整理任务"><List dataSource={m.jobs} locale={{ emptyText: <Empty description="暂无任务" /> }} renderItem={job => <List.Item actions={['failed', 'interrupted'].includes(job.state) ? [<Button key="retry" onClick={() => m.mutate({ action: 'retry', id: job.id }, '已重新加入任务')}>重试</Button>] : job.state === 'queued' ? [<Button key="cancel" onClick={() => m.mutate({ action: 'cancel', id: job.id }, '已撤回')}>撤回</Button>] : []}>
    <List.Item.Meta avatar={<Avatar icon={<CloudDownloadOutlined />} style={{ background: '#e6f4ff', color: '#1677ff' }} />} title={<Space>{job.title}<Tag color={taskStates[job.state]?.[1]}>{taskStates[job.state]?.[0] || job.state}</Tag></Space>} description={<Space direction="vertical"><Text type="secondary">{{ scan: '目录扫描', download: '平台歌曲保存', convert: '本地音质转换' }[job.kind]} · {new Date(job.created * 1000).toLocaleString()}</Text>{job.error && <Text type={job.state === 'failed' ? 'danger' : 'secondary'}>{job.error}</Text>}</Space>} />
  </List.Item>} /></Card>;
}
async function chooseDirectory() {
  const mod = await import(/* @vite-ignore */ BASE + '/static/vendor/trim-web-app.js');
  const sdk = new mod.TrimApp();
  const result = await sdk.pickUserFile({ directory: true, title: '选择音乐目录', okText: '选择', sidebarGroup: ['myFiles', 'otherShare', 'favorites'] });
  return result?.data?.[0];
}
function Directories({ m }) {
  const [open, setOpen] = useState(false), [path, setPath] = useState('');
  return <>
    <Card title="已选择的音乐目录" extra={<Button icon={<FolderOpenOutlined />} onClick={() => setOpen(true)}>添加目录</Button>}><List dataSource={m.roots} locale={{ emptyText: <Empty description="还没有添加音乐目录" /> }} renderItem={root => <List.Item actions={[<Popconfirm key="remove" title="移除该目录的管理记录？" description="原目录和歌曲文件保留。" onConfirm={() => m.mutate({ action: 'remove_root', id: root.id }, '已移除目录管理记录')}><Button danger type="text">移除</Button></Popconfirm>]}><List.Item.Meta avatar={<Avatar icon={<FolderOpenOutlined />} />} title={<Text copyable>{root.path}</Text>} description={root.last_scan ? `上次扫描 ${new Date(root.last_scan * 1000).toLocaleString()}` : '尚未扫描'} /></List.Item>} /></Card>
    <Modal title="添加音乐目录" open={open} onCancel={() => setOpen(false)} okText="添加并扫描" confirmLoading={m.busy === 'directory'} onOk={async () => { const ok = await m.mutate({ action: 'add_root', path }, '目录已添加'); if (ok) { setOpen(false); setPath(''); await m.mutate({ action: 'enqueue', kind: 'scan' }, '扫描任务已加入'); } }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}><Text type="secondary">选择 NAS 中的具体音乐文件夹。首次扫描只建立索引。</Text><Input aria-label="音乐目录路径" value={path} onChange={e => setPath(e.target.value)} placeholder="/vol1/…/Music" /><Button icon={<FolderOpenOutlined />} onClick={async () => { try { const p = await chooseDirectory(); if (p) setPath(p); } catch { m.message.info('请在飞牛桌面中使用目录选择器，或直接填写 NAS 路径'); } }}>从 NAS 选择</Button></Space>
    </Modal>
  </>;
}
function Discover({ m }) {
  const [pid, setPid] = useState('qq'), [items, setItems] = useState([]), [loading, setLoading] = useState(false), [warning, setWarning] = useState(''), [cursor, setCursor] = useState(0), [searchPage, setSearchPage] = useState(1), [mode, setMode] = useState('search'), [hasMore, setHasMore] = useState(false);
  const epoch = useRef(0);
  useEffect(() => { epoch.current++; setItems([]); setWarning(''); setHasMore(false); setLoading(false); setCursor(0); setSearchPage(1); }, [pid]);
  useEffect(() => () => { epoch.current++; }, []);
  const run = async (kind, next = false) => {
    const version = ++epoch.current; setLoading(true); setWarning('');
    const page = next ? searchPage + 1 : 1;
    try {
      const result = await api(`/api/console/platforms/${pid}/${kind === 'recommend' ? `recommend?cursor=${next ? cursor : 0}` : `search?q=${encodeURIComponent(m.discoverQuery)}&page=${page}`}`);
      if (version !== epoch.current) return;
      setItems(result.items || []); setWarning(result.warning || ''); setCursor(result.next_cursor || 0); setHasMore(result.has_more); setSearchPage(page); setMode(kind);
    } catch (err) { if (version === epoch.current) { setWarning(err.message); setItems([]); } }
    finally { if (version === epoch.current) setLoading(false); }
  };
  const p = m.platforms.find(p => p.id === pid);
  return <Space direction="vertical" size={20} style={{ width: '100%' }}><Flex gap={12} wrap><Select aria-label="搜索平台" value={pid} onChange={setPid} options={m.platforms.map(p => ({ value: p.id, label: p.name }))} style={{ width: 160 }} /><Input.Search aria-label="搜索平台歌曲" value={m.discoverQuery} onChange={e => m.setDiscoverQuery(e.target.value)} onSearch={() => run('search')} placeholder="歌曲、歌手或专辑" enterButton="搜索" loading={loading} style={{ width: 360, maxWidth: '100%' }} disabled={!p?.enabled} />{p?.capabilities.recommend && <Button disabled={!p.enabled || !p.auth.logged_in} loading={loading} onClick={() => run('recommend')}>我的 QQ 推荐</Button>}</Flex>
    {!p?.enabled && <Text type="secondary">请先在音乐平台页启用该平台。</Text>}{warning && <Alert type="warning" title={warning} showIcon />}
    <Card><List loading={loading} dataSource={items} locale={{ emptyText: <Empty description="搜索歌曲，或获取账号推荐" /> }} renderItem={track => <List.Item actions={[<Button key="save" icon={<CloudDownloadOutlined />} onClick={() => m.setAcquire(track)}>保存到 NAS</Button>]}><List.Item.Meta avatar={<Cover song={track} size={42} />} title={track.title} description={`${track.artist || '未知歌手'} · ${track.album || '未知专辑'} · ${duration(track.duration_s)}`} /></List.Item>} />{hasMore && <Button disabled={loading} onClick={() => run(mode, true)}>{mode === 'recommend' ? '换一批' : '下一页'}</Button>}</Card>
  </Space>;
}
function ProduceModal({ m }) {
  const item = m.acquire || m.convert;
  const [quality, setQuality] = useState('mp3_128'), [root, setRoot] = useState('');
  useEffect(() => { setQuality(m.acquire ? m.acquire.platform === 'qq' ? m.quality : 'original' : 'mp3_128'); setRoot(m.roots[0]?.id || ''); }, [item]);
  return <Modal title={m.acquire ? '保存歌曲到 NAS' : '转换本地音质'} open={!!item} onCancel={() => { m.setAcquire(null); m.setConvert(null); }} okText="加入任务" okButtonProps={{ disabled: !root }} onOk={async () => {
    const payload = m.acquire ? { platform: item.platform, track: item, quality, root_id: root } : { file_id: item.id, quality, root_id: root };
    const ok = await m.mutate({ action: 'enqueue', kind: m.acquire ? 'download' : 'convert', payload }, '已加入任务');
    if (ok) { m.setAcquire(null); m.setConvert(null); }
  }}><Form layout="vertical"><Form.Item label="歌曲"><Text>{item?.title || item?.path}</Text></Form.Item><Form.Item label="保存目录"><Select aria-label="保存目录" value={root || undefined} placeholder="请先添加音乐目录" onChange={setRoot} options={m.roots.map(r => ({ value: r.id, label: r.path }))} /></Form.Item><Form.Item label="目标音质"><Select aria-label="目标音质" value={quality} onChange={setQuality} options={qualities.filter(q => m.acquire ? item?.platform === 'qq' ? q.value !== 'original' : q.value === 'original' : ['mp3_128', 'mp3_320'].includes(q.value))} /></Form.Item><Text type="secondary">{m.acquire ? '会校验实际音频后保存。账号权限或音源不可用时，任务会显示失败原因。' : '保留原文件，新增转换版本；低码率文件无法转成真正的高音质。'}</Text></Form></Modal>;
}
function Console() {
  const { message } = App.useApp();
  const [page, setPage] = useState(() => new URLSearchParams(location.search).get('page') || 'library'), [filter, setFilter] = useState('all'), [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState(''), [rootFilter, setRootFilter] = useState(''), [pageNumber, setPageNumber] = useState(1), [data, setData] = useState(null), [platforms, setPlatforms] = useState([]), [quality, setQuality] = useState('mp3_128');
  const [error, setError] = useState(''), [platformError, setPlatformError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState('');
  const [selected, setSelected] = useState(null), [account, setAccount] = useState(null), [acquire, setAcquire] = useState(null), [convert, setConvert] = useState(null), [playing, setPlaying] = useState(null), [discoverQuery, setDiscoverQuery] = useState('');
  const epoch = useRef(0), contentRef = useRef(null);
  useEffect(() => { contentRef.current?.scrollTo({ top: 0, left: 0 }); }, [page, filter, pageNumber, query, rootFilter]);
  const load = async (quiet = false) => {
    const version = ++epoch.current;
    if (!quiet) setLoading(true);
    try { const result = await library({ action: 'list', query, filter, page: pageNumber, root_id: rootFilter }); if (version === epoch.current) { setData(result); setError(''); } }
    catch (err) { if (version === epoch.current) setError(err.message); }
    finally { if (version === epoch.current) setLoading(false); }
  };
  const loadPlatforms = async () => { try { const r = await api('/api/console/platforms'); setPlatforms(r.items); setQuality(['mp3_128', 'mp3_320', 'lossless'].includes(r.quality) ? r.quality : 'mp3_128'); setPlatformError(''); } catch (err) { setPlatformError(err.message); } };
  useEffect(() => { load(); return () => { epoch.current++; }; }, [query, filter, pageNumber, rootFilter]);
  useEffect(() => { loadPlatforms(); }, []);
  const pending = data?.tasks?.some(j => ['running', 'queued'].includes(j.state));
  useEffect(() => { if (!pending) return; const timer = setInterval(() => load(true), 2500); return () => clearInterval(timer); }, [pending, query, filter, pageNumber, rootFilter]);
  useEffect(() => { const url = new URL(location.href); url.searchParams.delete('variant'); url.searchParams.set('page', page); history.replaceState(null, '', url); }, [page]);
  const mutate = async (body, success) => { try { await library(body); if (success) message.success(success); await load(true); return true; } catch (err) { message.error(err.message); return false; } };
  const navigate = key => { setSelected(null); setPage(['versions', 'trash'].includes(key) ? 'library' : key); setFilter(key === 'versions' ? 'multi' : key === 'trash' ? 'trash' : 'all'); setPageNumber(1); };
  const togglePlatform = async (p, value) => { setBusy(p.id); try { await api(`/api/console/platforms/${p.id}`, { enabled: value }, 'PUT'); await loadPlatforms(); message.success(value ? '平台已启用' : '平台已停用'); } catch (err) { message.error(err.message); } finally { setBusy(''); } };
  const changeQuality = async value => { try { await api('/api/config', { values: { FNMUSIC_QQ_QUALITY: value, FNMUSIC_QUALITY_MODE: value === 'mp3_128' ? 'smooth' : value === 'mp3_320' ? 'balanced' : 'high' } }, 'PUT'); setQuality(value); message.success('默认音质已更新，对之后的播放与获取生效'); } catch (err) { message.error(err.message); } };
  const m = { contentRef, page, filter, setFilter: value => { setFilter(value); setPageNumber(1); }, query, setQuery, rootFilter, setRootFilter, pageNumber, setPageNumber, data, songs: data?.songs || [], roots: data?.roots || [], trash: data?.trash || [], jobs: data?.tasks || [], platforms, quality, changeQuality, loading, busy, selected, setSelected, account, setAccount, acquire, setAcquire, convert, setConvert, playing, setPlaying, discoverQuery, setDiscoverQuery, message, navigate, mutate, togglePlatform, loadPlatforms };
  const heading = headings[page] || headings.library;
  return <>
    <Layout className="app-layout"><Sider theme="light" width={224} collapsedWidth={72} collapsed={collapsed} breakpoint="lg" onCollapse={setCollapsed} className="sidebar"><div className="brand"><Text strong style={{ fontSize: 18 }}>{collapsed ? 'fn' : 'fnMusic'}</Text></div><div className="sidebar-nav"><Menu mode="inline" selectedKeys={[page === 'library' && filter === 'multi' ? 'versions' : page === 'library' && filter === 'trash' ? 'trash' : page]} onClick={({ key }) => navigate(key)} items={[{ type: 'group', label: '工作空间', children: pages }, { type: 'group', label: '整理', children: [{ key: 'versions', icon: <SwapOutlined />, label: '多音质版本' }, { key: 'trash', icon: <DeleteOutlined />, label: '回收站' }] }]} /></div><div className="sidebar-foot"><Button type="text" href={BASE + '/advanced'} target="_blank" aria-label="高级设置" icon={<SettingOutlined />}>{!collapsed && '高级设置'}</Button></div></Sider>
      <Layout className="main-layout"><Header className="app-header"><Flex justify="space-between" align="center" style={{ height: '100%' }}><Space size={18}><Button type="text" aria-label="收起或展开导航" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} /><Breadcrumb items={[{ title: 'fnMusic' }, { title: heading[0] }]} /></Space><Button type="text" icon={<ReloadOutlined />} onClick={() => { load(); loadPlatforms(); }}>刷新</Button></Flex></Header><Content ref={contentRef} className="page-content" role="main" aria-label={heading[0]} tabIndex={0}><div className="page-inner"><Flex justify="space-between" align="center" wrap gap={16} className="page-heading"><div><Title level={2}>{heading[0]}</Title><Text type="secondary">{heading[1]}</Text></div>{['library', 'directories'].includes(page) && <Button icon={<ReloadOutlined />} disabled={!m.roots.length || pending} onClick={() => mutate({ action: 'enqueue', kind: 'scan' }, '扫描任务已加入')}>扫描曲库</Button>}</Flex>
        {error && <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => load()}>重试</Button>} style={{ marginBottom: 20 }} />}{platformError && ['platforms', 'discover'].includes(page) && <Alert type="error" title={platformError} action={<Button onClick={loadPlatforms}>重试</Button>} style={{ marginBottom: 20 }} />}
        {page === 'library' ? <>{filter !== 'trash' && <Metrics m={m} />}<Library m={m} /></> : page === 'platforms' ? <Platforms m={m} /> : page === 'discover' ? <Discover m={m} /> : page === 'tasks' ? <Tasks m={m} /> : <Directories m={m} />}
      </div></Content>
    {playing && <Card className="audio-player" size="small"><Flex align="center" gap={12} wrap><Text ellipsis className="playing-title">{playing.path.split('/').pop()}</Text><audio key={playing.id} autoPlay controls src={BASE + '/api/library/audio?id=' + encodeURIComponent(playing.id)} onError={() => message.error('无法播放此文件，请重新扫描曲库')} /><Button type="text" onClick={() => setPlaying(null)}>关闭</Button></Flex></Card>}
      </Layout></Layout><SongDrawer m={m} /><Account m={m} /><ProduceModal m={m} />
  </>;
}
createRoot(document.getElementById('app')).render(<ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#1677ff', borderRadius: 8, fontSize: 15, colorText: '#1f2329', colorTextSecondary: '#59636f', colorTextDescription: '#59636f', colorTextTertiary: '#687483', fontFamily: '-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif' } }}><App><Console /></App></ConfigProvider>);
