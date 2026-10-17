"""QQ QR login and private credential storage. No credentials in public responses.

The optional SDK is imported only when logging in/verifying. musicdl receives a
snapshot of the saved cookies; it never owns or serializes the login session.
"""
import asyncio
import base64
from contextlib import suppress
import json
import logging
import os
from pathlib import Path
import secrets
import tempfile
import threading
import time


class AuthError(Exception):
    """Safe, user-facing error (never an upstream exception string)."""


class SDKClient:
    def __init__(self, directory):
        # OAuth redirects carry short-lived login tickets in their URL. httpx
        # logs full URLs at INFO, and transport DEBUG logs can include headers.
        for name in ("httpx", "httpcore", "qqmusicapi"):
            logging.getLogger(name).setLevel(logging.WARNING)
        from qqmusic_api import Client
        self.client = Client(device_path=str(directory / "device.json"))

    async def qr(self, kind):
        from qqmusic_api.models.login import QRLoginType
        return await self.client.login.get_qrcode(QRLoginType(kind))

    async def check(self, qr):
        result = await self.client.login.check_qrcode(qr)
        return result.event.name.lower(), (
            result.credential.model_dump(by_alias=True) if result.credential else None
        )

    async def verify(self, data):
        from qqmusic_api import Credential
        from qqmusic_api.core.exceptions import LoginCredentialExpiredError, LoginAuthFailedError, LoginExpiredError
        credential = Credential.model_validate(data)
        if not await self.client.login.check_expired(credential):
            return data
        try:
            return (await self.client.login.refresh_credential(credential)).model_dump(by_alias=True)
        except (LoginCredentialExpiredError, LoginAuthFailedError, LoginExpiredError):
            return None

    async def close(self):
        await self.client.close()


