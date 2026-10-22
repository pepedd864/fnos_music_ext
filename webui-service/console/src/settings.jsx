import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Descriptions, Empty, Flex, Image, List, Modal, Space, Spin, Tag, Typography } from 'antd';
import { DownloadOutlined, SaveOutlined, SettingOutlined } from '@ant-design/icons';
import { editableConfig, externalUrl, patchSettingsDraft, persistSettings, providerNames, settingPages, settingValue } from './settings-model.js';
import { SettingFields } from './settings-fields.jsx';
import { PublicPlaylists } from './public-playlists.jsx';
const { Text, Paragraph } = Typography;

export function useSettings(api, message, afterSave) {
  const [saved, setSaved] = useState({}), [schema, setSchema] = useState({}), [presence, setPresence] = useState({});
  const [changes, setChanges] = useState({}), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), [report, setReport] = useState(null);
  const epoch = useRef(0), lock = useRef(false);
  const refresh = async () => {
    const version = ++epoch.current; setLoading(true);
    try {
      const data = await api('/api/config');
      if (version !== epoch.current) return;
      // Only retain whether a secret exists; never put saved credentials in form fields.
      const values = editableConfig(data);
      setSaved(values); setSchema(data.schema); setPresence(data.presence || {}); setError('');
    } catch (error) { if (version === epoch.current) setError(error.message); }
    finally { if (version === epoch.current) setLoading(false); }
  };
  useEffect(() => () => { epoch.current++; }, []);
  const dirty = Object.keys(changes).length;
  useEffect(() => {
    if (!dirty) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const patch = updates => {
    setChanges(previous => patchSettingsDraft(previous, updates, saved, schema));
    setReport(null);
  };
  const save = async () => {
    if (lock.current || !dirty) return;
    lock.current = true; setSaving(true); setReport(null);
    try {
      const values = { ...changes };
      const result = await persistSettings(api, values, schema);
      setSaved(previous => ({ ...previous, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, schema[key]?.kind === 'secret' ? Boolean(value) : value])) }));
      setChanges({});
      const warnings = (result.warnings || []).map(warning => typeof warning === 'string' ? warning : [warning.source, warning.error || warning.reason || warning.message].filter(Boolean).join('：'));
      for (const action of result.actions || []) if (action.ok === false) warnings.push([action.program || action.source || action.kind, action.error || action.reason || '操作未完成'].join('：'));
      if (result.restart_keys?.length) warnings.push('部分设置需重启应用生效：' + result.restart_keys.join('、'));
      setReport({ warnings, changed: result.changed?.length || 0 });
      if (warnings.length) message.warning('设置已保存，请查看下方的运行提示'); else message.success('设置已保存');
      await refresh(); await afterSave();
    } catch (error) { message.error(error.message); setReport({ error: error.message }); }
    finally { lock.current = false; setSaving(false); }
  };
  return { saved, schema, presence, changes, dirty, loading, saving, error, report, refresh, save, patch,
    value: key => schema[key]?.kind === 'secret' ? changes[key] || '' : Object.hasOwn(changes, key) ? changes[key] : settingValue(saved[key], schema[key]),
    set: (key, value) => patch({ [key]: value }),
    clearSecret: key => { setChanges(previous => ({ ...previous, [key]: '' })); setReport(null); },
    discard: () => { setChanges({}); setReport(null); }, dismissReport: () => setReport(null), notify: text => message.info(text),
  };
}

export function SaveSettings({ s }) {
  if (!s.dirty) return null;
  return <div className="settings-save"><Flex justify="space-between" align="center" wrap gap={12}><Text>有 {s.dirty} 项设置待保存</Text><Space><Button disabled={s.saving} onClick={s.discard}>放弃修改</Button><Button type="primary" icon={<SaveOutlined />} loading={s.saving} onClick={s.save}>保存设置</Button></Space></Flex></div>;
}

