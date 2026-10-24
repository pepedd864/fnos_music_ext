"""Account lifecycle, private persistence and hostile upstream responses."""
import asyncio
import json
from pathlib import Path
import stat
import sys
import time
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qq_auth import QQAuth, AuthError  # noqa: E402


# Synthetic fixtures only; these cannot authenticate to any service.
CREDENTIAL = {"musicid": 12345678, "musickey": "synthetic-test-only",
              "loginType": 2, "refresh_token": "synthetic-refresh-only",
              "musickeyCreateTime": 1, "keyExpiresIn": 9999999999}


class FakeClient:
    def __init__(self, directory):
        self.closed = False
        self.events = [("scan", None), ("conf", None), ("done", CREDENTIAL)]

    async def qr(self, kind):
        return SimpleNamespace(data=b"synthetic-png", mimetype="image/png")

    async def check(self, qr):
        return self.events.pop(0)

    async def verify(self, data):
        return data

    async def close(self):
        self.closed = True


@pytest.fixture
def auth(tmp_path):
    clients, changes = [], []

    def factory(directory):
        client = FakeClient(directory)
        clients.append(client)
        return client

    obj = QQAuth(tmp_path / "qq", factory, lambda: changes.append(True))
    obj.clients, obj.changes = clients, changes
    return obj


@pytest.mark.asyncio
async def test_qr_lifecycle_persists_private_credentials(auth):
    start = await auth.start()
    assert start["image"].startswith("data:image/png;base64,")
    assert "synthetic-test-only" not in json.dumps(start)
    sid = start["session_id"]
    for state in ("scan", "conf", "done"):
        auth._session["last"] = 0
        assert await auth.check(sid) == {"state": state}
    assert auth.clients[0].closed
    assert auth.status()["account"] == "****5678"
    assert auth.status()["logged_in"]
    assert "synthetic" not in json.dumps(auth.status())
    assert stat.S_IMODE(auth.path.stat().st_mode) == 0o600
    assert stat.S_IMODE(auth.directory.stat().st_mode) == 0o700
    restored = QQAuth(auth.directory)
    assert restored.cookies()["musicid"] == "12345678"
    assert restored.cookies()["loginType"] == "2"
    assert set(restored.cookies()) == {"musicid", "musickey", "loginType"}
    assert auth.changes == [True]
    await auth.close()


@pytest.mark.asyncio
async def test_replacing_qr_logout_and_late_poll_cannot_restore_login(auth):
    first = await auth.start()
    second = await auth.start("wx")
    assert auth.clients[0].closed
    assert (await auth.check(first["session_id"]))["state"] == "timeout"
    auth._save(CREDENTIAL)
    await auth.logout()
    assert auth.clients[-1].closed
    assert not auth.path.exists()
    assert auth.cookies() == {}
    assert (await auth.check(second["session_id"]))["state"] == "timeout"
    assert not auth.status()["configured"]


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["timeout", "refuse"])
async def test_terminal_events_close_client_without_saving(auth, state):
    start = await auth.start()
    auth.clients[-1].events = [(state, None)]
    assert await auth.check(start["session_id"]) == {"state": state}
    assert auth.clients[-1].closed
    assert not auth.path.exists()


@pytest.mark.asyncio
async def test_expiration_throttle_and_invalid_session(auth):
    start = await auth.start()
    sid = start["session_id"]
    assert await auth.check("unknown") == {"state": "timeout"}
    await auth.check(sid)
    await auth.check(sid)  # second check is local; do not hammer QQ
    assert len(auth.clients[-1].events) == 2
    auth._session["deadline"] = time.monotonic() - 1
    assert await auth.check(sid) == {"state": "timeout"}
    assert auth.clients[-1].closed


@pytest.mark.asyncio
async def test_invalid_account_survives_restart_and_blocks_anonymous_fallback(auth):
    auth._save(CREDENTIAL)

    async def expired(self, data):
        return None

    auth.client_factory = lambda directory: SimpleNamespace(verify=lambda data: expired(None, data), close=lambda: asyncio.sleep(0))
    status = await auth.verify()
    assert status["state"] == "expired" and status["verified"] is False
    restored = QQAuth(auth.directory)
    with pytest.raises(AuthError, match="过期"):
        restored.cookies()
    await auth.logout()
    assert not auth.path.exists()


@pytest.mark.asyncio
async def test_transient_verification_error_preserves_credentials_and_redacts(auth):
    auth._save(CREDENTIAL)

    async def broken(data):
        raise RuntimeError("musickey=synthetic-test-only OAuth redirect sensitive")

    auth.client_factory = lambda directory: SimpleNamespace(verify=broken, close=lambda: asyncio.sleep(0))
    with pytest.raises(AuthError) as error:
        await auth.verify()
    assert "synthetic" not in str(error.value)
    assert auth.cookies()["musickey"] == CREDENTIAL["musickey"]


@pytest.mark.asyncio
async def test_bad_credentials_or_storage_failure_do_not_report_success(auth, monkeypatch):
    start = await auth.start()
    auth.clients[-1].events = [("done", {})]
    with pytest.raises(AuthError):
        await auth.check(start["session_id"])
    assert not auth.status()["configured"]
    auth._session["last"] = 0
    auth.clients[-1].events = [("done", CREDENTIAL)]

    def fail(*args):
        raise OSError("disk unavailable")

    monkeypatch.setattr("qq_auth.os.replace", fail)
    with pytest.raises(AuthError):
        await auth.check(start["session_id"])
    assert not auth.status()["configured"]
    assert list(auth.directory.glob(".credential-*")) == []
    await auth.close()


def test_corrupt_file_and_expired_credentials(tmp_path):
    directory = tmp_path / "qq"
    directory.mkdir()
    (directory / "credential.json").write_text('{"broken":true}')
    auth = QQAuth(directory)
    assert auth.cookies() == {}
    auth._save({**CREDENTIAL, "keyExpiresIn": 1})
    assert auth.status()["state"] == "expired"
    with pytest.raises(AuthError):
        auth.cookies()
