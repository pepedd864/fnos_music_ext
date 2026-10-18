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
    monkeypatch.setattr(proxy, "_QQ_PLAY_PINS", {})
    for key, value in {"musicdl_enabled": True, "netease_enabled": False, "lx_enabled": False,
                       "online_sources": "QQMusicClient", "online_limit": 30,
                       "search_deep_page": True, "search_deep_max_pages": 10,
                       "search_debounce_s": 0, "late_page_wait_s": 3,
                       "cache_dir": str(tmp_path), "library_dir": str(tmp_path),
                       "fav_dir": str(tmp_path)}.items():
        monkeypatch.setitem(proxy.CONF, key, value)
    monkeypatch.setitem(proxy.CONF, "qq_quality", "auto")
    monkeypatch.setitem(proxy.CONF, "quality_mode", "high")


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


def playback_request(query="", range_header=None, cookie="one"):
    headers = [(b"cookie", cookie.encode())]
    if range_header:
        headers.append((b"range", range_header.encode()))
    return Request({"type": "http", "method": "GET", "scheme": "http", "server": ("test", 80),
                    "path": "/music/api/v1/track/stream", "query_string": query.encode(),
                    "headers": headers, "app": proxy.app})


def test_new_play_follows_preference_but_old_range_and_other_user_are_isolated(monkeypatch):
    monkeypatch.setattr(proxy, "find_cache_file", lambda guid: None)
    guid = "online:qq:abc123"
    first = proxy._qq_playback_redirect(playback_request(), guid, "bytes=0-")
    assert "q-high" in first.headers["location"] and "_qq_origin=remote" in first.headers["location"]
    monkeypatch.setitem(proxy.CONF, "qq_quality", "mp3_128")
    seek = proxy._qq_playback_redirect(playback_request(), guid, "bytes=12345-")
    assert seek.headers["location"] == first.headers["location"]
    another = proxy._qq_playback_redirect(playback_request(cookie="two"), guid, "bytes=12345-")
    assert "q-mp3_128" in another.headers["location"]
    restart = proxy._qq_playback_redirect(playback_request(), guid, "bytes=0-")
    assert "q-mp3_128" in restart.headers["location"]
    assert proxy._qq_playback_redirect(playback_request(), guid + ":q-high", "bytes=12345-") is None


def test_quality_cache_never_reuses_legacy_or_other_tier_by_tags(tmp_path, monkeypatch):
    guid = "online:qq:abc123"
    legacy = tmp_path / (proxy.cache_safe_guid(guid) + ".flac")
    legacy.write_bytes(b"legacy")
    proxy.remember_media_path(guid, str(legacy))
    monkeypatch.setattr(proxy, "_find_file_by_snapshot_tags", lambda guid: pytest.fail("unsafe tag match"))
    assert proxy.find_cache_file(guid) is None
    high_guid = guid + ":q-high"
    high = tmp_path / (proxy.cache_safe_guid(high_guid) + ".flac")
    high.write_bytes(b"high quality")
    assert proxy.find_cache_file(guid) == str(high)
    monkeypatch.setitem(proxy.CONF, "qq_quality", "mp3_128")
    assert proxy.find_cache_file(guid) is None
    assert proxy.find_cache_file(high_guid) == str(high)
    assert legacy.read_bytes() == b"legacy"


def test_saved_quality_paths_do_not_collapse_to_same_title(tmp_path):
    legacy = tmp_path / "Singer - Song.flac"
    legacy.write_bytes(b"original user file")
    high = proxy.library_media_path("online:qq:abc123:q-high", "Song", "flac", "Singer", str(tmp_path))
    low = proxy.library_media_path("online:qq:abc123:q-mp3_128", "Song", "mp3", "Singer", str(tmp_path))
    assert high != low and str(legacy) not in (high, low)


@pytest.mark.asyncio
async def test_remote_seek_ignores_tagged_file_completed_during_play(monkeypatch):
    seen = []
    async def head(request, guid, cached, byte_range):
        seen.append((guid, cached, byte_range))
        return proxy.Response(status_code=206)
    monkeypatch.setattr(proxy, "find_cache_file", lambda guid: "/newly-tagged-file.flac")
    monkeypatch.setattr(proxy, "_stream_head_response", head)
    req = playback_request("guid=online:qq:abc123:q-master&_qq_origin=remote", "bytes=1024-")
    req.scope["method"] = "HEAD"
    await proxy.stream_track(req)
    assert seen == [("online:qq:abc123:q-master", None, "bytes=1024-")]


