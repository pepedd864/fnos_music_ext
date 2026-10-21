import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Descriptions, Empty, Flex, Form, Image, Input, List, Popconfirm, Select, Space, Switch, Tag, Typography, Upload } from 'antd';
import { FolderOpenOutlined, UploadOutlined } from '@ant-design/icons';
import { currentProvider, lxSources, neteaseCode, providerNames, selectProvider } from './settings-model.js';
import { SettingFields } from './settings-fields.jsx';
import { pickNas } from './nas.js';
const { Text } = Typography;
export async function withPreview(api, provider, operation) {
  try { return await operation(); }
  catch (error) {
    if (![502, 503, 504].includes(error.status)) throw error;
    await api('/api/preview', { provider });
    return operation();
  }
}
function NeteaseAccount({ api, base, s }) {
  const [account, setAccount] = useState(null), [qr, setQr] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const refresh = async () => {
    const version = epoch.current;
    try { const result = await api('/api/netease/auth/status'); if (version === epoch.current) setAccount(result.data || result); }
    catch { if (version === epoch.current) setAccount({ logged_in: false, unavailable: true }); }
  };
  useEffect(() => { refresh(); return () => { epoch.current++; }; }, []);
  useEffect(() => {
    if (!qr) return;
    let stopped = false, timer;
    const deadline = Date.now() + 180000;
    const poll = async () => {
      if (stopped) return;
      if (Date.now() >= deadline) { setNote('二维码已过期，请重新生成'); setQr(''); return; }
      try {
        const code = neteaseCode(await api('/api/netease/auth/login/check?unikey=' + encodeURIComponent(qr)));
        if (stopped) return;
        if (code === 803) { setNote('登录成功'); setQr(''); refresh(); return; }
        if (code === 800) { setNote('二维码已过期，请重新生成'); setQr(''); return; }
        setNote(code === 802 ? '已扫码，请在手机上确认' : '等待扫码');
      } catch (error) { if (!stopped) setNote(error.message); }
      if (!stopped) timer = setTimeout(poll, 2400);
    };
    timer = setTimeout(poll, 2200);
    return () => { stopped = true; clearTimeout(timer); };
  }, [qr]);
  const login = async () => {
    const version = ++epoch.current; setBusy(true); setQr(''); setNote('正在生成二维码');
    try {
      const result = await withPreview(api, 'musicbox', () => api('/api/netease/auth/login', {}));
      if (version !== epoch.current) return;
      const data = result.data || result, key = result.unikey || result.codekey || data.unikey || data.codekey;
      if (!key) throw new Error('未获取到登录二维码');
      setQr(key); setNote('请用网易云音乐 App 扫码');
    } catch (error) { if (version === epoch.current) setNote(error.message); }
    finally { if (version === epoch.current) setBusy(false); }
  };
  return <Card title="网易云音乐账号"><Space direction="vertical" size={20} style={{ width: '100%' }}><Flex gap={12} align="center" wrap><Badge status={account?.logged_in ? 'success' : 'default'} text={account?.logged_in ? '已登录 · ' + (account.nickname || account.user_id || '网易账号') : account?.unavailable ? '服务未连接' : '待登录'} /><Button onClick={login} loading={busy}>扫码登录</Button><Button onClick={refresh}>刷新账号状态</Button></Flex>
    {qr && <Image preview={false} width={200} src={base + '/api/netease/qr?unikey=' + encodeURIComponent(qr)} alt="网易云音乐登录二维码" />}{note && <Text role="status">{note}</Text>}
    <SettingFields api={api} base={base} s={s} keys={['FNMUSIC_NETEASE_MY_PLAYLISTS', 'FNMUSIC_NETEASE_PLAYLIST_RESIDENT']} />
    <Text type="secondary">账号歌单需要登录。常驻开启后，切换音源仍可使用已选的网易歌单。</Text></Space></Card>;
}
function MusicdlSources({ api, s, m }) {
  const [registered, setRegistered] = useState([]), [fallback, setFallback] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(true);
  const load = async (preview = false) => {
    setBusy(true); setError('');
    try { const run = () => api('/api/platforms'); const data = await (preview ? withPreview(api, 'musicdl', run) : run()); if (active.current) { setRegistered(data.registered || []); setFallback(data.enabled || []); } }
    catch (error) { if (active.current) setError(error.message); }
    finally { if (active.current) setBusy(false); }
  };
  useEffect(() => { load(); return () => { active.current = false; }; }, []);
  const raw = Object.hasOwn(s.changes, 'FNMUSIC_ONLINE_SOURCES') ? s.changes.FNMUSIC_ONLINE_SOURCES : s.value('FNMUSIC_ONLINE_SOURCES') || s.value('MUSICDL_SOURCES') || fallback.join(',');
  const selected = raw.split(',').map(value => value.trim()).filter(Boolean);
  return <Card title="其他 musicdl 平台" extra={<Button onClick={() => load(true)} loading={busy}>刷新可用平台</Button>}><Space direction="vertical" size={16} style={{ width: '100%' }}><Text type="secondary">QQ、酷狗和酷我账号在音乐平台页管理。</Text><Button onClick={() => m.navigate('platforms')}>打开音乐平台</Button>{error && <Alert type="warning" title={error} showIcon />}<Select aria-label="其他 musicdl 平台" mode="multiple" showSearch value={selected} options={[...new Set([...registered, ...selected])].map(value => ({ value, label: value }))} onChange={values => s.patch({ FNMUSIC_ONLINE_SOURCES: values.join(','), MUSICDL_SOURCES: values.join(',') })} placeholder="选择要启用的平台" style={{ width: '100%' }} /></Space></Card>;
}
function LxSources({ api, base, s }) {
  const items = lxSources({ ...s.saved, ...s.changes });
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [busy, setBusy] = useState(''), [report, setReport] = useState(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const update = next => s.patch({ LX_SOURCE_LIST: JSON.stringify(next), LX_SOURCE_URL: next.find(item => item.active)?.url || '' });
  const run = async (kind, operation) => {
    setBusy(kind); setReport(null);
    try { const result = await operation(); if (live.current) return result; }
    catch (error) { if (live.current) setReport({ error: error.message }); }
    finally { if (live.current) setBusy(''); }
  };
  const upload = async (filename, script) => {
    if (!filename.toLowerCase().endsWith('.js') || new TextEncoder().encode(script).length > 9000000) throw new Error('请选择不超过 9 MB 的 JS 脚本');
    const result = await withPreview(api, 'lxmusic', () => api('/api/lx/upload', { filename, script }));
    const data = result.data || result;
    if (live.current) { setUrl(data.url || ''); if (data.meta?.name) setName(data.meta.name); setReport({ note: '脚本已上传，可测试后加入列表。' }); }
  };
  const verify = () => run('verify', async () => {
    const result = await withPreview(api, 'lxmusic', () => api('/api/lx/verify', { values: { url } }));
    const data = result.data || result;
    setReport({ note: '测试通过', data });
    if (!name && data.meta?.name) setName(data.meta.name);
  });
  return <Card title="洛雪自定义源"><Space direction="vertical" size={20} style={{ width: '100%' }}><Form layout="vertical" disabled={s.saving || !!busy}><Form.Item label="名称"><Input aria-label="洛雪源名称" value={name} onChange={e => setName(e.target.value)} placeholder="可选，留空使用脚本名称" /></Form.Item><Form.Item label="脚本地址"><Input aria-label="洛雪脚本地址" value={url} onChange={e => { setUrl(e.target.value); setReport(null); }} placeholder="https://… 或已上传的 file:// 地址" /></Form.Item>
    <Flex gap={8} wrap><Upload accept=".js" showUploadList={false} beforeUpload={async file => { if (file.size > 9000000) { setReport({ error: '脚本超过 9 MB' }); return false; } await run('upload', async () => upload(file.name, await file.text())); return false; }}><Button icon={<UploadOutlined />} loading={busy === 'upload'}>上传脚本</Button></Upload><Button icon={<FolderOpenOutlined />} onClick={() => run('pick', async () => { const path = await pickNas(base, { directory: false, accept: ['.js'], title: '选择洛雪源脚本' }); if (path) { const result = await api('/api/host-file', { path }); await upload(path.split('/').pop(), result.script); } })} loading={busy === 'pick'}>从 NAS 选择</Button><Button disabled={!url.trim()} loading={busy === 'verify'} onClick={verify}>测试脚本</Button><Button disabled={!url.trim()} onClick={() => { if (!/^(https?:|file:)\/\//i.test(url.trim())) { setReport({ error: '请填写有效的脚本地址' }); return; } const next = items.filter(item => item.url !== url.trim()); const previous = items.find(item => item.url === url.trim()); update([...next, { ...previous, name: name.trim() || url.split('/').pop() || '洛雪源', url: url.trim(), active: previous?.active || false }]); setName(''); setUrl(''); setReport(null); }}>加入列表</Button></Flex></Form>
    {report && <Alert type={report.error ? 'error' : 'success'} title={report.error || report.note} description={report.data && <Descriptions column={1} size="small" items={[{ key: 'name', label: '名称', children: report.data.meta?.name || '—' }, { key: 'platforms', label: '可用平台', children: report.data.platforms?.join('、') || '—' }, { key: 'sample', label: '实测歌曲', children: report.data.probe?.song || '—' }]} />} showIcon />}
    <List dataSource={items} locale={{ emptyText: <Empty description="还没有添加洛雪源" /> }} renderItem={(item, index) => <List.Item actions={[<Switch key="active" aria-label={'启用洛雪源 ' + item.name} checked={!!item.active} disabled={s.saving} onChange={active => update(items.map((entry, i) => i === index ? { ...entry, active } : entry))} />, <Popconfirm key="remove" title="从配置列表移除此源？" onConfirm={() => update(items.filter((_, i) => i !== index))}><Button danger type="text" disabled={s.saving}>移除</Button></Popconfirm>]}><List.Item.Meta title={item.name || '洛雪源'} description={<Text className="file-path" copyable>{item.url}</Text>} /></List.Item>} />
    <Text type="secondary">新启用的脚本在保存时校验，失败项会自动取消启用，其余设置继续保存。</Text><SettingFields api={api} base={base} s={s} keys={['LX_SOURCES']} />
  </Space></Card>;
}
export function SourceSettings({ api, base, s, m }) {
  const provider = currentProvider({ ...s.saved, ...s.changes });
  return <Space direction="vertical" size={20} style={{ width: '100%' }}><Card title="运行音源"><Space direction="vertical" size={16} style={{ width: '100%' }}><Select aria-label="运行音源" value={provider} options={[{ value: '', label: '暂不启用在线音源' }, ...Object.entries(providerNames).map(([value, label]) => ({ value, label }))]} onChange={value => s.patch(selectProvider(value))} style={{ width: '100%', maxWidth: 380 }} disabled={s.saving} /><Text type="secondary">保存后切换运行音源。已有账号凭据会保留。</Text></Space></Card>
    {provider === 'musicdl' && <MusicdlSources api={api} s={s} m={m} />}{provider === 'musicbox' && <NeteaseAccount api={api} base={base} s={s} />}{provider === 'lxmusic' && <LxSources api={api} base={base} s={s} />}
  </Space>;
}
