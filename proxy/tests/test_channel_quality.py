import httpx
import pytest
from proxy import app as proxy
from proxy.quality_policy import channel_preference, quality_channels, validate_channel_qualities


def test_channels_preserve_legacy_qq_and_do_not_claim_unsupported_direct_qualities():
    values = {'FNMUSIC_MUSICDL_ENABLED': 'true', 'FNMUSIC_ONLINE_SOURCES': 'QQMusicClient,KugouMusicClient,KuwoMusicClient', 'FNMUSIC_QQ_QUALITY': 'mp3_128'}
    rows = {row['id']: row for row in quality_channels(values)}
    assert rows['qq']['preference'] == 'mp3_128'
    assert rows['kugou']['configurable'] is True
    assert {q['value'] for q in rows['kugou']['options']} == {'auto', 'lossless', 'mp3_320', 'mp3_128'}
    assert rows['kuwo']['options'] == [{'value': 'original', 'label': '音源实际音质'}]
    assert rows['lx:kw']['configurable'] is True
    assert rows['lx:kw']['enabled'] is False
    assert channel_preference({**values, 'FNMUSIC_CHANNEL_QUALITIES': '{"qq":"auto"}'}, 'qq') == 'auto'


@pytest.mark.parametrize('raw', ['[]', 'null', '{', {'kuwo': 'lossless'}, {'qq': 'hires'}, {'lx:kw': 'mp3_128'}])
def test_invalid_or_unsupported_channel_overrides_are_rejected(raw):
    with pytest.raises(ValueError):
        validate_channel_qualities(raw)


def test_qq_override_respects_existing_playback_identity(monkeypatch):
    monkeypatch.setitem(proxy.CONF, 'qq_quality', 'mp3_128')
    monkeypatch.setitem(proxy.CONF, 'quality_mode', 'high')
    monkeypatch.setitem(proxy.CONF, 'channel_qualities', {})
    assert proxy._qq_delivery_guid('online:qq:test') == 'online:qq:test:q-mp3_128'
    monkeypatch.setitem(proxy.CONF, 'channel_qualities', {'qq': 'auto'})
    assert proxy._qq_delivery_guid('online:qq:test') == 'online:qq:test:q-high'
    assert proxy._qq_delivery_guid('online:qq:test:q-mp3_128') == 'online:qq:test:q-mp3_128'


@pytest.mark.anyio
async def test_lx_channels_apply_independent_preferences_and_keep_active_stream_pinned(monkeypatch):
    proxy._LX_URL_PIN.clear()
    monkeypatch.setitem(proxy.CONF, 'quality_mode', 'high')
    monkeypatch.setitem(proxy.CONF, 'lx_quality', 'lossless')
    monkeypatch.setitem(proxy.CONF, 'channel_qualities', {'lx:kg': 'standard'})
    requests = []
    def handler(request):
        requests.append((request.url.params['id'], request.url.params['quality']))
        return httpx.Response(200, json={'ok': True, 'data': {'url': 'https://example.test/audio.mp3', 'content_type': 'audio/mpeg'}})
    try:
        async with httpx.AsyncClient(base_url='http://source.test', transport=httpx.MockTransport(handler)) as client:
            assert await proxy.resolve_lx_url(client, 'lx:kg:quality-test')
            assert await proxy.resolve_lx_url(client, 'lx:kw:quality-test')
            assert requests == [('lx:kg:quality-test', 'standard'), ('lx:kw:quality-test', 'lossless')]
            monkeypatch.setitem(proxy.CONF, 'channel_qualities', {'lx:kg': 'lossless'})
            assert await proxy.resolve_lx_url(client, 'lx:kg:quality-test')
            assert len(requests) == 2
    finally:
        proxy._LX_URL_PIN.clear()


@pytest.mark.anyio
async def test_netease_override_reaches_resolver_independently_of_global_mode(monkeypatch):
    proxy._NETEASE_URL_PIN.clear()
    monkeypatch.setitem(proxy.CONF, 'quality_mode', 'smooth')
    monkeypatch.setitem(proxy.CONF, 'netease_quality', 'lossless')
    monkeypatch.setitem(proxy.CONF, 'channel_qualities', {'netease': 'exhigh'})
    requested = []
    def handler(request):
        requested.append(request.url.params['quality'])
        return httpx.Response(200, json={'ok': True, 'data': {'code': 200, 'url': 'https://example.test/audio.mp3'}})
    try:
        async with httpx.AsyncClient(base_url='http://source.test', transport=httpx.MockTransport(handler)) as client:
            assert await proxy.resolve_netease_url(client, 'quality-test')
        assert requested == ['exhigh']
    finally:
        proxy._NETEASE_URL_PIN.clear()


def test_kugou_quality_delivery_identity_pins_continuation_and_keeps_catalog_id(monkeypatch):
    from starlette.requests import Request
    guid = 'online:kugou:' + 'a' * 32 + ':12'
    proxy._QQ_PLAY_PINS.clear()
    monkeypatch.setitem(proxy.CONF, 'channel_qualities', {'kugou': 'mp3_128'})
    request = Request({'type': 'http', 'method': 'GET', 'scheme': 'http', 'path': '/music/api/v1/track/stream',
                       'query_string': ('guid=' + guid).encode(), 'headers': [], 'server': ('testserver', 80)})
    first = proxy._qq_playback_redirect(request, guid, None)
    assert 'q-mp3_128' in first.headers['location']
    monkeypatch.setitem(proxy.CONF, 'channel_qualities', {'kugou': 'lossless'})
    continuation = proxy._qq_playback_redirect(request, guid, 'bytes=128-')
    assert 'q-mp3_128' in continuation.headers['location']
    assert 'q-lossless' in proxy._qq_playback_redirect(request, guid, None).headers['location']
    assert proxy.song_id_from_online_guid(guid + ':q-lossless') == 'kugou:' + 'a' * 32 + ':12'
    assert proxy._qq_delivery_guid(guid + ':q-mp3_128') == guid + ':q-mp3_128'
    proxy._QQ_PLAY_PINS.clear()


def test_console_netease_can_run_beside_musicdl_without_changing_engine(monkeypatch):
    monkeypatch.setitem(proxy.CONF, 'netease_enabled', False)
    monkeypatch.setitem(proxy.CONF, 'netease_playlist_resident', False)
    monkeypatch.setitem(proxy.CONF, 'musicdl_enabled', True)
    monkeypatch.setitem(proxy.CONF, 'console_netease_enabled', True)
    assert proxy._netease_runtime_usable()
    assert proxy._source_enabled('online:netease:42')
