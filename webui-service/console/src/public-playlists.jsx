import { useEffect, useRef, useState } from 'react';
import { Alert, Avatar, Button, Card, Checkbox, Flex, List, Select, Space, Switch, Tag, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, SoundOutlined } from '@ant-design/icons';
import { currentProvider, parseArray, publicEntryKey, publicSelection } from './settings-model.js';
import { withPreview } from './source-settings.jsx';
const { Text } = Typography;
const sourceNames = { netease: '网易', wy: '网易', kw: '酷我', kg: '酷狗', tx: 'QQ', mg: '咪咕' };
const neteaseDefaults = ['3778678', '3779629', '19723756', '2884035'].map(id => ({ provider: 'musicbox', source: 'netease', kind: 'chart', id }));
const channels = { musicbox: [['charts', '排行榜'], ['recommend', '推荐歌单'], ['top', '热门与分类'], ['highquality', '精品歌单'], ['account_recommend', '账号推荐歌单']], lxmusic: [['top', '热门与分类'], ['charts', '排行榜']] };

export function PublicPlaylists({ api, s }) {
  const enabled = s.value('FNMUSIC_PUBLIC_PLAYLISTS_ENABLED');
  const selected = parseArray(s.value('FNMUSIC_PUBLIC_PLAYLISTS_SELECTION'));
  const initial = currentProvider({ ...s.saved, ...s.changes }) === 'lxmusic' ? 'lxmusic' : 'musicbox';
  const [provider, setProvider] = useState(initial), [source, setSource] = useState(initial === 'musicbox' ? 'netease' : ''), [channel, setChannel] = useState(initial === 'musicbox' ? 'charts' : 'top');
  const [capRevision, setCapRevision] = useState(0), [opened, setOpened] = useState(false), [cap, setCap] = useState(null), [categories, setCategories] = useState([]), [sorts, setSorts] = useState([]), [category, setCategory] = useState(''), [sort, setSort] = useState('');
  const [items, setItems] = useState([]), [page, setPage] = useState(1), [hasMore, setHasMore] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [metadata, setMetadata] = useState({});
  const generation = useRef(0), browseGeneration = useRef(0), defaultsGeneration = useRef(0), cursors = useRef({ 1: '' });
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const request = (target, params = {}, engine = provider) => withPreview(api, engine, () => api('/api/public-playlists' + (target ? '/' + target : '') + '?' + new URLSearchParams({ provider: engine, ...params })));
  const changeSelection = next => { defaultsGeneration.current++; s.set('FNMUSIC_PUBLIC_PLAYLISTS_SELECTION', JSON.stringify(publicSelection(next))); };
  const resetPage = () => { cursors.current = { 1: '' }; setPage(1); };
  useEffect(() => () => { generation.current++; browseGeneration.current++; defaultsGeneration.current++; }, []);
  useEffect(() => {
    if (!opened || !enabled) return;
    let alive = true;
    setCap(null); setError(''); setItems([]);
    request('capabilities').then(result => { if (alive) { setCap(result); const sources = (result.sources || []).filter(item => provider !== 'lxmusic' || item.playback_available); setSource(previous => sources.some(item => item.id === previous) ? previous : sources[0]?.id || ''); } }).catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [opened, enabled, provider, capRevision]);
  const logged = Boolean(cap?.sources?.find(item => item.id === 'netease')?.logged_in);
  useEffect(() => { if (cap && channel === 'account_recommend' && !logged) { setChannel('charts'); resetPage(); } }, [cap, logged, channel]);
  useEffect(() => {
    const version = ++browseGeneration.current;
    generation.current++; setItems([]); setHasMore(false); setBusy(false); setCategories([]); setSorts([]); setCategory(''); setSort(''); resetPage();
    if (!opened || !enabled || !cap || !source) return;
    const load = async () => {
      setBusy(true); setError('');
      try {
        if (!['recommend', 'account_recommend'].includes(channel)) {
          const data = await request('categories', { source, kind: channel === 'charts' ? 'chart' : 'playlist' });
          if (version !== browseGeneration.current) return;
          const groups = channel === 'highquality' ? data.highquality_tags || data.tags || [] : data.categories || [];
          setCategories(groups); setSorts(data.sorts || []); setSort(data.sorts?.[0]?.id || '');
        }
      } catch (error) { if (version === browseGeneration.current) setError('分类加载失败：' + error.message); }
      finally { if (version === browseGeneration.current) setBusy(false); }
    };
    load();
    return () => { browseGeneration.current++; };
  }, [opened, enabled, cap, source, channel]);
  const browse = async (nextPage = 1) => {
    const version = ++generation.current;
    setBusy(true); setError('');
    try {
      const data = await request('', { source, channel, category, sort, page: nextPage, ...(channel === 'highquality' ? { cursor: cursors.current[nextPage] || '' } : {}) });
      if (version !== generation.current) return;
      const rows = (data.items || []).map(item => ({ ...item, provider: provider === 'musicbox' ? 'musicbox' : 'lx', source, kind: channel === 'charts' ? 'chart' : 'playlist', id: String(item.id) }));
      setItems(rows); setPage(nextPage); setHasMore(Boolean(data.has_more)); cursors.current[nextPage + 1] = data.next_cursor || '';
      setMetadata(previous => ({ ...previous, ...Object.fromEntries(rows.map(item => [publicEntryKey(item), item])) }));
    } catch (error) { if (version === generation.current) { setError(error.message); setItems([]); setHasMore(false); } }
    finally { if (version === generation.current) setBusy(false); }
  };
  const loadSelected = async () => {
    const version = ++generation.current;
    setBusy(true); setError('');
    const errors = [];
    for (const item of selected) {
      try {
        const data = await request(encodeURIComponent(item.id), { source: item.source, kind: item.kind }, item.provider === 'lx' ? 'lxmusic' : 'musicbox');
        if (version !== generation.current) return;
        setMetadata(previous => ({ ...previous, [publicEntryKey(item)]: data.data || data }));
      } catch (error) { errors.push(item.id + '：' + error.message); }
    }
    if (version === generation.current) { setError(errors.join('；')); setBusy(false); }
  };
  const toggle = async value => {
    const version = ++defaultsGeneration.current;
    s.set('FNMUSIC_PUBLIC_PLAYLISTS_ENABLED', value);
    if (!value) { generation.current++; browseGeneration.current++; setBusy(false); return; }
    setOpened(true);
    if (s.presence.FNMUSIC_PUBLIC_PLAYLISTS_SELECTION || Object.hasOwn(s.changes, 'FNMUSIC_PUBLIC_PLAYLISTS_SELECTION')) return;
    if (initial !== 'lxmusic') { changeSelection(neteaseDefaults); return; }
    setBusy(true);
    try {
      const capabilities = await request('capabilities', {}, 'lxmusic'), defaults = [];
      for (const [id, name] of [['kg', 'TOP500'], ['kw', '飙升榜'], ['wy', '新歌榜']]) {
        if (!capabilities.sources?.some(item => item.id === id && item.playback_available)) continue;
        const data = await request('', { source: id, channel: 'charts' }, 'lxmusic');
        const row = data.items?.find(item => String(item.name || '').includes(name));
        if (row) defaults.push({ ...row, provider: 'lx', source: id, kind: 'chart', id: String(row.id) });
      }
      if (version === defaultsGeneration.current) { setBusy(false); changeSelection(defaults); }
    } catch (error) { if (version === defaultsGeneration.current) { setError(error.message); setBusy(false); } }
  };
  const choose = (item, checked) => {
    const latest = selectedRef.current;
    if (checked && latest.some(entry => publicEntryKey(entry) === publicEntryKey(item))) return;
    if (checked && latest.length >= 50) { s.notify('公共歌单最多选择 50 份'); return; }
    changeSelection(checked ? [...latest, item] : latest.filter(entry => publicEntryKey(entry) !== publicEntryKey(item)));
  };
  const move = (index, delta) => { const next = [...selected]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; changeSelection(next); };
  const sourceOptions = (cap?.sources || []).filter(item => provider !== 'lxmusic' || item.playback_available);
  return <Card title="公共歌单" extra={<Switch aria-label="启用公共歌单" checked={enabled} onChange={toggle} disabled={s.saving} />}><Space direction="vertical" size={20} className="settings-stack">
    <Flex justify="space-between" align="center" gap={12} wrap><Text>已选 {selected.length} / 50 份</Text><Space wrap><Button disabled={!selected.length || busy} onClick={loadSelected}>加载歌单名称</Button><Button disabled={!enabled} onClick={() => setOpened(!opened)}>{opened ? '收起浏览' : '浏览歌单'}</Button></Space></Flex>
    {error && <Alert type="warning" title={error} showIcon action={enabled && opened && <Button onClick={() => setCapRevision(value => value + 1)} disabled={busy}>重新连接</Button>} />}
    <List dataSource={selected} locale={{ emptyText: '尚未选择歌单' }} renderItem={(entry, index) => {
      const item = metadata[publicEntryKey(entry)] || entry;
      return <List.Item actions={[<Button key="up" aria-label={'上移歌单 ' + entry.id} icon={<ArrowUpOutlined />} disabled={index === 0 || s.saving} onClick={() => move(index, -1)} />, <Button key="down" aria-label={'下移歌单 ' + entry.id} icon={<ArrowDownOutlined />} disabled={index === selected.length - 1 || s.saving} onClick={() => move(index, 1)} />, <Button key="remove" aria-label={'移除歌单 ' + entry.id} icon={<DeleteOutlined />} danger disabled={s.saving} onClick={() => choose(entry, false)} />]}><List.Item.Meta avatar={<Avatar shape="square" src={item.cover_url} icon={<SoundOutlined />} />} title={item.name || entry.id} description={<Space wrap><Text type="secondary">{sourceNames[entry.source] || entry.source} · {entry.kind === 'chart' ? '榜单' : '歌单'} · {entry.id}</Text>{item.track_count > 1000 && <Tag>仅载入前 1,000 首</Tag>}</Space>} /></List.Item>;
    }} />
    {enabled && opened && <div className="public-browser"><Flex gap={10} wrap><Select disabled={busy || s.saving} aria-label="歌单来源" value={provider} onChange={value => { generation.current++; setProvider(value); setCap(null); setSource(''); setChannel(value === 'musicbox' ? 'charts' : 'top'); }} options={[{ value: 'musicbox', label: '网易云音乐' }, { value: 'lxmusic', label: '洛雪内置歌单' }]} />{provider === 'lxmusic' && <Select disabled={busy || s.saving} aria-label="歌单平台" value={source || undefined} onChange={setSource} options={sourceOptions.map(item => ({ value: item.id, label: item.name }))} style={{ minWidth: 140 }} />}<Select disabled={busy || s.saving} aria-label="歌单频道" value={channel} onChange={setChannel} options={channels[provider].filter(([id]) => id !== 'account_recommend' || logged).map(([value, label]) => ({ value, label }))} style={{ minWidth: 150 }} />
      {!!categories.length && <Select disabled={busy || s.saving} aria-label="歌单分类" value={category} onChange={value => { generation.current++; setCategory(value); resetPage(); setItems([]); }} options={[{ value: '', label: '全部分类' }, ...categories.flatMap(group => (group.list || [group]).map(item => ({ value: String(item.id ?? item.name ?? ''), label: item.name || String(item.id) })))]} style={{ minWidth: 160 }} />}
      {!!sorts.length && <Select disabled={busy || s.saving} aria-label="歌单排序" value={sort} onChange={value => { generation.current++; setSort(value); resetPage(); setItems([]); }} options={sorts.map(item => ({ value: item.id, label: item.name || item.id }))} />}<Button type="primary" onClick={() => browse(1)} loading={busy} disabled={!cap || !source}>获取歌单</Button></Flex>
      <List loading={busy} dataSource={items} locale={{ emptyText: !cap ? '连接音源后可浏览歌单' : '选择频道后点击获取歌单' }} renderItem={item => <List.Item><Checkbox aria-label={'选择歌单 ' + item.name} checked={selected.some(entry => publicEntryKey(entry) === publicEntryKey(item))} disabled={s.saving} onChange={event => choose(item, event.target.checked)}><Space><Avatar shape="square" src={item.cover_url} icon={<SoundOutlined />} /><Space direction="vertical" size={0}><Text>{item.name || item.id}</Text><Text type="secondary">{item.author || sourceNames[item.source]} · {item.track_count || 0} 首</Text></Space></Space></Checkbox></List.Item>} /><Flex justify="space-between" align="center"><Button disabled={page <= 1 || busy} onClick={() => browse(page - 1)}>上一页</Button><Text>第 {page} 页</Text><Button disabled={!hasMore || busy} onClick={() => browse(page + 1)}>下一页</Button></Flex>
    </div>}
  </Space></Card>;
}