@pytest.mark.asyncio
@pytest.mark.parametrize("quality", ["high", "balanced", "smooth", "master", "lossless", "mp3_320", "mp3_128"])
async def test_qualified_stream_keeps_quality_after_config_changes(monkeypatch, quality):
    def handler(req):
        assert req.url.params["id"] == "qq:abc123"
        assert req.url.params["quality"] == quality
        assert req.headers["range"] == "bytes=1024-1027"
        return httpx.Response(206, content=b"data", headers={"x-audio-format": "mp3"})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://musicdl")
    monkeypatch.setattr(proxy, "get_musicdl_client", lambda app: client)
    monkeypatch.setitem(proxy.CONF, "qq_quality", "mp3_128" if quality != "mp3_128" else "master")
    opened = await proxy._open_online_stream(playback_request(), f"online:qq:abc123:q-{quality}", "bytes=1024-1027")
    assert opened[-1] == b"data"
    await opened[0].aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_standard_transcode_requests_small_qq_source_and_separate_session(monkeypatch):
    from urllib.parse import parse_qs, urlsplit
    from proxy import transcode as tc
    sessions = []
    async def info(request, guid, include_lyric=True):
        assert proxy.song_id_from_online_guid(guid) == "qq:abc123"
        assert not include_lyric
        return {"duration_s": 200, "title": "Fixture"}
    async def ensure(guid, src, duration, **kwargs):
        sessions.append((guid, src))
        return tc.Session(guid, "/fake", duration, 10, 20)
    monkeypatch.setattr(proxy, "_online_info", info)
    monkeypatch.setattr(tc, "ensure_session", ensure)
    monkeypatch.setitem(proxy.CONF, "qq_quality", "master")
    await proxy._start_transcode_session(playback_request(), "online:qq:abc123")
    monkeypatch.setitem(proxy.CONF, "qq_quality", "mp3_128")
    await proxy._start_transcode_session(playback_request(), "online:qq:abc123")
    for guid, src in sessions:
        assert guid == "online:qq:abc123:q-mp3_320"
        query = parse_qs(urlsplit(src).query)
        assert query["quality"] == ["mp3_320"] and query["id"] == ["qq:abc123"]


def test_app_download_respects_standard_and_original_separately(monkeypatch):
    tasks = []
    async def produce(task, headers):
        tasks.append((task["guid"], task["quality"]))
    monkeypatch.setattr(proxy, "_dl_produce", produce)
    monkeypatch.setitem(proxy.CONF, "qq_quality", "lossless")
    monkeypatch.setitem(proxy.CONF, "dl_quality", "app")
    with TestClient(proxy.app) as client:
        for quality in ("standard", "original"):
            response = client.post("/music/api/v1/download/track/transcode/prepare", json={
                "trackGUID": "online:qq:abc123", "quality": quality})
            assert response.json()["code"] == 0
    assert tasks == [("online:qq:abc123:q-mp3_320", "standard"),
                     ("online:qq:abc123:q-lossless", "original")]


def test_standard_hls_heartbeat_and_quit_share_same_identity_after_preference_change(monkeypatch):
    from proxy import transcode as tc
    calls = []
    session = tc.Session("online:qq:abc123:q-mp3_320", "/fake", 200, 10, 20)
    def current(guid):
        calls.append(("session", guid))
        return session
    async def maintain(*args):
        pass
    async def quit_session(guid):
        calls.append(("quit", guid))
    monkeypatch.setattr(tc, "get_session", current)
    monkeypatch.setattr(tc, "heartbeat", lambda guid: calls.append(("heartbeat", guid)))
    monkeypatch.setattr(tc, "quit_session", quit_session)
    monkeypatch.setattr(tc, "maintain", maintain)
    monkeypatch.setitem(proxy.CONF, "transcode_enabled", False)
    with TestClient(proxy.app) as client:
        response = client.get("/music/api/v1/track/hls/online:qq:abc123/preset.m3u8")
        assert response.status_code == 200 and "init.mp4" in response.text and "00019.m4s" in response.text
        monkeypatch.setitem(proxy.CONF, "qq_quality", "mp3_128")
        for action in ("heartbeat", "quit"):
            assert client.post(f"/music/api/v1/track/transcode/{action}", json={
                "guid": "online:qq:abc123"}).json()["data"]["guid"] == "online:qq:abc123"
    assert calls == [("session", session.guid), ("heartbeat", session.guid), ("quit", session.guid)]


@pytest.mark.asyncio
async def test_evicted_local_bytes_do_not_fall_back_to_remote_range(monkeypatch):
    monkeypatch.setattr(proxy, "find_cache_file", lambda guid: None)
    response = await proxy.stream_track(playback_request(
        "guid=online:qq:abc123:q-master&_qq_origin=cache", "bytes=2048-"))
    assert response.status_code == 409


def test_invalid_delivery_id_fails_instead_of_redirect_loop():
    guid = "online:qq:abc123:q-invented"
    assert proxy._qq_playback_redirect(playback_request(), guid, None).status_code == 400
    assert proxy._qq_delivery_guid(guid) == guid
