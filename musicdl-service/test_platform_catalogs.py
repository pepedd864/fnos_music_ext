"""Offline catalog contracts: credentials, deferred resolution and account changes."""
import asyncio
import json
import stat

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from test_app_search import app_module as service, clean_state  # noqa: F401
from kugou_catalog import KugouCatalog, normalize
from kuwo_catalog import catalog as kuwo_catalog

HASH = 'b3a52a7a958bf0aed0ebfba2e9a818b7'
ROW = {'FileHash': HASH.upper(), 'SongName': 'Song', 'SingerName': 'Singer', 'AlbumName': 'Album', 'Duration': 180, 'MixSongID': 12, 'Image': 'https://cover.test/{size}.jpg'}


@pytest.mark.asyncio
async def test_kugou_qr_session_persists_private_credentials_without_returning_them(tmp_path):
    calls = []
    def handler(request):
        calls.append(request)
        if request.url.path == '/v2/qrcode':
            return httpx.Response(200, json={'status': 1, 'data': {'qrcode': 'synthetic-qr-session'}})
        return httpx.Response(200, json={'status': 1, 'data': {'status': 4, 'userid': 12345, 'token': 'synthetic-only-token'}})
    catalog = KugouCatalog(tmp_path / 'account', transport=httpx.MockTransport(handler))
    qr = await catalog.login()
    assert qr['image'].startswith('data:image/png;base64,')
    assert 'synthetic-qr-session' not in json.dumps(qr)
    with pytest.raises(HTTPException):
        await catalog.check('different-session')
    assert (await catalog.check(qr['session_id']))['state'] == 'done'
    assert catalog.status()['account'] == '****2345'
    assert 'synthetic-only-token' not in json.dumps(catalog.status())
    assert stat.S_IMODE(catalog.path.stat().st_mode) == 0o600
    assert stat.S_IMODE(catalog.directory.stat().st_mode) == 0o700
    assert KugouCatalog(catalog.directory).status()['logged_in']
    await catalog.logout()
    assert not catalog.path.exists() and not catalog.status()['logged_in']
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_kugou_metadata_search_pages_without_resolving_audio(tmp_path):
    def handler(request):
        assert request.url.path == '/v2/search/song'
        assert request.url.params['page'] == '2'
        assert request.headers['x-router'] == 'complexsearch.kugou.com'
        assert 'signature' in request.url.params
        assert 'musicid' not in request.url.params and 'musickey' not in request.url.params
        return httpx.Response(200, json={'status': 1, 'data': {'total': 100, 'lists': [ROW]}})
    result = await KugouCatalog(tmp_path, httpx.MockTransport(handler)).search('Song', 2)
    assert result['has_more']
    assert result['items'][0]['id'] == f'kugou:{HASH}:12'
    assert 'download_url' not in result['items'][0]
    assert result['items'][0]['cover_url'] == 'https://cover.test/400.jpg'


@pytest.mark.asyncio
async def test_kugou_quality_cache_is_separate_and_logout_cannot_republish_old_resolution(tmp_path):
    seen = []
    started, release = asyncio.Event(), asyncio.Event()
    async def handler(request):
        seen.append(request.url.params['quality'])
        if request.url.params['quality'] == 'flac':
            started.set(); await release.wait()
        return httpx.Response(200, json={'status': 1, 'url': ['https://audio.test/' + request.url.params['quality']]})
    catalog = KugouCatalog(tmp_path, httpx.MockTransport(handler))
    catalog.save({'userid': 123, 'token': 'synthetic-only', 'mid': 'device'})
    await catalog.resolve(f'kugou:{HASH}:12', 'mp3_128')
    await catalog.resolve(f'kugou:{HASH}:12', 'mp3_128')
    task = asyncio.create_task(catalog.resolve(f'kugou:{HASH}:12', 'lossless'))
    await started.wait(); await catalog.logout(); release.set()
    with pytest.raises(HTTPException) as error:
        await task
    assert error.value.status_code == 409 and not catalog.resolved
    assert seen == ['128', 'flac']


@pytest.mark.asyncio
async def test_kugou_refuses_trial_audio_and_recommendations_require_login(tmp_path):
    catalog = KugouCatalog(tmp_path, httpx.MockTransport(lambda request: httpx.Response(200, json={'status': 1, 'url': ['https://audio.test/preview'], 'is_free_part': 1})))
    with pytest.raises(HTTPException) as error:
        await catalog.recommend()
    assert error.value.status_code == 401
    with pytest.raises(HTTPException) as error:
        await catalog.resolve(f'kugou:{HASH}:12')
    assert error.value.status_code == 403
    assert normalize({'hash': 'https://not-an-id'}) is None


@pytest.mark.asyncio
async def test_kuwo_public_selections_have_stable_ids_and_never_forward_cookie_or_audio_url():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'num': 80, 'musiclist': [{'id': 42, 'name': 'Song', 'artist': 'Singer', 'song_duration': '180', 'url': 'SECRET'}]}))) as client:
        result = await kuwo_catalog('recommend', page=2, client=client)
    assert result['recommend_kind'] == 'public' and result['has_more']
    assert result['items'][0]['id'] == 'kuwo:42'
    assert 'SECRET' not in json.dumps(result)


@pytest.mark.asyncio
async def test_native_catalog_metadata_skips_audio_probes(clean_state, monkeypatch):
    async def search(*args, **kwargs):
        return {'items': [normalize(ROW)]}
    monkeypatch.setattr(service.KUGOU, 'search', search)
    monkeypatch.setattr(service, '_probe_playable_sync', lambda *args: pytest.fail('search must not resolve or probe audio'))
    result = await asyncio.to_thread(service._search_playable, 'KugouMusicClient', 'Song', 20, 10)
    assert result[0][0]['resolve_on_play'] and not result[0][0]['download_url']


def test_source_auth_routes_reject_unknown_operations_and_large_payload(clean_state, monkeypatch, tmp_path):
    monkeypatch.setattr(service, 'KUGOU', KugouCatalog(tmp_path))
    with TestClient(service.app) as client:
        assert client.get('/auth/kugou/status').json()['state'] == 'anonymous'
        assert client.get('/auth/kugou/logout').status_code == 404
        assert client.post('/auth/kugou/credential').status_code == 404
        assert client.post('/auth/kugou/login/check', content='x' * 1025).status_code == 413
