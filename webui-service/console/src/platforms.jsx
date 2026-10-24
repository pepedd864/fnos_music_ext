import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Drawer, Empty, Flex, Input, Modal, Select, Space, Spin, Switch, Table, Tag, Typography } from 'antd';
import { LinkOutlined, PlusOutlined } from '@ant-design/icons';
import { ChannelQuality, useQualityChannels } from './quality-settings.jsx';
import { optionNames } from './settings-fields.jsx';
import { additionalPlatforms, mergeAdditionalPlatforms } from './settings-model.js';
import { clientName, clientPlatform, patchAggregatePlatform, patchLxPlatform, platformRows, platformStatus } from './platform-model.js';
import { ConnectionSettings, NeteasePlaylistSettings } from './source-settings.jsx';
const { Text } = Typography;

export function Platforms({ api, base, s, m, PlatformLogo }) {
  const [selected, setSelected] = useState(null), [query, setQuery] = useState(''), [onlyEnabled, setOnlyEnabled] = useState(false);
  const [connections, setConnections] = useState(() => { const params = new URLSearchParams(location.search); return params.get('section') === 'sources' || params.get('page') === 'source-settings'; });
  const [adding, setAdding] = useState(false), [registered, setRegistered] = useState([]), [extra, setExtra] = useState([]), [catalogError, setCatalogError] = useState(''), [catalogBusy, setCatalogBusy] = useState(false);
  const quality = useQualityChannels(api, s.saved), values = { ...s.saved, ...s.changes };
  const rows = platformRows(m.platforms, quality.channels, values), platform = rows.find(item => item.id === selected);
  const settingsReady = Object.keys(s.schema).length > 0;
  const blocked = s.loading || s.saving || !!m.busy;
  useEffect(() => { const url = new URL(location.href); if (connections) url.searchParams.set('section', 'sources'); else url.searchParams.delete('section'); history.replaceState(null, '', url); }, [connections]);
  const feedback = <>
    {s.error && <Alert type="error" title={s.error} showIcon action={<Button onClick={s.refresh}>重新连接</Button>} />}
    {s.report && <Alert type={s.report.error ? 'error' : s.report.warnings.length ? 'warning' : 'success'} title={s.report.error || (s.report.warnings.length ? '配置已保存，部分操作需要处理' : '设置已生效')} description={!s.report.error && s.report.warnings.map((warning, index) => <div key={index}>{warning}</div>)} showIcon closable onClose={s.dismissReport} />}
  </>;
  const footer = s.dirty > 0 && <Flex justify="space-between" align="center" gap={12} wrap><Text>有 {s.dirty} 项设置待保存</Text><Space><Button disabled={s.saving} onClick={s.discard}>放弃修改</Button><Button type="primary" loading={s.saving} onClick={s.save}>保存设置</Button></Space></Flex>;
  const open = id => { if (s.dirty && id !== selected) { s.notify('请先保存或放弃当前设置'); return; } setSelected(id); };
  const manageConnections = () => { if (s.dirty) { s.notify('请先保存或放弃当前设置'); return; } setSelected(null); setConnections(true); };
  const patch = operation => { try { s.patch(operation()); } catch (error) { m.message.error(error.message); } };
  const addPlatforms = async () => {
    if (s.dirty) { s.notify('请先保存或放弃当前设置'); return; }
    setExtra(additionalPlatforms(values.FNMUSIC_ONLINE_SOURCES || values.MUSICDL_SOURCES)); setAdding(true); setCatalogBusy(true); setCatalogError('');
    try { const data = await api('/api/platforms'); setRegistered(additionalPlatforms(data.registered?.join(','))); }
    catch (error) { setCatalogError(error.message); }
    finally { setCatalogBusy(false); }
  };
  const columns = [
    { title: '平台', width: 260, render: (_, row) => <Space size={14}><PlatformLogo platform={row} size={40} /><Text strong>{row.name}</Text></Space> },
    { title: '接入方式', render: (_, row) => <Flex gap={8} wrap>{row.routes.map(route => <Tag key={route.id} color={route.enabled ? 'blue' : undefined}>{route.name}</Tag>)}</Flex> },
    { title: '状态', width: 165, render: (_, row) => <Badge {...platformStatus(row)} /> },
    { title: '', width: 95, align: 'right', render: (_, row) => <Button type="link" className="platform-row-action" aria-label={`管理${row.name}`} onClick={() => open(row.id)}>管理</Button> },
  ];
  const qualitySpec = s.schema.FNMUSIC_QUALITY_MODE;
  return <div className="platform-page">
    {!platform && !connections && feedback}
    {s.dirty > 0 && <Alert type="info" title="有设置修改待保存。" className="platform-draft-note" />}
    <Flex justify="space-between" align="center" gap={16} wrap className="platform-toolbar">
      <Space size={12} wrap><Input.Search aria-label="搜索平台" placeholder="搜索平台" allowClear value={query} onChange={event => setQuery(event.target.value)} className="platform-search" /><Select aria-label="平台筛选" value={onlyEnabled} onChange={setOnlyEnabled} options={[{ value: false, label: '全部平台' }, { value: true, label: '已启用' }]} style={{ width: 116 }} /></Space>
      <Flex gap={20} align="center" wrap><div className="platform-default-quality"><Text type="secondary">默认音质</Text><Select aria-label="全局默认音质" value={settingsReady ? s.value('FNMUSIC_QUALITY_MODE') : undefined} loading={s.loading} disabled={!qualitySpec || blocked} options={(qualitySpec?.values || []).map(value => ({ value, label: optionNames[value] || value }))} onChange={value => s.set('FNMUSIC_QUALITY_MODE', value)} /></div><Space><Button icon={<PlusOutlined />} disabled={blocked || !settingsReady} onClick={addPlatforms}>添加平台</Button><Button icon={<LinkOutlined />} disabled={blocked || !settingsReady} onClick={manageConnections}>接入管理</Button></Space></Flex>
    </Flex>
    <Table className="platform-table" columns={columns} dataSource={rows.filter(row => (!onlyEnabled || row.enabled) && (row.name + ' ' + row.id).toLowerCase().includes(query.trim().toLowerCase()))} rowKey="id" pagination={false} loading={!m.platforms.length && !m.platformError} scroll={{ x: 650 }} locale={{ emptyText: <Empty description="没有匹配的平台" /> }} onRow={row => ({ tabIndex: 0, 'aria-label': `管理${row.name}的接入`, 'aria-haspopup': 'dialog', onClick: event => { if (!event.target.closest('button,a,input,[role="button"]') && window.getSelection()?.isCollapsed !== false) open(row.id); }, onKeyDown: event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); open(row.id); } } })} />
    <Drawer title={platform && <Space><PlatformLogo platform={platform} size={28} />{platform.name}</Space>} open={!!platform} onClose={() => setSelected(null)} size={560} destroyOnHidden footer={footer}>
      {platform && <div className="platform-details">{feedback}{quality.feedback}<Spin spinning={s.loading || quality.loading}><Space direction="vertical" size={20} className="settings-stack">
        {platform.routes.map(route => <Card key={route.id} size="small" className="platform-connection-card" title={route.name} extra={route.kind === 'aggregate' && platform.id !== 'migu' ? <Button type="text" danger disabled={blocked} onClick={() => patch(() => patchAggregatePlatform(values, route.client, false))}>移除此接入</Button> : <Switch aria-label={`${platform.name}${route.name}`} checked={route.serviceEnabled && route.selected} disabled={blocked || !route.serviceEnabled || !settingsReady || (route.kind === 'account' && !!s.dirty)} loading={m.busy === platform.id} onChange={enabled => route.kind === 'account' ? m.togglePlatform(route.platform, enabled) : patch(() => route.kind === 'lx' ? patchLxPlatform(values, route.source, enabled) : patchAggregatePlatform(values, route.client, enabled))} />}>
          <Space direction="vertical" size={18} className="settings-stack">
            {!route.serviceEnabled && <Flex justify="space-between" align="center" gap={12}><Text type="secondary">{route.kind === 'lx' ? '洛雪接入尚未启用' : '平台直连尚未启用'}</Text><Button type="link" onClick={manageConnections}>设置接入</Button></Flex>}
            {route.kind === 'account' && <Flex justify="space-between" align="center" gap={12}><Badge status={route.platform.auth?.logged_in ? 'success' : route.platform.status === '登录已过期' ? 'warning' : 'default'} text={route.platform.capabilities.login ? route.platform.status : '无需登录'} />{route.platform.capabilities.login && <Button disabled={s.saving} onClick={() => m.setAccount(platform.id)}>{route.platform.auth?.logged_in ? '管理账号' : '登录'}</Button>}</Flex>}
            <ChannelQuality channel={route.channel} s={s} />
          </Space>
        </Card>)}
        {settingsReady && platform.id === 'netease' && <NeteasePlaylistSettings api={api} base={base} s={s} />}
      </Space></Spin></div>}
    </Drawer>
    <Drawer title="接入管理" open={connections} onClose={() => setConnections(false)} size={600} destroyOnHidden footer={footer}><div className="platform-details">{feedback}{settingsReady ? <ConnectionSettings api={api} base={base} s={s} /> : <Spin spinning={s.loading}><Empty description="正在读取设置" /></Spin>}</div></Drawer>
    <Modal title="添加平台" open={adding} onCancel={() => setAdding(false)} okText="应用到列表" okButtonProps={{ disabled: catalogBusy || !!catalogError }} onOk={() => { const merged = mergeAdditionalPlatforms(values.FNMUSIC_ONLINE_SOURCES || values.MUSICDL_SOURCES, extra); s.patch({ FNMUSIC_ONLINE_SOURCES: merged, MUSICDL_SOURCES: merged }); setAdding(false); }}>
      <Space direction="vertical" size={16} className="settings-stack">{catalogError && <Alert type="error" title={catalogError} showIcon action={<Button onClick={addPlatforms}>重试</Button>} />}<Select aria-label="选择添加的平台" mode="multiple" showSearch optionFilterProp="label" loading={catalogBusy} value={extra} onChange={setExtra} options={[...new Set([...registered, ...extra])].map(client => ({ value: client, label: clientName(client) }))} optionRender={option => <Space size={10}><PlatformLogo platform={{ id: clientPlatform(option.data.value), name: option.data.label }} size={24} />{option.data.label}</Space>} placeholder="搜索并选择平台" style={{ width: '100%' }} /><Text type="secondary">添加后保存设置。账号接入和洛雪接入仍在各平台详情中管理。</Text></Space>
    </Modal>
  </div>;
}
