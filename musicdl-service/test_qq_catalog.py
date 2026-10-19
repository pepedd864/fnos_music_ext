"""Metadata/resolve separation, bounded requests, and account isolation."""
import asyncio
import sys
import types

from fastapi import HTTPException
import pytest

from test_app_search import app_module as service, clean_state  # noqa: F401
from qq_catalog import QQCatalog, CatalogError, normalize
from qq_auth import QQAuth


ROW = {"mid": "abc123", "title": "Fixture", "album": {"mid": "album123", "title": "Album"},
       "singer": [{"name": "Singer"}], "interval": 200, "file": {"size_flac": 12345}}


def test_catalog_keeps_per_quality_sizes_without_urls_or_unavailable_files():
    item = normalize({**ROW, "file": {"size_flac": 12345, "size_128mp3": 3200,
                                      "size_320mp3": -1, "size_new": [54321]}})
    assert item["audio_variants"] == {
        "mp3_128": {"ext": "mp3", "file_size": 3200, "bitrate": 128000},
        "lossless": {"ext": "flac", "file_size": 12345, "bitrate": 0},
        "master": {"ext": "flac", "file_size": 54321, "bitrate": 0},
    }
    assert item["file_size"] == 12345 and item["resolve_on_play"]
    missing = normalize({**ROW, "file": {"size_flac": -1, "size_128mp3": -1, "size_320mp3": -1}})
    assert missing["file_size"] == 0 and missing["ext"] == "mp3" and not missing["audio_variants"]


class Model:
    def __init__(self, **data):
        self.data = data

    def model_dump(self, **kwargs):
        return self.data


@pytest.mark.asyncio
async def test_catalog_search_only_fetches_metadata_and_passes_page(tmp_path):
    calls, closed = [], []

    class Client:
        def __init__(self):
            self.search = self

        async def search_by_type(self, keyword, **kwargs):
            calls.append((keyword, kwargs))
            return Model(song=[{**ROW, "mid": f"mid{i}"} for i in range(30)])

        async def close(self):
            closed.append(True)

    catalog = QQCatalog(QQAuth(tmp_path), lambda *args, **kw: Client())
    items = await catalog.search("fixture", 30, 2)
    assert len(items) == 30
    assert calls == [("fixture", {"num": 30, "page": 2, "highlight": False})]
    assert closed == [True]
    assert all(it["resolve_on_play"] and "download_url" not in it and "verified" not in it for it in items)


@pytest.mark.asyncio
async def test_catalog_deadline_cancels_and_closes_client(tmp_path):
    closed, cancelled = [], []

    class Client:
        async def close(self):
            closed.append(True)

    catalog = QQCatalog(QQAuth(tmp_path), lambda *args, **kw: Client())

    async def never(client):
        try:
            await asyncio.sleep(20)
        finally:
            cancelled.append(True)

    with pytest.raises(CatalogError, match="超时") as error:
        await catalog._call(never, timeout=0.01)
    assert error.value.status == 504 and cancelled and closed
    assert not catalog.play_slots.locked()


@pytest.mark.asyncio
async def test_slow_search_does_not_occupy_playback_lane(tmp_path):
    catalog = QQCatalog(QQAuth(tmp_path), lambda *args, **kw: None)
    async with catalog.search_slots, catalog.search_slots:
        async def immediate(client):
            return "play"
        assert await catalog._call(immediate, timeout=0.1) == "play"


@pytest.fixture
def formats(monkeypatch):
    fake = types.ModuleType("qqmusic_api.modules.song")
    fake.SongFileType = types.SimpleNamespace(**{
        name: types.SimpleNamespace(s=prefix, e=ext)
        for name, prefix, ext in [("MASTER", "AI00", ".flac"), ("FLAC", "F000", ".flac"),
                                  ("MP3_320", "M800", ".mp3"), ("MP3_128", "M500", ".mp3")]})
    fake.SongFileInfo = lambda mid, file_type: (mid, file_type.s)
    monkeypatch.setitem(sys.modules, "qqmusic_api.modules.song", fake)


@pytest.mark.asyncio
@pytest.mark.parametrize("quality,rendition,expected", [("", None, "F000"), ("mp3", None, "M800"), ("", "M500", "M500")])
async def test_resolve_batch_quality_and_pinned_format(tmp_path, formats, quality, rendition, expected):
    calls = []

    class Client:
        def __init__(self):
            self.song = self

        async def get_song_urls(self, files):
            calls.append(files)
            return types.SimpleNamespace(expiration=3600, data=[
                types.SimpleNamespace(mid=mid, filename=f"{prefix}{mid}{'.flac' if prefix == 'F000' else '.mp3'}",
                                      purl=f"{prefix}{mid}{'.flac' if prefix == 'F000' else '.mp3'}?vkey=synthetic",
                                      result=0 if prefix != "AI00" else 104003)
                for mid, prefix in files])

        async def close(self):
            pass

    catalog = QQCatalog(QQAuth(tmp_path), lambda *args, **kw: Client())
    media = await catalog.resolve("qq:abc123", quality, rendition)
    assert len(calls) == 1 and media["rendition"] == expected and media["ttl"] <= 600
    assert all(prefix not in ("MFLAC", "TRY") for _, prefix in calls[0])


