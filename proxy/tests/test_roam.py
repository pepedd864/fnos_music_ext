"""Native roam contract, stable navigation and private bounded QQ queues."""
import asyncio
import httpx
import pytest
from fastapi.testclient import TestClient

from proxy import app as proxy
from proxy.roam import RoamQueues, RoamError


def item(index):
    return {"id": f"qq:mid{index}", "source": "qq", "title": f"Song {index}",
            "artist": "Artist", "album": "Album", "duration_s": 200, "ext": "mp3",
            "audio_variants": {"mp3_128": {"file_size": 3200000, "ext": "mp3", "bitrate": 128000}}}


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    state = {"scope": "account-a", "logged_in": True, "calls": []}
    def upstream(request):
        if request.url.path.endswith("/user/me"):
            if request.headers.get("authorization") == "unauthorized":
                return httpx.Response(401, json={"code": 401})
            return httpx.Response(200, json={"code": 0, "data": {"guid": request.headers.get("authorization", "user-a")}})
        return httpx.Response(200, json={"code": 0, "data": {"native": True}})
    def source(request):
        state["calls"].append(str(request.url.path))
        if request.url.path == "/recommend/qq/session":
            return httpx.Response(200 if state["logged_in"] else 401,
                                  json={"scope": state["scope"]})
        assert request.url.path == "/recommend/qq", "Roam must never batch-resolve media or lyrics"
        cursor = int(request.url.params["cursor"])
        indices = range(5) if cursor == 0 else range(cursor * 9 - 5, cursor * 9 + 5)
        return httpx.Response(200, json={"ok": True, "scope": state["scope"],
            "items": [item(i) for i in indices], "next_cursor": cursor + 1, "has_more": True})
    monkeypatch.setattr(proxy, "QQ_ROAM", RoamQueues())
    monkeypatch.setitem(proxy.CONF, "roam_source", "qq")
    monkeypatch.setitem(proxy.CONF, "qq_quality", "mp3_128")
    monkeypatch.setitem(proxy.CONF, "musicdl_enabled", True)
    monkeypatch.setenv("FNMUSIC_PLAY_HISTORY_DIR", str(tmp_path / "history"))
    monkeypatch.setitem(proxy.CONF, "fav_dir", str(tmp_path / "favorites"))
    monkeypatch.setattr(proxy.app.state, "upstream_client",
        httpx.AsyncClient(transport=httpx.MockTransport(upstream), base_url="http://unix"), raising=False)
    monkeypatch.setattr(proxy.app.state, "musicdl_client",
        httpx.AsyncClient(transport=httpx.MockTransport(source), base_url="http://source"), raising=False)
    with TestClient(proxy.app) as client:
        yield client, state


def request(client, action, relative=None, device="device-a", user="user-a"):
    params = {"deviceId": device}
    if relative:
        params["relativeRoamId"] = relative
    return client.get("/music/api/v1/track/roam-" + action, params=params, headers={"authorization": user})


def test_native_contract_navigation_dedupe_and_128k(runtime):
    client, state = runtime
    start = request(client, "start").json()["data"]
    assert start["previous"] is None and start["current"] and start["next"]
    first = start["current"]
    assert isinstance(first["track"]["createdAt"], int) and first["track"]["createdAt"] > 0
    assert first["track"]["updatedAt"] == first["track"]["createdAt"]
    assert len(first["track"]["guid"]) == 32
    assert first["track"]["audioSpec"]["format"] == "mp3"
    assert first["track"]["audioSpec"]["bitrate"] == 128000
    assert first["track"]["audioSpec"]["size"] == 3200000
    seen = [first["track"]["guid"]]
    current = first
    for _ in range(18):
        data = request(client, "next", current["roamId"]).json()["data"]
        assert data["previous"] == current
        # Retried/prefetched requests relative to the same node never skip songs.
        assert request(client, "next", current["roamId"]).json()["data"] == data
        assert request(client, "previous", data["current"]["roamId"]).json()["data"]["current"] == current
        current = data["current"]
        seen.append(current["track"]["guid"])
    assert len(set(seen)) == len(seen)
    assert set(state["calls"]) == {"/recommend/qq", "/recommend/qq/session"}


