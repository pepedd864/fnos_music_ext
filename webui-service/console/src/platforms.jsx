import { useState } from 'react';
import { Alert, Badge, Button, Card, Col, Collapse, Drawer, Empty, Flex, Row, Space, Spin, Switch, Tag, Typography } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { QualitySettings } from './quality-settings.jsx';
import { SettingFields } from './settings-fields.jsx';
import { NeteasePlaylistSettings, SourceSettings } from './source-settings.jsx';
const { Text } = Typography;

export function Platforms({ api, base, s, m, PlatformLogo }) {
  const [selected, setSelected] = useState(null);
  const [expanded, setExpanded] = useState(() => {
    const params = new URLSearchParams(location.search);
    return params.get('section') === 'sources' || params.get('page') === 'source-settings' ? ['sources'] : [];
  });
  const platform = m.platforms.find(item => item.id === selected);
  const blocked = s.loading || s.saving || !!s.dirty || !!m.busy;
  const feedback = <>
    {s.error && <Alert type="error" title={s.error} showIcon action={<Button onClick={s.refresh}>重新连接</Button>} />}
    {s.report && <Alert type={s.report.error ? 'error' : s.report.warnings.length ? 'warning' : 'success'} title={s.report.error || (s.report.warnings.length ? '配置已保存，部分操作需要处理' : '设置已生效')} description={!s.report.error && s.report.warnings.map((warning, index) => <div key={index}>{warning}</div>)} showIcon closable onClose={s.dismissReport} />}
  </>;
  const settingsReady = Object.keys(s.schema).length > 0;
  return <Space direction="vertical" size={24} style={{ width: '100%' }}>
    {!platform && feedback}
    {s.dirty > 0 && <Text type="secondary">请先保存或放弃设置修改，再切换平台启用状态。</Text>}
    <Row gutter={[20, 20]}>{m.platforms.map(p => <Col xs={24} md={12} xxl={6} key={p.id}><Card className="platform-card" title={<Space size={12}><PlatformLogo platform={p} /><Text strong>{p.name}</Text></Space>} extra={<Switch checked={p.enabled} disabled={blocked} loading={m.busy === p.id} aria-label={`${p.enabled ? '停用' : '启用'}${p.name}`} onChange={value => m.togglePlatform(p, value)} />} actions={[
      <Button key="account" type="text" disabled={s.saving} onClick={() => m.setAccount(p.id)}>{p.auth?.logged_in ? '管理账号' : p.capabilities.login ? '登录' : '接入说明'}</Button>,
      <Button key="settings" type="text" aria-label={`${p.name}设置`} icon={<SettingOutlined />} onClick={() => setSelected(p.id)}>设置</Button>,
    ]}><Flex gap={12} wrap align="center"><Badge status={p.auth?.logged_in ? 'success' : p.status === '登录已过期' ? 'warning' : 'default'} text={p.status} /><Tag color={p.enabled ? 'blue' : 'default'}>{p.enabled ? '参与搜歌' : '尚未启用'}</Tag></Flex></Card></Col>)}</Row>
    {!settingsReady ? <Spin spinning={s.loading}><Empty description={s.error ? '设置暂不可用' : '正在读取设置'} /></Spin> : <>
      <Card title="默认音质"><SettingFields api={api} base={base} s={s} keys={['FNMUSIC_QUALITY_MODE']} /></Card>
      <Collapse activeKey={expanded} onChange={setExpanded} items={[{ key: 'sources', label: '其他音源', children: <SourceSettings api={api} base={base} s={s} /> }]} />
    </>}
    <Drawer title={platform && <Space><PlatformLogo platform={platform} size={28} />{platform.name}设置</Space>} open={!!platform} onClose={() => setSelected(null)} size={560} destroyOnHidden footer={s.dirty > 0 && <Flex justify="space-between" align="center" gap={12} wrap><Text>有 {s.dirty} 项设置待保存</Text><Space><Button disabled={s.saving} onClick={s.discard}>放弃修改</Button><Button type="primary" loading={s.saving} onClick={s.save}>保存设置</Button></Space></Flex>}>
      {platform && <Space direction="vertical" size={20} className="settings-stack">
        {feedback}
        <Card title="账号"><Flex justify="space-between" align="center" gap={12} wrap><Badge status={platform.auth?.logged_in ? 'success' : 'default'} text={platform.status} /><Button disabled={s.saving} onClick={() => m.setAccount(platform.id)}>{platform.auth?.logged_in ? '管理账号' : platform.capabilities.login ? '登录' : '接入说明'}</Button></Flex></Card>
        {settingsReady && <><QualitySettings api={api} s={s} scope={platform.id} />{platform.id === 'netease' && <NeteasePlaylistSettings api={api} base={base} s={s} />}</>}
      </Space>}
    </Drawer>
  </Space>;
}
