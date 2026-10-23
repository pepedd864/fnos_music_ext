"""Realistic artwork contracts without network calls or personal music files."""
import base64

import httpx
import pytest
from fastapi import HTTPException

from cover_proxy import KuwoCovers, image_url

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')


@pytest.mark.asyncio
@pytest.mark.parametrize('path', ['/star/albumcover/500/test.jpg', '/pic_music/500/s4s13/34/1843394672.jpg'])
async def test_lazy_artwork_resolves_current_endpoint_and_caches_validated_bytes(path):
    calls = []
    def handler(request):
        calls.append(str(request.url))
        assert request.headers['referer'] == 'https://www.kuwo.cn/'
        if request.url.host == 'artistpicserver.kuwo.cn':
            assert request.url.path == '/pic.web'
            assert request.url.params['pictype'] == 'url'
            return httpx.Response(200, text='http://img1.kwcdn.kuwo.cn' + path + '\n')
        assert str(request.url) == 'https://img1.kuwo.cn' + path
        return httpx.Response(200, content=PNG)
    covers = KuwoCovers(httpx.MockTransport(handler))
    assert await covers.get('624683929') == (PNG, 'image/png')
    assert await covers.get('624683929') == (PNG, 'image/png')
    assert len(calls) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize('location', ['http://127.0.0.1/private.jpg', 'https://img1.kuwo.cn.evil.test/star/a.jpg', 'https://user@img1.kuwo.cn/star/a.jpg'])
async def test_untrusted_resolver_locations_never_receive_a_followup_request(location):
    calls = []
    def handler(request):
        calls.append(request.url.host)
        return httpx.Response(200, text=location)
    covers = KuwoCovers(httpx.MockTransport(handler))
    for _ in range(2):
        with pytest.raises(HTTPException) as error:
            await covers.get('42')
        assert error.value.status_code == 404
    assert calls == ['artistpicserver.kuwo.cn']  # Short negative cache prevents storms.


@pytest.mark.asyncio
@pytest.mark.parametrize('response', [
    httpx.Response(302, headers={'location': 'http://127.0.0.1/private'}),
    httpx.Response(200, content=b'<html>not artwork</html>'),
    httpx.Response(200, content=b'small', headers={'content-length': str(2 * 1024 * 1024 + 1)}),
])
async def test_redirects_html_and_oversized_responses_are_not_delivered_as_images(response):
    calls = []
    def handler(request):
        calls.append(request.url.host)
        if request.url.host == 'artistpicserver.kuwo.cn':
            return httpx.Response(200, text='https://img1.kuwo.cn/star/albumcover/a.jpg')
        return response
    with pytest.raises(HTTPException):
        await KuwoCovers(httpx.MockTransport(handler)).get('42')
    assert calls == ['artistpicserver.kuwo.cn', 'img1.kuwo.cn']


def test_artwork_alias_keeps_tls_validation_and_cache_has_a_fixed_size():
    assert image_url('http://img4.kwcdn.kuwo.cn/star/albumcover/a.jpg') == 'https://img4.kuwo.cn/star/albumcover/a.jpg'
    covers = KuwoCovers()
    for i in range(140):
        covers.remember(str(i), (PNG, 'image/png'))
    assert len(covers.cache) == 128 and '0' not in covers.cache