function Status({ api }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true, timer;
    const load = async () => {
      if (document.visibilityState === 'hidden') { timer = setTimeout(load, 15000); return; }
      setBusy(true);
      try { const next = await api('/api/status'); if (alive) { setData(next); setError(''); } }
      catch (error) { if (alive) setError(error.message); }
      finally { if (alive) { setBusy(false); timer = setTimeout(load, 15000); } }
    };
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  return <Space direction="vertical" size={20} className="settings-stack">{error && <Alert type="error" title={error} showIcon />}<Card title="服务状态" loading={!data && busy}><Descriptions column={{ xs: 1, md: 2 }} items={[{ key: 'version', label: '版本', children: data?.version || '—' }, { key: 'provider', label: '当前音源', children: providerNames[data?.current_provider] || '未启用' }, { key: 'deploy', label: '部署方式', children: data?.deploy_mode || '—' }]} /><List dataSource={Object.entries(data?.processes || {})} locale={{ emptyText: <Empty description="暂无进程状态" /> }} renderItem={([name, process]) => <List.Item><List.Item.Meta title={providerNames[name] || name} description={process.detail} /><Badge status={process.state === 'RUNNING' ? 'success' : ['FATAL', 'BACKOFF', 'EXITED'].includes(process.state) ? 'error' : 'default'} text={process.state} /></List.Item>} /></Card>
    <Card title="音源连接"><List dataSource={Object.entries(data?.services || {})} renderItem={([name, service]) => <List.Item><List.Item.Meta title={providerNames[name] || name} description={service.note || (typeof service.detail === 'string' ? service.detail : '')} /><Badge status={service.reachable ? 'success' : 'default'} text={service.reachable ? '已连接' : '未连接'} /></List.Item>} /></Card>
    {data?.lx_source && <Card title="当前洛雪源"><Space direction="vertical" size={16} className="settings-stack"><Badge status={data.lx_source.initialized ? 'success' : 'default'} text={data.lx_source.initialized ? '已加载' : '未加载'} /><List dataSource={data.lx_source.sources || (data.lx_source.source ? [data.lx_source.source] : [])} locale={{ emptyText: '暂无激活源' }} renderItem={source => <List.Item><List.Item.Meta title={source.name || '洛雪源'} description={Array.isArray(source.platforms) ? source.platforms.join('、') : Object.keys(source.platforms || {}).join('、')} /><Text type="secondary">{source.version || ''}</Text></List.Item>} />{(data.lx_source.last_error || data.lx_source.error) && <Alert type="warning" title={data.lx_source.last_error || data.lx_source.error} showIcon />}</Space></Card>}
    {Object.keys(data?.previews || {}).length > 0 && <Card title="临时预览"><List dataSource={Object.entries(data.previews)} renderItem={([name, seconds]) => <List.Item>{providerNames[name] || name}<Tag>剩余 {seconds} 秒</Tag></List.Item>} /></Card>}<Text type="secondary">页面显示时每 15 秒更新。</Text></Space>;
}

function About({ api, base, message }) {
  const [info, setInfo] = useState(null), [update, setUpdate] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(''), [open, setOpen] = useState(false);
  const active = useRef(true);
  const check = async () => {
    setBusy('update');
    try { const result = await api('/api/update-check'); if (active.current) setUpdate(result); }
    catch (error) { if (active.current) setUpdate({ error: error.message }); }
    finally { if (active.current) setBusy(''); }
  };
  useEffect(() => { api('/api/about').then(result => { if (active.current) setInfo(result); }).catch(error => { if (active.current) setError(error.message); }); check(); return () => { active.current = false; }; }, []);
  const exportLogs = async () => {
    setBusy('logs');
    try {
      const response = await fetch(base + '/api/logs/export', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('日志导出失败（' + response.status + '）');
      const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
      const filename = response.headers.get('content-disposition')?.match(/filename="?([^";]+)/)?.[1];
      link.href = url; link.download = filename?.replace(/[^\w.-]/g, '_') || 'fnmusic-logs.logzip'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      message.success('日志已导出');
    } catch (error) { message.error(error.message); }
    finally { if (active.current) setBusy(''); }
  };
  return <Space direction="vertical" size={20} className="settings-stack">{error && <Alert type="error" title={error} showIcon />}<Card title="fnMusic 音源扩展" loading={!info && !error}><Descriptions column={1} items={[{ key: 'version', label: '当前版本', children: info?.version || '—' }, { key: 'deploy', label: '部署方式', children: info?.deploy_mode === 'native' ? '原生部署' : 'Docker 部署' }]} /><Flex gap={12} wrap>{[['项目仓库', info?.repo_url], ['问题反馈', info?.issues_url], ['作者', info?.author_url]].map(([label, url]) => externalUrl(url) && <Button key={label} href={externalUrl(url)} target="_blank" rel="noreferrer">{label}</Button>)}<Button loading={busy === 'update'} onClick={check}>检查更新</Button>{update?.has_update && <Button type="primary" onClick={() => setOpen(true)}>查看 v{update.latest?.version}</Button>}</Flex>{update && <Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>{update.error ? '更新检查暂不可用：' + update.error : update.has_update ? '发现新版本，请先查看更新说明。' : '当前没有更新。'}</Paragraph>}</Card>
    <Card title="诊断日志" extra={<Button icon={<DownloadOutlined />} loading={busy === 'logs'} onClick={exportLogs}>导出日志</Button>}><Paragraph type="secondary">保留最近 {info?.log_retention_days || 3} 天日志，导出时会隐藏凭据。</Paragraph><List dataSource={info?.logs || []} locale={{ emptyText: '暂无日志文件' }} renderItem={file => <List.Item>{file.name}<Text type="secondary">{(file.size / 1024).toFixed(1)} KB</Text></List.Item>} /></Card>
    {info?.disclaimer?.length > 0 && <Card title="使用说明"><List dataSource={info.disclaimer} renderItem={item => <List.Item><div><Text strong>{item.title}</Text><Paragraph style={{ marginBottom: 0 }}>{item.text}</Paragraph></div></List.Item>} /></Card>}
    {info?.donate && <Card title="支持项目"><Image src={base + '/static/alipay.png'} width={220} alt="支持项目二维码" /></Card>}
    <Modal title={'新版本 v' + (update?.latest?.version || '')} open={open} onCancel={() => setOpen(false)} footer={<Space><Button onClick={() => setOpen(false)}>关闭</Button>{externalUrl(update?.latest?.html_url) && <Button type="primary" href={externalUrl(update.latest.html_url)} target="_blank" rel="noreferrer">前往发布页</Button>}</Space>}><Text type="secondary">{update?.latest?.published_at || ''}</Text><Paragraph className="diagnostic-text">{update?.latest?.changelog || '暂无更新说明'}</Paragraph></Modal>
  </Space>;
}

