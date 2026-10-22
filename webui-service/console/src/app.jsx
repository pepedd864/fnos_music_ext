import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, App, Avatar, Badge, Breadcrumb, Button, Card, Col, ConfigProvider,
  Descriptions, Drawer, Empty, Flex, Form, Input, Layout, List, Menu, Modal, Pagination,
  Popconfirm, Row, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AppstoreOutlined, CheckCircleFilled, CloudDownloadOutlined, DeleteOutlined,
  FileOutlined, FolderOpenOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
  MoreOutlined, PlayCircleOutlined, ReloadOutlined, SearchOutlined, CompassOutlined, SoundOutlined, SwapOutlined, UndoOutlined } from '@ant-design/icons';
import 'antd/dist/reset.css';
import './style.css';
import { pickNas } from './nas.js';
import { acquisitionQuality } from './quality-model.js';
import { initialNavigation, navigationParams } from './navigation-model.js';
import { emptyDiscovery } from './discovery-model.js';
import { Discovery } from './discovery.jsx';
import { settingPages } from './settings-model.js';
import { Settings, SaveSettings, settingsMenu, useSettings } from './settings.jsx';
import { Platforms } from './platforms.jsx';

const { Header, Sider, Content } = Layout;
const { Title, Text, Paragraph } = Typography;
const BASE = location.pathname.startsWith('/app/fnmusic-ext') ? '/app/fnmusic-ext' : '';
const qualities = [{ value: 'mp3_128', label: '一般 · MP3 128k' }, { value: 'mp3_320', label: '高品质 · MP3 320k' }, { value: 'lossless', label: '无损 · FLAC' }, { value: 'original', label: '音源实际音质' }];
const qualityLabel = value => qualities.find(q => q.value === value)?.label || '自动';
const names = { qq: 'QQ 音乐', kugou: '酷狗音乐', kuwo: '酷我音乐', netease: '网易云音乐' };
const duration = seconds => `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, '0')}`;
const bytes = n => `${((n || 0) / 1048576).toFixed(1)} MB`;
const rate = file => file.bitrate ? `${Math.round(file.bitrate / 1000)}k` : file.sample_rate ? `${file.sample_rate / 1000} kHz` : '';
const preferred = song => song.files.find(f => f.id === song.preferred) || song.files[0];
const pages = [
  { key: 'library', label: '我的曲库', icon: <SoundOutlined /> },
  { key: 'platforms', label: '音乐平台', icon: <AppstoreOutlined /> },
  { key: 'search', label: '搜索', icon: <SearchOutlined /> },
  { key: 'recommendations', label: '推荐', icon: <CompassOutlined /> },
  { key: 'tasks', label: '下载任务', icon: <CloudDownloadOutlined /> },
  { key: 'directories', label: '音乐目录', icon: <FolderOpenOutlined /> },
];
const headings = {
  library: ['我的曲库', '歌曲聚合展示，音质与文件版本在一处管理。'],
  platforms: ['音乐平台', '管理平台账号、音质和其他音源。'],
  search: ['搜索', '按平台搜索歌曲、歌手或专辑。'],
  recommendations: ['推荐', '发现合你口味的歌曲，按需保存到 NAS。'],
  tasks: ['下载任务', '查看音质获取与文件整理的进度和结果。'],
  directories: ['音乐目录', '管理你选中的 NAS 目录，包含已有本地音乐。'],
  trash: ['回收站', '恢复移入回收站的音乐文件。'],
};