@pytest.mark.asyncio
async def test_unauthorized_or_foreign_audio_is_rejected(tmp_path, formats):
    class Client:
        def __init__(self):
            self.song = self

        async def get_song_urls(self, files):
            return types.SimpleNamespace(data=[types.SimpleNamespace(
                mid="abc123", filename="F000abc123.flac", purl="https://foreign.invalid/F000abc123.flac", result=0)])

        async def close(self):
            pass

    catalog = QQCatalog(QQAuth(tmp_path), lambda *args, **kw: Client())
    with pytest.raises(CatalogError) as error:
        await catalog.resolve("qq:abc123")
    assert error.value.status == 403


@pytest.fixture
def native(clean_state, monkeypatch, tmp_path):
    auth = QQAuth(tmp_path, on_change=service._qq_auth_changed)
    monkeypatch.setattr(service, "QQ_AUTH", auth)
    monkeypatch.setitem(service.SOURCE_NAMES, "qq", "QQMusicClient")
    monkeypatch.setitem(service.SOURCE_NAMES, "qqmusicclient", "QQMusicClient")
    calls = []

    class Catalog:
        async def search(self, keyword, limit, page=1):
            return [{**normalize(ROW), "id": f"qq:page{page}x{i}"} for i in range(limit)]

        async def resolve(self, song_id, quality="", rendition=None):
            calls.append((song_id, quality, rendition))
            await asyncio.sleep(0.02)
            return {"download_url": "https://cdn.invalid/F000fixture.flac", "ext": "flac", "rendition": "F000", "ttl": 10}

        async def info(self, song_id):
            return {**normalize(ROW), "id": song_id}

        async def lyric(self, song_id):
            return "[00:00]Fixture"

    catalog = Catalog()
    monkeypatch.setattr(service, "QQ_CATALOG", catalog)
    return auth, catalog, calls