class QQAuth:
    def __init__(self, directory=None, client_factory=SDKClient, on_change=lambda: None):
        self.directory = Path(directory or Path(os.environ.get("XDG_DATA_HOME", "/data")) / "qqmusic")
        self.path = self.directory / "credential.json"
        self.client_factory = client_factory
        self.on_change = on_change
        self._lock = asyncio.Lock()
        self._data_lock = threading.RLock()
        self._data = None
        self._invalid = False
        self._generation = 0
        self._session = None
        self._expiry_task = None
        self._load()

    @staticmethod
    def _valid(data):
        return (isinstance(data, dict) and str(data.get("musicid", "")).isdigit()
                and int(data["musicid"]) > 0 and isinstance(data.get("musickey"), str)
                and bool(data["musickey"]))

    def _load(self):
        try:
            data = json.loads(self.path.read_text())
            if isinstance(data, dict) and self._valid(data.get("credential")):
                self._data = data["credential"]
                self._invalid = bool(data.get("invalid"))
                os.chmod(self.directory, 0o700)
                os.chmod(self.path, 0o600)
        except (OSError, ValueError, TypeError):
            pass

    def _private_dir(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)

    def _save(self, data, invalid=False):
        if not self._valid(data):
            raise AuthError("登录结果缺少有效凭据，请重新扫码")
        self._private_dir()
        fd, name = tempfile.mkstemp(prefix=".credential-", dir=self.directory)
        try:
            with os.fdopen(fd, "w") as file:
                json.dump({"credential": data, "invalid": invalid}, file)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)
        finally:
            with suppress(FileNotFoundError):
                os.unlink(name)
        with self._data_lock:
            self._data = dict(data)
            self._invalid = invalid
            self._generation += 1
        self.on_change()

    @property
    def generation(self):
        with self._data_lock:
            return self._generation

    def status(self):
        with self._data_lock:
            data = self._data or {}
            created = int(data.get("musickeyCreateTime") or 0)
            lifetime = int(data.get("keyExpiresIn") or 0)
            expires = created + lifetime if created and lifetime else None
            expired = self._invalid or bool(expires and time.time() >= expires)
            uid = str(data.get("musicid") or "")
            return {"configured": bool(data), "logged_in": bool(data) and not expired,
                    "state": "expired" if data and expired else "stored" if data else "anonymous",
                    "account": ("****" + uid[-4:]) if uid else "", "expires_at": expires}

    def cookies(self):
        with self._data_lock:
            if self._data and not self.status()["logged_in"]:
                raise AuthError("QQ 音乐登录已过期，请在管理页验证/刷新或重新扫码")
            # requests cookie values must be strings. musicdl parses musicid
            # itself and accepts string loginType in its request builder.
            if not self._data:
                return {}
            data = self._data
            return {"musicid": str(data["musicid"]), "musickey": data["musickey"],
                    "loginType": str(data.get("loginType") or (1 if data["musickey"].startswith("W_X") else 2))}

    async def _end_session(self):
        if self._expiry_task and self._expiry_task is not asyncio.current_task():
            self._expiry_task.cancel()
        self._expiry_task = None
        session, self._session = self._session, None
        if session:
            with suppress(Exception):
                await session["client"].close()

    async def _expire(self, session_id):
        await asyncio.sleep(180)
        async with self._lock:
            if self._session and self._session["id"] == session_id:
                await self._end_session()

    async def start(self, kind="qq"):
        if kind not in ("qq", "wx"):
            raise AuthError("请选择 QQ 或微信扫码")
        async with self._lock:
            await self._end_session()
            client = None
            try:
                self._private_dir()
                client = self.client_factory(self.directory)
                qr = await asyncio.wait_for(client.qr(kind), 20)
                if not qr.data or qr.mimetype not in ("image/png", "image/jpeg"):
                    raise ValueError("invalid QR image")
                sid = secrets.token_urlsafe(24)
                self._session = {"id": sid, "client": client, "qr": qr,
                                 "deadline": time.monotonic() + 180, "last": 0.0, "state": "scan"}
                self._expiry_task = asyncio.create_task(self._expire(sid))
                return {"session_id": sid, "image": "data:" + qr.mimetype + ";base64," + base64.b64encode(qr.data).decode(),
                        "state": "scan", "expires_in": 180}
            except ImportError:
                if client:
                    await client.close()
                raise AuthError("缺少 QQ 登录依赖，请更新音源运行环境") from None
            except Exception:
                if client:
                    with suppress(Exception):
                        await client.close()
                raise AuthError("生成二维码失败，请检查 NAS 到 QQ 登录服务的网络后重试") from None

    async def check(self, session_id):
        async with self._lock:
            session = self._session
            if not session or not secrets.compare_digest(session["id"], session_id):
                return {"state": "timeout"}
            if time.monotonic() >= session["deadline"]:
                await self._end_session()
                return {"state": "timeout"}
            if time.monotonic() - session["last"] < 1.5:
                return {"state": session["state"]}
            session["last"] = time.monotonic()
            try:
                state, credential = await asyncio.wait_for(session["client"].check(session["qr"]), 20)
                if state == "done":
                    self._save(credential)
                elif state not in ("scan", "conf", "timeout", "refuse"):
                    raise ValueError("unknown QR state")
            except Exception:
                # SDK exceptions may contain OAuth redirects/keys. Do not log
                # or expose their strings, response bodies or traceback.
                raise AuthError("登录检查失败，请稍后重试；若账号要求验证，请在手机端完成") from None
            session["state"] = state
            if state in ("done", "timeout", "refuse"):
                await self._end_session()
            return {"state": state}

    async def verify(self):
        async with self._lock:
            if not self._data:
                return self.status()
            client = None
            try:
                self._private_dir()
                client = self.client_factory(self.directory)
                data = await asyncio.wait_for(client.verify(dict(self._data)), 25)
                if data is None:
                    self._save(self._data, invalid=True)
                else:
                    self._save(data)
            except Exception:
                raise AuthError("QQ 账号验证暂时失败，请稍后重试；已保存的凭据未删除") from None
            finally:
                if client:
                    with suppress(Exception):
                        await client.close()
            return {**self.status(), "verified": data is not None}

    async def logout(self):
        async with self._lock:
            await self._end_session()
            with suppress(FileNotFoundError):
                self.path.unlink()
            with self._data_lock:
                self._data = None
                self._invalid = False
                self._generation += 1
            self.on_change()
            return self.status()

    async def close(self):
        async with self._lock:
            await self._end_session()
