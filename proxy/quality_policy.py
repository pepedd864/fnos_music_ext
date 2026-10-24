"""Shared channel quality capabilities and backward-compatible preferences."""
import json

SETTING = 'FNMUSIC_CHANNEL_QUALITIES'
LX_PLATFORMS = {'kg': '酷狗音乐', 'kw': '酷我音乐', 'wy': '网易云音乐', 'mg': '咪咕音乐'}
OPTIONS = {
    'qq': ('master', 'lossless', 'mp3_320', 'mp3_128'),
    'kugou': ('lossless', 'mp3_320', 'mp3_128'),
    'netease': ('jymaster', 'hires', 'lossless', 'exhigh', 'higher', 'standard'),
    **{f'lx:{source}': ('lossless', 'high', 'standard') for source in LX_PLATFORMS},
}
LABELS = {'auto': '跟随全局默认', 'master': '母带优先', 'lossless': '无损优先',
          'mp3_320': '高品质 · MP3 320k', 'mp3_128': '一般 · MP3 128k',
          'jymaster': '超清母带优先', 'hires': 'Hi-Res 优先', 'exhigh': '高品质 · 320k 优先',
          'higher': '较高 · 192k 优先', 'standard': '一般 · 128k 优先', 'high': '高品质 · 320k 优先'}


def validate_channel_qualities(raw):
    if isinstance(raw, str):
        if len(raw) > 4096:
            raise ValueError('渠道音质设置过长')
        try:
            raw = json.loads(raw)
        except ValueError:
            raise ValueError('渠道音质设置必须是 JSON 对象') from None
    if not isinstance(raw, dict):
        raise ValueError('渠道音质设置必须是 JSON 对象')
    for channel, quality in raw.items():
        if channel not in OPTIONS or quality not in ('auto', *OPTIONS[channel]):
            raise ValueError('渠道不支持所选音质：' + str(channel))
    return dict(raw)


def read_channel_qualities(raw):
    try:
        return validate_channel_qualities(raw or '{}')
    except (ValueError, TypeError):
        return {}


def channel_preference(values, channel):
    overrides = read_channel_qualities(values.get(SETTING))
    if channel in overrides:
        return overrides[channel]
    # Preserve an existing QQ preference until explicitly changed in the new UI.
    legacy = values.get('FNMUSIC_QQ_QUALITY', 'auto') if channel == 'qq' else 'auto'
    return legacy if legacy in ('auto', *OPTIONS.get(channel, ())) else 'auto'


def quality_channels(values):
    yes = lambda key: str(values.get(key, 'false')).lower() in ('true', '1', 'yes')
    raw = values.get('FNMUSIC_ONLINE_SOURCES') or values.get('MUSICDL_SOURCES') or 'KuwoMusicClient,MiguMusicClient'
    sources = {part.strip() for part in raw.split(',') if part.strip()}
    rows = []
    def add(channel, name, route, enabled, configurable=True):
        rows.append({'id': channel, 'name': name, 'route': route, 'enabled': enabled,
                     'configurable': configurable,
                     'preference': channel_preference(values, channel) if configurable else 'original',
                     'options': [{'value': key, 'label': LABELS[key]} for key in ('auto', *OPTIONS[channel])] if configurable else [{'value': 'original', 'label': '音源实际音质'}],
                     'note': '按当前接入返回的实际格式播放，尚未接入指定档位。' if not configurable else ''})
    common = [('qq', 'QQ 音乐', 'QQMusicClient'), ('kugou', '酷狗音乐', 'KugouMusicClient'), ('kuwo', '酷我音乐', 'KuwoMusicClient')]
    known = set()
    for channel, name, client in common:
        known.update((channel, client))
        add(channel, name, '平台直连', yes('FNMUSIC_MUSICDL_ENABLED') and bool(sources & {channel, client}), channel in ('qq', 'kugou'))
    for source in sorted(sources - known):
        add('musicdl:' + source, source.removesuffix('MusicClient'), '聚合音源', yes('FNMUSIC_MUSICDL_ENABLED'), False)
    add('netease', '网易云音乐', '网易账号音源', yes('FNMUSIC_NETEASE_ENABLED') or yes('FNMUSIC_NETEASE_PLAYLIST_RESIDENT') or yes('FNMUSIC_CONSOLE_NETEASE_ENABLED'))
    aliases = {'kugou': 'kg', 'kuwo': 'kw', 'netease': 'wy', '163': 'wy', 'migu': 'mg'}
    selected = {aliases.get(part.strip(), part.strip()) for part in (values.get('LX_SOURCES') or 'kg,wy,mg,kw').split(',')}
    for source, name in LX_PLATFORMS.items():
        add('lx:' + source, name, '洛雪音源', yes('FNMUSIC_LX_ENABLED') and source in selected)
    return rows
