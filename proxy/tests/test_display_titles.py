"""Old saved QQ tracks have clean native titles without changing media identity."""
import copy

import httpx
from fastapi.testclient import TestClient

from proxy import app as proxy


def track():
    return {"guid": "a" * 32, "title": "偏向 (Live) [QQ-128k]", "artists": [],
            "audioSpec": {"path": "/music/陈子晴 - 偏向 (Live) [QQ-128k].mp3",
                          "format": "mp3", "size": 3210000, "bitrate": 128000}}


def test_native_local_list_and_history_hide_quality_suffix(monkeypatch, tmp_path):
    original = {"code": 0, "data": {"list": [track()], "total": 1}}
    def upstream(request):
        if request.url.path.endswith("/user/me"):
            return httpx.Response(401, json={"code": 401})
        return httpx.Response(200, json=original, headers={"etag": "old-title"})
    monkeypatch.setattr(proxy.app.state, "upstream_client", httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), base_url="http://unix"), raising=False)
    with TestClient(proxy.app) as client:
        for path in ("/music/api/v1/track/list", "/music/api/v1/play-history/list"):
            response = client.get(path)
            received = response.json()["data"]["list"][0]
            assert received["title"] == "偏向 (Live)"
            assert received["guid"] == original["data"]["list"][0]["guid"]
            assert received["audioSpec"] == original["data"]["list"][0]["audioSpec"]
            assert int(response.headers["content-length"]) == len(response.content)
    assert original["data"]["list"][0]["title"] == "偏向 (Live) [QQ-128k]"


def test_online_history_and_playlist_tracks_preserve_versions_and_quality_identity():
    saved = track()
    saved.update(guid="online:qq:mid:q-mp3_128", title="Song (Remastered) [QQ-320k]")
    payload = {"title": "My playlist [QQ-128k]", "list": [saved, {**track(), "title": "Song [QQ-Live]"}]}
    before = copy.deepcopy(payload)
    result = proxy.disguise_client_json(payload)
    assert result["title"] == payload["title"]
    assert result["list"][0]["title"] == "Song (Remastered)"
    assert result["list"][0]["guid"] == proxy.fake_official_guid("online:qq:mid:q-mp3_128")
    assert result["list"][0]["audioSpec"] == saved["audioSpec"]
    assert result["list"][1]["title"] == "Song [QQ-Live]"
    assert payload == before