export function Settings({ page, s, api, base, m }) {
  if (page === 'service-status') return <Status api={api} />;
  if (page === 'about') return <About api={api} base={base} message={m.message} />;
  const fields = keys => <SettingFields keys={keys} s={s} api={api} base={base} />;
  return <Space direction="vertical" size={20} className="settings-stack">{s.error && <Alert type="error" title={s.error} action={<Button onClick={s.refresh}>重新连接</Button>} showIcon />}
    {s.report && <Alert type={s.report.error ? 'error' : s.report.warnings.length ? 'warning' : 'success'} title={s.report.error || (s.report.warnings.length ? '配置已保存，部分操作需要处理' : '设置已生效')} description={!s.report.error && s.report.warnings.map((warning, index) => <div key={index}>{warning}</div>)} showIcon closable onClose={s.dismissReport} />}
    {!Object.keys(s.schema).length ? <Spin spinning={s.loading}><Empty description={s.error ? '设置暂不可用' : '正在读取设置'} /></Spin> : <>
      {page === 'playback-settings' && <><Card title="下载与漫游">{fields(['FNMUSIC_DL_QUALITY', 'FNMUSIC_ROAM_SOURCE'])}</Card><Card title="推荐内容">{fields(['FNMUSIC_RECOMMEND_HOT', 'FNMUSIC_RECOMMEND_DAILY'])}</Card><PublicPlaylists api={api} s={s} /></>}
      {page === 'storage-settings' && <><Card title="边听边存">{fields(['FNMUSIC_TEE_SAVE_ENABLED', 'FNMUSIC_AUTO_COVER', 'FNMUSIC_LYRIC_AUTO_DL', 'FNMUSIC_TEE_CACHE_MAX'])}</Card><Card title="歌曲目录">{fields(['FNMUSIC_TEE_SAVE_DIR', 'FNMUSIC_CACHE_DIR'])}</Card><Card title="飞牛曲库关联">{fields(['FNMUSIC_FAV_AUTO_BIND', 'FNMUSIC_OFFICIAL_BIND_TIMEOUT_S', 'FNMUSIC_TEE_HANDOFF_MAX', 'FNMUSIC_LIBRARY_SCAN_PATH'])}</Card></>}
      {page === 'search-settings' && <Card title="搜索行为">{fields(['FNMUSIC_SEARCH_TIMEOUT', 'FNMUSIC_SEARCH_PROBE', 'FNMUSIC_SEARCH_DEEP_PAGE', 'FNMUSIC_SEARCH_DEEP_MAX_PAGES'])}</Card>}
      {page === 'llm-settings' && <Card title="大模型服务">{fields(['FNMUSIC_LLM_BASE_URL', 'FNMUSIC_LLM_API_KEY', 'FNMUSIC_LLM_MODEL'])}</Card>}
    </>}
  </Space>;
}

export const settingsMenu = Object.entries(settingPages).map(([key, [label]]) => ({ key, label, icon: <SettingOutlined /> }));