async function api(path, body, method, signal) {
  const response = await fetch(BASE + path, { credentials: 'same-origin', cache: 'no-store', signal,
    method: method || (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(typeof data.detail === 'string' ? data.detail : typeof data.error === 'string' ? data.error : typeof data.data?.message === 'string' ? data.data.message : Array.isArray(data.detail) ? data.detail.map(item => item.msg).join('；') : `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}
const library = body => api('/api/library', body);

function Cover({ song, size = 46 }) {
  return <Avatar shape="square" size={size} src={song?.cover_url || undefined} alt={song?.album || song?.title || '专辑封面'} icon={<SoundOutlined />} style={{ flexShrink: 0, background: '#dce8ed', color: '#507387' }} />;
}
function PlatformLogo({ platform, size = 44 }) {
  return <Avatar shape="square" size={size} src={platform.logo ? `${platform.logo}?v=20261023` : undefined} alt={`${platform.name}图标`} style={{ background: '#fff', border: '1px solid #f0f0f0', flexShrink: 0 }} />;
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
      <Tabs activeKey={m.filter} onChange={m.setFilter} items={[{ key: 'all', label: '全部歌曲' }, { key: 'multi', label: '多个音质版本' }]} />
      <Input.Search allowClear placeholder="搜索歌曲、歌手或专辑" aria-label="搜索曲库" className="song-search" onSearch={value => { m.setQuery(value); m.setPageNumber(1); }} />
    </Flex>
    <>
      <Flex gap={12} align="center" wrap style={{ marginBottom: 16 }}><Select aria-label="按音乐目录筛选" value={m.rootFilter} onChange={value => { m.setRootFilter(value); m.setPageNumber(1); }} options={[{ value: '', label: '全部音乐目录' }, ...m.roots.map(r => ({ value: r.id, label: r.path }))]} style={{ minWidth: 220 }} />
        {Boolean(m.data?.stats?.exact_copies) && <Tag>完全相同的副本 {m.data.stats.exact_copies} 份</Tag>}</Flex>
      <Table columns={columns} rowKey="id" dataSource={m.songs} loading={m.loading} pagination={false} scroll={{ x: 950 }} sticky={{ getContainer: () => m.contentRef.current, offsetScroll: footerHeight }} className="library-table" onRow={song => ({
        tabIndex: 0, 'aria-label': `查看 ${song.title} 的详情`, 'aria-haspopup': 'dialog',
        onClick: event => { if (!event.target.closest('button,a,input,select,textarea,[role="button"],[role="checkbox"]') && window.getSelection()?.isCollapsed !== false) m.setSelected(song.id); },
        onKeyDown: event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); m.setSelected(song.id); } },
      })} locale={{ emptyText: <Empty description={m.roots.length ? '没有匹配的歌曲，扫描曲库后会显示音频文件' : '先添加一个音乐目录'}>{!m.roots.length && <Button type="primary" onClick={() => m.navigate('directories')}>添加音乐目录</Button>}</Empty> }} />
      <div ref={footerRef} className="library-footer"><Pagination current={m.pageNumber} pageSize={50} total={m.data?.total || 0} onChange={m.setPageNumber} showSizeChanger={false} />
      </div>
    </>
  </>;
}
function Account({ m }) {
  const p = m.platforms.find(p => p.id === m.account);
  const [qr, setQr] = useState(null), [state, setState] = useState(''), [busy, setBusy] = useState(false), [kind, setKind] = useState('qq');
  const epoch = useRef(0);
  useEffect(() => { epoch.current++; setQr(null); setState(''); setBusy(false); setKind(p?.capabilities?.login_options?.[0]?.value || 'app'); return () => { epoch.current++; }; }, [m.account]);
  useEffect(() => {
    if (!qr) return;
    const version = epoch.current;
    const deadline = Date.now() + qr.expires_in * 1000;
    let timer;
    const poll = async () => {
      if (version !== epoch.current) return;
      if (Date.now() > deadline) { setState('二维码已过期，请重新生成'); setQr(null); return; }
      try {
        const result = await api(`/api/console/platforms/${m.account}/auth/login/check`, { session_id: qr.session_id });
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
      const result = await api(`/api/console/platforms/${m.account}/auth/login`, { kind });
      if (version === epoch.current) { setQr(result); setState('请扫码并在手机上确认'); }
    } catch (err) { if (version === epoch.current) setState(err.message); }
    finally { if (version === epoch.current) setBusy(false); }
  };
  const action = async op => { setBusy(true); setQr(null); epoch.current++; try { const r = await api(`/api/console/platforms/${m.account}/auth/` + op, {}); await m.loadPlatforms(); setState(op === 'logout' ? '已退出登录' : r.verified ? '账号验证成功' : '账号需要重新登录'); } catch (err) { setState(err.message); } finally { setBusy(false); } };
  return <Modal title={p ? <Space><PlatformLogo platform={p} size={28} />{p.name} · {!p.capabilities.login ? '接入说明' : p.auth?.logged_in ? '账号管理' : '登录'}</Space> : '账号管理'} open={!!p} onCancel={() => { epoch.current++; m.setAccount(null); }} footer={null} destroyOnHidden>
    {p && <Space direction="vertical" size={20} style={{ width: '100%', marginTop: 12 }}>
      {p.capabilities.login ? <>
        <Descriptions column={1} items={[{ key: 'state', label: '登录状态', children: p.status }, { key: 'account', label: '账号', children: p.auth.account || '—' }, { key: 'expires', label: '凭据到期', children: p.auth.expires_at ? new Date(p.auth.expires_at * 1000).toLocaleString() : '由平台决定' }]} />
        {qr && <img src={qr.image} alt={`${p.name}登录二维码`} style={{ width: 220, alignSelf: 'center' }} />}
        {state && <Text role="status">{state}</Text>}
        <Flex gap={10} wrap><Select value={kind} onChange={setKind} options={p.capabilities.login_options || []} /><Button type="primary" loading={busy} onClick={login}>{qr ? '重新生成' : '扫码登录'}</Button><Button loading={busy} disabled={!p.auth.logged_in && p.auth.state !== 'expired'} onClick={() => action('verify')}>验证 / 刷新</Button>
          <Popconfirm title={`退出${p.name}账号？`} onConfirm={() => action('logout')}><Button danger disabled={!p.auth.logged_in && p.auth.state !== 'expired'}>退出登录</Button></Popconfirm></Flex>
      </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该渠道使用公开目录，支持搜索与平台精选；暂不支持账号登录和个人推荐。" />}
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
    <Button icon={<CloudDownloadOutlined />} onClick={() => { m.setSearchQuery(`${song.title} ${song.artist}`); m.setSearchState(emptyDiscovery(m.searchState.platformId)); m.navigate('search'); }}>查找其他音质</Button>
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
  return pickNas(BASE, { title: '选择音乐目录' });
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
function ProduceModal({ m }) {
  const item = m.acquire || m.convert;
  const [quality, setQuality] = useState('mp3_128'), [root, setRoot] = useState('');
  const platform = m.platforms.find(p => p.id === item?.platform);
  useEffect(() => { setQuality(m.acquire ? acquisitionQuality(platform, { FNMUSIC_CHANNEL_QUALITIES: JSON.stringify(m.qualityPreferences) }, m.qualityMode) : 'mp3_128'); setRoot(m.roots[0]?.id || ''); }, [item]);
  return <Modal title={m.acquire ? '保存歌曲到 NAS' : '转换本地音质'} open={!!item} onCancel={() => { m.setAcquire(null); m.setConvert(null); }} okText="加入任务" okButtonProps={{ disabled: !root }} onOk={async () => {
    const payload = m.acquire ? { platform: item.platform, track: item, quality, root_id: root } : { file_id: item.id, quality, root_id: root };
    const ok = await m.mutate({ action: 'enqueue', kind: m.acquire ? 'download' : 'convert', payload }, '已加入任务');
    if (ok) { m.setAcquire(null); m.setConvert(null); }
  }}><Form layout="vertical"><Form.Item label="歌曲"><Text>{item?.title || item?.path}</Text></Form.Item><Form.Item label="保存目录"><Select aria-label="保存目录" value={root || undefined} placeholder="请先添加音乐目录" onChange={setRoot} options={m.roots.map(r => ({ value: r.id, label: r.path }))} /></Form.Item><Form.Item label="目标音质"><Select aria-label="目标音质" value={quality} onChange={setQuality} options={qualities.filter(q => m.acquire ? (platform?.capabilities?.qualities || ['original']).includes(q.value) : ['mp3_128', 'mp3_320'].includes(q.value))} /></Form.Item><Text type="secondary">{m.acquire ? '会校验实际音频后保存。账号权限或音源不可用时，任务会显示失败原因。' : '保留原文件，新增转换版本；低码率文件无法转成真正的高音质。'}</Text></Form></Modal>;
}
function Console() {
  const { message } = App.useApp();
  const [initial] = useState(() => initialNavigation(location.search, [...pages.map(item => item.key), ...Object.keys(settingPages), 'trash']));
  const [page, setPage] = useState(initial.page), [filter, setFilter] = useState(initial.filter), [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState(''), [rootFilter, setRootFilter] = useState(''), [pageNumber, setPageNumber] = useState(1), [data, setData] = useState(null), [platforms, setPlatforms] = useState([]), [qualityMode, setQualityMode] = useState('smooth'), [qualityPreferences, setQualityPreferences] = useState({});
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [error, setError] = useState(''), [platformError, setPlatformError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState('');
  const [selected, setSelected] = useState(null), [account, setAccount] = useState(null), [acquire, setAcquire] = useState(null), [convert, setConvert] = useState(null), [playing, setPlaying] = useState(null), [searchQuery, setSearchQuery] = useState('');
  const [searchState, setSearchState] = useState(emptyDiscovery), [recommendState, setRecommendState] = useState(emptyDiscovery);
  const [discoveryRevision, setDiscoveryRevision] = useState(0);
  const epoch = useRef(0), contentRef = useRef(null);
  useEffect(() => { contentRef.current?.scrollTo({ top: 0, left: 0 }); }, [page, filter, pageNumber, query, rootFilter]);
  const load = async (quiet = false) => {
    const version = ++epoch.current;
    if (!quiet) setLoading(true);
    try { const result = await library({ action: 'list', query, filter, page: pageNumber, root_id: rootFilter }); if (version === epoch.current) { setData(result); setError(''); } }
    catch (err) { if (version === epoch.current) setError(err.message); }
    finally { if (version === epoch.current) setLoading(false); }
  };
  const loadPlatforms = async () => { try { const r = await api('/api/console/platforms'); setPlatforms(r.items); setQualityMode(r.quality_mode || 'high'); setQualityPreferences(Object.fromEntries(r.items.map(p => [p.id, p.quality_preference || 'auto']))); setPlatformError(''); } catch (err) { setPlatformError(err.message); } };
  const s = useSettings(api, message, loadPlatforms);
  const isSettings = Object.hasOwn(settingPages, page);
  useEffect(() => { if (page === 'platforms' || (isSettings && !['service-status', 'about'].includes(page))) s.refresh(); }, [page]);
  useEffect(() => { load(); return () => { epoch.current++; }; }, [query, filter, pageNumber, rootFilter]);
  useEffect(() => { loadPlatforms(); }, []);
  const pending = data?.tasks?.some(j => ['running', 'queued'].includes(j.state));
  useEffect(() => { if (!pending) return; const timer = setInterval(() => load(true), 2500); return () => clearInterval(timer); }, [pending, query, filter, pageNumber, rootFilter]);
  useEffect(() => { const url = new URL(location.href); url.search = navigationParams(location.search, page, filter).toString(); history.replaceState(null, '', url); }, [page, filter]);
  const mutate = async (body, success) => { try { await library(body); if (success) message.success(success); await load(true); return true; } catch (err) { message.error(err.message); return false; } };
  const navigate = key => { setSelected(null); setPage(key === 'source-settings' ? 'platforms' : key === 'versions' ? 'library' : key); setFilter(key === 'versions' ? 'multi' : 'all'); setPageNumber(1); };
  const togglePlatform = async (p, value) => { if (s.dirty || s.saving) { message.info('请先保存或放弃设置修改'); return; } setBusy(p.id); try { await api(`/api/console/platforms/${p.id}`, { enabled: value }, 'PUT'); await loadPlatforms(); await s.refresh(); message.success(value ? '平台已启用' : '平台已停用'); } catch (err) { message.error(err.message); } finally { setBusy(''); } };

  const m = { contentRef, page, filter, setFilter: value => { setFilter(value); setPageNumber(1); }, query, setQuery, rootFilter, setRootFilter, pageNumber, setPageNumber, data, songs: data?.songs || [], roots: data?.roots || [], trash: data?.trash || [], jobs: data?.tasks || [], platforms, qualityMode, qualityPreferences, loading, busy, selected, setSelected, account, setAccount, acquire, setAcquire, convert, setConvert, playing, setPlaying, searchQuery, setSearchQuery, searchState, setSearchState, discoveryRevision, message, navigate, mutate, togglePlatform, loadPlatforms };
  const heading = settingPages[page] || headings[page] || headings.library;
  return <>
    <Layout className="app-layout"><Sider theme="light" width={224} collapsedWidth={72} collapsed={collapsed} breakpoint="lg" onCollapse={setCollapsed} className="sidebar"><div className="brand"><Text strong style={{ fontSize: 18 }}>{collapsed ? 'fn' : 'fnMusic'}</Text></div><div className="sidebar-nav"><Menu mode="inline" selectedKeys={[page]} onClick={({ key }) => navigate(key)} items={[{ type: 'group', label: '工作空间', children: pages }, { type: 'group', label: '整理', children: [{ key: 'trash', icon: <DeleteOutlined />, label: '回收站' }] }, { type: 'group', label: '设置', children: settingsMenu }]} /></div></Sider>
      <Layout className="main-layout"><Header className="app-header"><Flex justify="space-between" align="center" style={{ height: '100%' }}><Space size={18}><Button type="text" aria-label="收起或展开导航" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} /><Breadcrumb items={[{ title: 'fnMusic' }, { title: heading[0] }]} /></Space><Button type="text" icon={<ReloadOutlined />} onClick={() => { if (isSettings) { if (['service-status', 'about'].includes(page)) setSettingsRevision(value => value + 1); else s.refresh(); } else { load(); loadPlatforms(); if (page === 'platforms') s.refresh(); if (['search', 'recommendations'].includes(page)) setDiscoveryRevision(value => value + 1); } }}>刷新</Button></Flex></Header><Content ref={contentRef} className="page-content" role="main" aria-label={heading[0]} tabIndex={0}><div className="page-inner"><Flex justify="space-between" align="center" wrap gap={16} className="page-heading"><div><Title level={2}>{heading[0]}</Title><Text type="secondary">{heading[1]}</Text></div>{['library', 'directories'].includes(page) && <Button icon={<ReloadOutlined />} disabled={!m.roots.length || pending} onClick={() => mutate({ action: 'enqueue', kind: 'scan' }, '扫描任务已加入')}>扫描曲库</Button>}</Flex>
        {!isSettings && error && <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => load()}>重试</Button>} style={{ marginBottom: 20 }} />}{platformError && ['platforms', 'search', 'recommendations'].includes(page) && <Alert type="error" title={platformError} action={<Button onClick={loadPlatforms}>重试</Button>} style={{ marginBottom: 20 }} />}
        {isSettings ? <Settings key={page + settingsRevision} page={page} s={s} api={api} base={BASE} m={m} /> : page === 'library' ? <><Metrics m={m} /><Library m={m} /></> : page === 'trash' ? <Trash m={m} /> : page === 'platforms' ? <Platforms api={api} base={BASE} s={s} m={m} PlatformLogo={PlatformLogo} /> : page === 'search' ? <Discovery key="search" kind="search" state={searchState} setState={setSearchState} query={searchQuery} setQuery={setSearchQuery} m={m} api={api} Cover={Cover} PlatformLogo={PlatformLogo} /> : page === 'recommendations' ? <Discovery key="recommend" kind="recommend" state={recommendState} setState={setRecommendState} m={m} api={api} Cover={Cover} PlatformLogo={PlatformLogo} /> : page === 'tasks' ? <Tasks m={m} /> : <Directories m={m} />}
      </div></Content>
    <SaveSettings s={s} />
    {playing && <Card className="audio-player" size="small"><Flex align="center" gap={12} wrap><Text ellipsis className="playing-title">{playing.path.split('/').pop()}</Text><audio key={playing.id} autoPlay controls src={BASE + '/api/library/audio?id=' + encodeURIComponent(playing.id)} onError={() => message.error('无法播放此文件，请重新扫描曲库')} /><Button type="text" onClick={() => setPlaying(null)}>关闭</Button></Flex></Card>}
      </Layout></Layout><SongDrawer m={m} /><Account m={m} /><ProduceModal m={m} />
  </>;
}
createRoot(document.getElementById('app')).render(<ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#1677ff', borderRadius: 8, fontSize: 15, colorText: '#1f2329', colorTextSecondary: '#59636f', colorTextDescription: '#59636f', colorTextTertiary: '#687483', fontFamily: '-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif' } }}><App><Console /></App></ConfigProvider>);
