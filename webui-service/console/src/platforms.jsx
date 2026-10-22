import { useState } from 'react';
import { Alert, Badge, Button, Drawer, Empty, Flex, Select, Space, Spin, Switch, Table, Tabs, Typography } from 'antd';
import { QualitySettings } from './quality-settings.jsx';
import { optionNames } from './settings-fields.jsx';
import { channelPreference } from './quality-model.js';
import { NeteasePlaylistSettings, SourceSettings } from './source-settings.jsx';
const { Text } = Typography;
const qualityNames = { auto: '跟随默认', original: '实际音质', master: '母带优先', lossless: '无损优先', mp3_320: 'MP3 320k', mp3_128: 'MP3 128k', jymaster: '超清母带', hires: 'Hi-Res', exhigh: '320k 优先', higher: '192k 优先', standard: '128k 优先' };

export function Platforms({ api, base, s, m, PlatformLogo }) {
  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState(() => {
    const params = new URLSearchParams(location.search);
    return params.get('section') === 'sources' || params.get('page') === 'source-settings' ? 'sources' : 'accounts';
  });
  const platform = m.platforms.find(item => item.id === selected);
  const blocked = s.loading || s.saving || !!s.dirty || !!m.busy;
  const feedback = <>
    {s.error && <Alert type="error" title={s.error} showIcon action={<Button onClick={s.refresh}>重新连接</Button>} />}
    {s.report && <Alert type={s.report.error ? 'error' : s.report.warnings.length ? 'warning' : 'success'} title={s.report.error || (s.report.warnings.length ? '配置已保存，部分操作需要处理' : '设置已生效')} description={!s.report.error && s.report.warnings.map((warning, index) => <div key={index}>{warning}</div>)} showIcon closable onClose={s.dismissReport} />}
  </>;
  const settingsReady = Object.keys(s.schema).length > 0;
  const accountAction = p => p.auth?.logged_in ? '管理账号' : p.capabilities.login ? '登录' : '接入说明';
  const accountStatus = p => p.capabilities.login ? p.status : '无需登录';
  const columns = [
    { title: '平台', width: 230, render: (_, p) => <Space size={14}><PlatformLogo platform={p} size={40} /><Text strong>{p.name}</Text></Space> },
    { title: '账号状态', width: 165, render: (_, p) => <Badge status={p.auth?.logged_in ? 'success' : p.status === '登录已过期' ? 'warning' : 'default'} text={accountStatus(p)} /> },
    { title: '音质', width: 160, render: (_, p) => { const value = p.capabilities.qualities?.[0] === 'original' ? 'original' : channelPreference(p.id, { ...s.saved, ...s.changes }); return <Text type="secondary">{qualityNames[value] || value}</Text>; } },
    { title: '操作', width: 190, render: (_, p) => <Space size={12}><Button type="link" className="platform-row-action" disabled={s.saving} onClick={() => m.setAccount(p.id)}>{accountAction(p)}</Button><Button type="link" className="platform-row-action" aria-label={`${p.name}设置`} onClick={() => setSelected(p.id)}>设置</Button></Space> },
    { title: '启用', width: 90, align: 'right', render: (_, p) => <Switch checked={p.enabled} disabled={blocked} loading={m.busy === p.id} aria-label={`${p.enabled ? '停用' : '启用'}${p.name}`} onChange={value => m.togglePlatform(p, value)} /> },
  ];
  const qualitySpec = s.schema.FNMUSIC_QUALITY_MODE;
  const defaults = <div className="platform-default-quality"><Text type="secondary">默认音质</Text><Select aria-label="全局默认音质" value={settingsReady ? s.value('FNMUSIC_QUALITY_MODE') : undefined} loading={s.loading} disabled={!qualitySpec || s.loading || s.saving} options={(qualitySpec?.values || []).map(value => ({ value, label: optionNames[value] || value }))} onChange={value => s.set('FNMUSIC_QUALITY_MODE', value)} /></div>;
  return <div className="platform-page">
    {!platform && feedback}
    {s.dirty > 0 && <Alert type="info" title="设置修改待保存，保存或放弃后可切换平台。" className="platform-draft-note" />}
    <Tabs className="platform-tabs" activeKey={tab} onChange={key => { setTab(key); const url = new URL(location.href); if (key === 'sources') url.searchParams.set('section', 'sources'); else url.searchParams.delete('section'); history.replaceState(null, '', url); }} tabBarExtraContent={defaults} items={[
      { key: 'accounts', label: '常用平台', children: <Table className="platform-table" columns={columns} dataSource={m.platforms} rowKey="id" pagination={false} loading={!m.platforms.length && !m.platformError} scroll={{ x: 720 }} locale={{ emptyText: <Empty description="暂时没有可用平台" /> }} /> },
      { key: 'sources', label: '其他音源', children: settingsReady ? <SourceSettings api={api} base={base} s={s} /> : <Spin spinning={s.loading}><Empty description={s.error ? '设置暂不可用' : '正在读取设置'} /></Spin> },
    ]} />
    <Drawer title={platform && <Space><PlatformLogo platform={platform} size={28} />{platform.name}设置</Space>} open={!!platform} onClose={() => setSelected(null)} size={520} destroyOnHidden footer={s.dirty > 0 && <Flex justify="space-between" align="center" gap={12} wrap><Text>有 {s.dirty} 项设置待保存</Text><Space><Button disabled={s.saving} onClick={s.discard}>放弃修改</Button><Button type="primary" loading={s.saving} onClick={s.save}>保存设置</Button></Space></Flex>}>
      {platform && <div className="platform-details">
        {feedback}
        <section className="platform-detail-section"><Flex justify="space-between" align="center" gap={12} wrap><div><Text strong>账号</Text><div className="platform-account-status"><Badge status={platform.auth?.logged_in ? 'success' : 'default'} text={accountStatus(platform)} /></div></div><Button disabled={s.saving} onClick={() => m.setAccount(platform.id)}>{accountAction(platform)}</Button></Flex></section>
        {settingsReady && <><QualitySettings api={api} s={s} scope={platform.id} />{platform.id === 'netease' && <NeteasePlaylistSettings api={api} base={base} s={s} />}</>}
      </div>}
    </Drawer>
  </div>;
}
