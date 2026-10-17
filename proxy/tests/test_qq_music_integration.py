"""Official Music integration for deferred QQ tracks."""
import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from proxy import app as proxy


@pytest.fixture(autouse=True)
def setup(monkeypatch, tmp_path):
    monkeypatch.setattr(proxy, "_SEARCH_CACHE", {})
    monkeypatch.setattr(proxy, "_USER_SEARCH_WORD", {})
    monkeypatch.setattr(proxy, "_USER_SEARCH_GEN", {})
    monkeypatch.setattr(proxy, "_SEARCH_DEBOUNCE", {})
    for key, value in {"musicdl_enabled": True, "netease_enabled": False, "lx_enabled": False,
                       "online_sources": "QQMusicClient", "online_limit": 30,
                       "search_deep_page": True, "search_deep_max_pages": 10,
                       "search_debounce_s": 0, "late_page_wait_s": 3,
                       "cache_dir": str(tmp_path), "library_dir": str(tmp_path),
                       "fav_dir": str(tmp_path)}.items():
        monkeypatch.setitem(proxy.CONF, key, value)


def test_official_music_qq_search_pages_are_stable_and_metadata_only():
    pages = []

    def source(req):
        if req.url.path != "/search":
            return httpx.Response(404)
        page = int(req.url.params.get("page", 1))
        pages.append(page)
        assert req.url.params["sources"] == "QQMusicClient"
        items = [{"id": f"qq:mid{i}", "source": "qq", "title": f"Song {i}", "artist": "Singer",
                  "album": "Album", "ext": "flac", "duration_s": 200, "resolve_on_play": True}
                 for i in range((page - 1) * 30, min(70, page * 30))]
        return httpx.Response(200, json={"ok": True, "items": items, "errors": {}})

    def upstream(req):
        return httpx.Response(200, json={"code": 0, "msg": "OK", "data": {"list": [], "total": 0}})

    proxy.app.state.musicdl_client = httpx.AsyncClient(transport=httpx.MockTransport(source), base_url="http://musicdl")
    proxy.app.state.upstream_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream), base_url="http://unix")
    with TestClient(proxy.app) as client:
        one = client.get("/music/api/v1/search/track?q=fixture&page=1&size=50").json()["data"]["list"]
        two = client.get("/music/api/v1/search/track?q=fixture&page=2&size=50").json()["data"]["list"]
        three = client.get("/music/api/v1/search/track?q=fixture&page=3&size=50").json()["data"]["list"]
    assert len(one) == 50 and len(two) == 20 and three == []
    assert len({t["guid"] for t in one + two}) == 70
    assert pages == [1, 2, 3, 4]


@pytest.mark.asyncio
async def test_transient_qq_page_error_keeps_cursor_retryable(monkeypatch):
    monkeypatch.setattr(proxy, "_user_search_stale", lambda *args: False)
    async def failed(*args, **kwargs):
        return {"items": [], "errors": {"QQMusicClient": "timeout"}}
    monkeypatch.setattr(proxy, "fetch_musicdl_search", failed)
    req = Request({"type": "http", "headers": [], "app": proxy.app})
    entry = {"items": [{"id": "qq:one", "source": "qq", "title": "One"}]}
    await proxy._extend_search(req, "fixture", entry)
    assert "qq" not in entry["exhausted"] and not entry["deep_cursors"]


@pytest.mark.asyncio
async def test_actual_qq_format_wins_over_stale_catalog_and_cdn_type(monkeypatch):
    def handler(req):
        assert req.url.path == "/stream" and req.headers["range"] == "bytes=0-3"
        return httpx.Response(206, content=b"fLaC", headers={"x-audio-format": "flac", "content-type": "audio/mpeg"})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://musicdl")
    monkeypatch.setattr(proxy, "get_musicdl_client", lambda app: client)
    req = Request({"type": "http", "headers": [], "app": proxy.app})
    opened = await proxy._open_online_stream(req, "online:qq:abc123", "bytes=0-3")
    assert opened is not None and opened[2] == "flac" and opened[-1] == b"fLaC"
    await opened[0].aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_metadata_without_lyrics_flag_reaches_service(monkeypatch):
    def handler(req):
        assert req.url.path == "/info" and req.url.params["include_lyric"] == "false"
        return httpx.Response(200, json={"ok": True, "title": "Fixture", "ext": "flac"})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://musicdl")
    monkeypatch.setattr(proxy, "get_musicdl_client", lambda app: client)
    req = Request({"type": "http", "headers": [], "app": proxy.app})
    assert (await proxy._fetch_online_info(req, "online:qq:abc123", include_lyric=False))["title"] == "Fixture"
    await client.aclose()