def test_sessions_cannot_be_reused_by_another_user_or_device(runtime):
    client, _ = runtime
    current = request(client, "start").json()["data"]["current"]
    assert request(client, "next", current["roamId"], user="user-b").status_code == 409
    assert request(client, "next", current["roamId"], device="device-b").status_code == 409
    assert request(client, "start", user="unauthorized").status_code == 401


def test_native_play_events_keep_roam_title_artist_album_and_duration(runtime):
    client, state = runtime
    track = request(client, "start").json()["data"]["current"]["track"]
    response = client.post("/music/api/v1/event/report", headers={"authorization": "user-a"}, json={
        "events": [{"eventType": "track_play", "payload": {"trackGUID": track["guid"]}}]})
    assert response.json()["code"] == 0
    rows = proxy.dailyrec.load_online_play_history("user-a")
    assert len(rows) == 1
    assert rows[0]["track"]["title"] == "Song 0"
    assert rows[0]["track"]["artist"] == "Artist"
    assert rows[0]["track"]["album"] == "Album"
    assert rows[0]["track"]["duration_s"] == 200
    from starlette.requests import Request
    foreign = Request({"type": "http", "headers": [(b"authorization", b"user-b")]})
    assert proxy.QQ_ROAM.retained(proxy._credential_scope(foreign), "online:qq:mid0") is None


def test_qq_logout_and_account_change_do_not_serve_stale_queue(runtime):
    client, state = runtime
    current = request(client, "start").json()["data"]["current"]
    state["logged_in"] = False
    assert request(client, "next", current["roamId"]).status_code == 503
    state.update(logged_in=True, scope="account-b")
    assert request(client, "next", current["roamId"]).status_code == 409
    assert request(client, "start").json()["code"] == 0


def test_local_mode_passthrough_and_invalid_config(runtime, monkeypatch):
    client, state = runtime
    assert request(client, "next", "unknown").status_code == 400
    monkeypatch.setitem(proxy.CONF, "roam_source", "local")
    assert request(client, "start").json()["data"] == {"native": True}
    assert not state["calls"]
    assert proxy._env_watch_parse("qq", "roam_source") == "qq"
    assert proxy._env_watch_parse("unknown", "roam_source") is None


@pytest.mark.asyncio
async def test_concurrent_next_is_stable_and_empty_batches_are_bounded():
    queues, calls = RoamQueues(max_sessions=1), []
    async def fetch(cursor):
        calls.append(cursor)
        await asyncio.sleep(0)
        return {"scope": "account", "items": [item(i) for i in range(10)],
                "next_cursor": cursor + 1, "has_more": True}
    try:
        start = await queues.request("a", "account", "start", "", fetch, lambda i: i)
        relative = start["current"]["roamId"]
        a, b = await asyncio.gather(*[queues.request("a", "account", "next", relative, fetch, lambda i: i)
                                     for _ in range(2)])
        assert a == b
        session = queues.sessions["a"]
        await queues._fill(session, 99, fetch)
        assert len(calls) == 4 and len(session.entries) == 10
        await queues.request("b", "account", "start", "", fetch, lambda i: i)
        assert set(queues.sessions) == {"b"}
        with pytest.raises(RoamError):
            await queues.request("a", "account", "next", relative, fetch, lambda i: i)
    finally:
        await queues.close()


@pytest.mark.asyncio
async def test_timeout_retries_same_cursor_and_account_switch_during_fetch():
    queues, attempts = RoamQueues(), []
    async def fetch(cursor):
        attempts.append(cursor)
        if len(attempts) == 1:
            raise RoamError("temporary")
        return {"scope": "other-account", "items": [item(1)], "next_cursor": 1, "has_more": False}
    try:
        with pytest.raises(RoamError, match="temporary"):
            await queues.request("a", "account", "start", "", fetch, lambda i: i)
        with pytest.raises(RoamError, match="登录已改变"):
            await queues.request("a", "account", "start", "", fetch, lambda i: i)
        assert attempts == [0, 0] and not queues.sessions["a"].entries
    finally:
        await queues.close()