@pytest.mark.asyncio
async def test_service_metadata_search_and_next_page_never_resolve(native, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("metadata search attempted media resolution/probe")
    monkeypatch.setattr(service, "_search_one_source", forbidden)
    monkeypatch.setattr(service, "_probe_playable_sync", forbidden)
    first = await service.search(keyword="fixture", limit=30, sources="qqmusicclient")
    second = await service.search(keyword="fixture", limit=30, sources="qq", page=2)
    cached = await service.search(keyword="fixture", limit=30, sources="qq", page=2)
    assert len(first["items"]) == len(second["items"]) == 30 and not first["errors"]
    assert first["items"][0]["id"] != second["items"][0]["id"]
    assert cached["cached"] and native[2] == []


@pytest.mark.asyncio
async def test_playback_single_flight_expiry_pin_and_mp3_cache(native):
    entries = await asyncio.gather(*[service._resolve_entry("qq:abc123") for _ in range(6)])
    assert len(native[2]) == 1 and all(e is entries[0] for e in entries)
    service._QQ_RESOLVED[("qq:abc123", "", native[0].generation)]["deadline"] = 0
    await service._resolve_entry("qq:abc123")
    assert native[2][-1] == ("qq:abc123", "", "F000")
    await service._resolve_entry("qq:abc123", quality="mp3")
    assert native[2][-1] == ("qq:abc123", "mp3", None)


@pytest.mark.asyncio
async def test_failed_playback_not_cached_or_returned_as_empty(native, monkeypatch):
    async def failed(*args):
        raise CatalogError("暂时超时", 504)
    monkeypatch.setattr(native[1], "resolve", failed)
    for _ in range(2):
        with pytest.raises(HTTPException) as error:
            await service._resolve_entry("qq:abc123")
        assert error.value.status_code == 504
    assert not service._QQ_RESOLVED


@pytest.mark.asyncio
async def test_logout_during_resolution_does_not_repopulate(native):
    task = asyncio.create_task(service._resolve_entry("qq:abc123"))
    await asyncio.sleep(0.005)
    await native[0].logout()
    with pytest.raises(HTTPException) as error:
        await task
    assert error.value.status_code == 409 and not service._QQ_RESOLVED


@pytest.mark.asyncio
async def test_cancelled_first_play_does_not_cancel_seek_resolution(native):
    first = asyncio.create_task(service._resolve_entry("qq:abc123"))
    await asyncio.sleep(0.005)
    seek = asyncio.create_task(service._resolve_entry("qq:abc123"))
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert (await seek)["item"]["ext"] == "flac" and len(native[2]) == 1
    await asyncio.sleep(0)
    assert not service._QQ_RESOLVE_TASKS


@pytest.mark.asyncio
async def test_restart_metadata_recovery_and_optional_lyrics(native):
    data = await service.info(id="qq:abc123", include_lyric=False)
    assert data["title"] == "Fixture" and data["lyric"] == "" and not native[2]
    data = await service.info(id="qq:abc123", include_lyric=True)
    assert data["lyric"] == "[00:00]Fixture" and not native[2]


@pytest.mark.asyncio
async def test_stream_passes_range_and_actual_format_without_decode_probe(native, monkeypatch):
    headers = []
    class Response:
        status_code = 206
        headers = {"Content-Type": "audio/flac", "Content-Length": "4", "Content-Range": "bytes 2-5/10"}
        def iter_content(self, *args):
            yield b"data"
        def close(self):
            pass
    async def fetch(url, request_headers):
        headers.append(request_headers)
        return Response()
    async def forbidden(*args):
        raise AssertionError("QQ playback should not run the Kuwo probe")
    monkeypatch.setattr(service, "_fetch_upstream_stream", fetch)
    monkeypatch.setattr(service, "_maybe_downgrade", forbidden)
    response = await service.stream(id="qq:abc123", proxy=True, quality="", range_header="bytes=2-5")
    assert response.status_code == 206 and response.headers["x-audio-format"] == "flac"
    assert response.headers["content-range"] == "bytes 2-5/10" and headers[0]["Range"] == "bytes=2-5"
    assert b"".join([chunk async for chunk in response.body_iterator]) == b"data"


@pytest.mark.asyncio
@pytest.mark.parametrize("quality,expected", [
    ("high", ["AI00", "F000", "M800", "M500"]),
    ("master", ["AI00", "F000", "M800", "M500"]),
    ("lossless", ["F000", "M800", "M500"]),
    ("mp3_320", ["M800", "M500"]), ("mp3_128", ["M500"]),
    ("balanced", ["F000", "M800", "M500", "AI00"]),
    ("smooth", ["M500", "M800", "F000", "AI00"]),
])
async def test_quality_preference_selects_authorized_tier_without_upgrading(tmp_path, formats, quality, expected):
    requests = []

    class Client:
        def __init__(self):
            self.song = self

        async def get_song_urls(self, files):
            requests.append([prefix for _, prefix in files])
            # Only the last eligible tier is authorized: fallback must stay
            # inside the selected ladder and require just one batch call.
            prefix = expected[-1]
            ext = ".flac" if prefix in ("AI00", "F000") else ".mp3"
            return types.SimpleNamespace(expiration=300, data=[types.SimpleNamespace(
                mid="abc123", filename=f"{prefix}abc123{ext}", purl=f"{prefix}abc123{ext}", result=0)])

        async def close(self):
            pass

    catalog = QQCatalog(QQAuth(tmp_path), lambda *a, **kw: Client())
    assert (await catalog.resolve("qq:abc123", quality))["rendition"] == expected[-1]
    assert requests == [expected]


@pytest.mark.asyncio
async def test_explicit_quality_caches_and_refresh_pins_are_independent(native):
    await asyncio.gather(service._resolve_qq("qq:abc123", "lossless"),
                         service._resolve_qq("qq:abc123", "mp3_128"))
    assert len(native[2]) == 2
    await service._resolve_qq("qq:abc123", "lossless")
    assert len(native[2]) == 2
    await service._resolve_qq("qq:abc123", "mp3_128", force=True)
    assert native[2][-1] == ("qq:abc123", "mp3_128", "F000")
    with pytest.raises(HTTPException) as error:
        await service._resolve_qq("qq:abc123", "invented")
    assert error.value.status_code == 400 and len(native[2]) == 3


@pytest.mark.asyncio
async def test_quality_metadata_does_not_resolve_and_reports_selected_audio(native):
    data = await service.info(id="qq:abc123", include_lyric=False, quality="mp3_128")
    assert data["ext"] == "mp3" and not native[2]
    assert data["audio_variants"]["lossless"]["file_size"] == 12345
    await service._resolve_qq("qq:abc123", "lossless")
    data = await service.info(id="qq:abc123", include_lyric=False, quality="lossless")
    assert data["ext"] == "flac" and data["audio_quality"] == "lossless"
    assert data["title"] == "Fixture" and len(native[2]) == 1
