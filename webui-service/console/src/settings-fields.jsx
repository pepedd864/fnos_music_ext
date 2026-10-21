import { useEffect, useRef, useState } from 'react';
import { Button, Col, Flex, Form, Input, InputNumber, Popconfirm, Row, Select, Space, Switch, Tag, Typography } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';
import { pickNas } from './nas.js';
const { Text } = Typography;
const optionNames = { high: '高音质优先', balanced: '平衡', smooth: '流畅优先', auto: '自动 · 跟随音质偏好', master: '母带 FLAC 优先', lossless: '无损 FLAC 优先', mp3_320: 'MP3 320k', mp3_128: '一般 · MP3 128k', local: '飞牛本地曲库', qq: 'QQ 个性化推荐', app: '跟随飞牛 App', original: '原音质文件', standard: 'MP3 320k 优先' };
const labels = { FNMUSIC_QUALITY_MODE: '全局默认音质', FNMUSIC_TEE_SAVE_DIR: '下载目录', FNMUSIC_CACHE_DIR: '歌曲缓存目录', FNMUSIC_TEE_CACHE_MAX: '关闭边听边存时保留的缓存数量', FNMUSIC_SEARCH_PROBE: '逐曲探活', FNMUSIC_OFFICIAL_BIND_TIMEOUT_S: '等待飞牛收录的时间（秒）', FNMUSIC_TEE_HANDOFF_MAX: '切歌后继续下载的并行数', FNMUSIC_LIBRARY_SCAN_PATH: '曲库扫描接口', FNMUSIC_LLM_BASE_URL: '服务地址', FNMUSIC_LLM_API_KEY: 'API Key', FNMUSIC_LLM_MODEL: '模型名称' };
const hints = {
  FNMUSIC_TEE_SAVE_ENABLED: '完整播放在线歌曲后，自动保存到本地曲库。',
  FNMUSIC_AUTO_COVER: '歌曲保存成功后，将专辑封面嵌入音频文件。',
  FNMUSIC_LYRIC_AUTO_DL: '保存同名 LRC 歌词文件，供飞牛扫描使用。',
  FNMUSIC_TEE_SAVE_DIR: '留空时自动选择飞牛共享音乐库。',
  FNMUSIC_CACHE_DIR: '留空时使用应用缓存目录。请与下载目录分开。',
  FNMUSIC_FAV_AUTO_BIND: '收藏或加入歌单后下载歌曲，待飞牛收录后关联本地文件。',
  FNMUSIC_LIBRARY_SCAN_PATH: '可选。需要经过验证的飞牛扫描接口；留空使用飞牛自身的目录监测。',
  FNMUSIC_QQ_QUALITY: '影响之后的在线播放与获取，实际可用音质取决于账号与歌曲授权。',
  FNMUSIC_ROAM_SOURCE: 'QQ 个性化推荐需要已启用的 QQ 音源和有效登录。',
  FNMUSIC_SEARCH_PROBE: '预先解析每首候选歌曲，可能增加等待时间。',
  FNMUSIC_SEARCH_DEEP_PAGE: '翻页时向支持的音源继续请求歌曲。',
  FNMUSIC_LLM_BASE_URL: '填写 OpenAI 兼容服务地址。',
};
function DirectoryInput({ settingKey, s, api, base }) {
  const path = s.value(settingKey), [check, setCheck] = useState(null), [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  useEffect(() => { epoch.current++; setCheck(null); }, [path]);
  useEffect(() => () => { epoch.current++; }, []);
  const inspect = async () => {
    const version = ++epoch.current; setBusy(true);
    try { const result = await api('/api/fs-check', { path }); if (version === epoch.current) setCheck({ ok: result.writable, text: result.writable ? result.exists ? '目录可写' : '父目录可写，保存后创建目录' : '目录不可写' }); }
    catch (error) { if (version === epoch.current) setCheck({ ok: false, text: error.message }); }
    finally { if (version === epoch.current) setBusy(false); }
  };
  return <Space direction="vertical" style={{ width: '100%' }}><Input aria-label={labels[settingKey]} value={path} onChange={e => s.set(settingKey, e.target.value)} placeholder="留空使用默认目录" />
    <Flex gap={8} wrap><Button icon={<FolderOpenOutlined />} onClick={async () => { try { const selected = await pickNas(base); if (selected) s.set(settingKey, selected); } catch { s.notify('当前环境无法打开 NAS 选择器，请直接填写目录'); } }}>从 NAS 选择</Button><Button disabled={!path} loading={busy} onClick={inspect}>检查目录</Button>{check && <Text type={check.ok ? 'success' : 'warning'}>{check.text}</Text>}</Flex></Space>;
}
export function SettingFields({ keys, s, api, base }) {
  return <Form layout="vertical" disabled={s.saving}><Row gutter={[24, 4]}>{keys.filter(key => s.schema[key]).map(key => {
    const spec = s.schema[key], value = s.value(key), label = labels[key] || spec.label;
    let control;
    if (spec.kind === 'bool') control = <Switch aria-label={label} checked={value} onChange={next => s.set(key, next)} />;
    else if (spec.kind === 'int') control = <InputNumber aria-label={label} min={spec.min} max={spec.max} precision={0} value={value} onChange={next => s.set(key, next)} style={{ width: '100%' }} />;
    else if (spec.kind === 'enum') control = <Select aria-label={label} value={value} onChange={next => s.set(key, next)} options={spec.values.map(option => ({ value: option, label: optionNames[option] || option }))} />;
    else if (spec.kind === 'secret') control = <Space direction="vertical" style={{ width: '100%' }}><Input.Password aria-label={label} autoComplete="new-password" value={value} onChange={e => s.set(key, e.target.value)} placeholder={s.saved[key] ? '已保存，留空保留原密钥' : '输入 API Key'} />{s.saved[key] && <Space><Tag>{s.changes[key] === '' ? '保存后清除' : '已保存密钥'}</Tag><Popconfirm title="清除已保存的 API Key？" onConfirm={() => s.clearSecret(key)}><Button type="link" danger size="small">清除密钥</Button></Popconfirm></Space>}</Space>;
    else if (spec.kind === 'dir') control = <DirectoryInput settingKey={key} s={s} api={api} base={base} />;
    else control = <Input aria-label={label} value={value} onChange={e => s.set(key, e.target.value)} />;
    return <Col key={key} xs={24} lg={spec.kind === 'dir' || spec.kind === 'secret' ? 24 : 12}><Form.Item label={label} extra={hints[key]}>{control}</Form.Item></Col>;
  })}</Row></Form>;
}
