"""Platform adapters and bounded native roam queues with stable relative cursors."""
import asyncio
from dataclasses import dataclass, field
import time
from uuid import uuid4

import httpx


class RoamError(Exception):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class RoamSource:
    name: str
    session_path: str
    recommend_path: str
    engine: str = 'musicdl'

    async def _get(self, client, path, params=None):
        try:
            response = await client.get(path, params=params, timeout=15 if params else 8)
            if response.status_code in (401, 403):
                # A platform login failure must not look like fnOS session expiry.
                raise RoamError(f'{self.name}登录不可用，请在音乐平台中验证或重新登录')
            if response.status_code == 409:
                raise RoamError(f'{self.name}账号已改变，请重新开始漫游', 409)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict) or data.get('ok') is not True:
                raise ValueError('Invalid recommendation response')
            return data
        except (httpx.HTTPError, ValueError, TypeError):
            raise RoamError(f'{self.name}推荐暂时不可用，请稍后重试') from None

    async def scope(self, client):
        value = (await self._get(client, self.session_path)).get('scope')
        if not isinstance(value, str) or not value or len(value) > 256:
            raise RoamError(f'{self.name}推荐会话无效，请重新登录')
        return value

    async def fetch(self, client, cursor):
        return await self._get(client, self.recommend_path, {'cursor': cursor})


ROAM_SOURCES = {
    'qq': RoamSource('QQ 音乐', '/recommend/qq/session', '/recommend/qq'),
    'kugou': RoamSource('酷狗音乐', '/catalog/kugou/session', '/catalog/kugou/recommend'),
    'kuwo': RoamSource('酷我音乐', '/catalog/kuwo/session', '/catalog/kuwo/recommend'),
    'netease': RoamSource('网易云音乐', '/api/v1/catalog/session', '/api/v1/catalog/recommend', 'musicbox'),
}


@dataclass
class Session:
    scope: str
    platform: str = 'qq'
    owner: str = ""
    touched: float = field(default_factory=time.monotonic)
    created: float = field(default_factory=time.monotonic)
    entries: list = field(default_factory=list)
    seen: set = field(default_factory=set)
    cursor: int = 0
    exhausted: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    task: asyncio.Task | None = None


class RoamQueues:
    def __init__(self, max_sessions=64, ttl=6 * 3600):
        self.sessions = {}
        self.tasks = set()
        self.max_sessions, self.ttl = max_sessions, ttl

    def _drop(self, key):
        session = self.sessions.pop(key, None)
        if session and session.task and not session.task.done():
            session.task.cancel()

    def _clean(self):
        now = time.monotonic()
        for key, session in list(self.sessions.items()):
            if now - session.touched > self.ttl:
                self._drop(key)

    async def _fill(self, session, index, fetch):
        # An empty/repeating upstream must never create an unbounded request loop.
        for _ in range(3):
            if len(session.entries) > index or session.exhausted:
                return
            batch = await fetch(session.cursor)
            if batch.get("scope") != session.scope:
                raise RoamError("登录已改变，请重新开始漫游", 409)
            cursor = batch.get("next_cursor")
            if not isinstance(cursor, int) or cursor <= session.cursor:
                raise RoamError("推荐游标无效，请重新开始漫游")
            session.cursor = cursor
            session.exhausted = not batch.get("has_more", False)
            for item in batch.get("items", [])[:100]:
                if not isinstance(item, dict):
                    continue
                guid = str(item.get("id") or "")
                if (not guid.startswith(session.platform + ':') or item.get('source') != session.platform
                        or guid in session.seen):
                    continue
                session.seen.add(guid)
                session.entries.append({"roamId": uuid4().hex, "item": item, "createdAt": int(time.time())})
            # Deduplication spans a bounded session; restart for a new stream.
            if len(session.seen) >= 2048:
                session.exhausted = True

    async def _prefetch(self, session, fetch):
        try:
            async with session.lock:
                await self._fill(session, len(session.entries) + 3, fetch)
        except (Exception, asyncio.CancelledError):
            # The foreground request retries the same uncommitted batch cursor.
            pass

    def _schedule(self, session, index, fetch):
        if not session.exhausted and len(session.entries) - index <= 6:
            if session.task is None or session.task.done():
                session.task = asyncio.create_task(self._prefetch(session, fetch))
                self.tasks.add(session.task)
                session.task.add_done_callback(self.tasks.discard)

    @staticmethod
    def _view(session, index, build):
        def node(at):
            if at < 0 or at >= len(session.entries):
                return None
            entry = session.entries[at]
            # Native roam's adapter calls Date(...).toISOString() unconditionally.
            track = {**build(entry["item"]), "createdAt": entry["createdAt"], "updatedAt": entry["createdAt"]}
            return {"track": track, "roamId": entry["roamId"]}
        return {"current": node(index), "next": node(index + 1), "previous": node(index - 1)}

    def retained(self, owner, guid):
        """Metadata for playback/history, visible only to the requesting credentials."""
        self._clean()
        song_id = guid.removeprefix("online:")
        for session in self.sessions.values():
            if owner and session.owner == owner:
                for entry in session.entries:
                    if entry["item"].get("id") == song_id:
                        return dict(entry["item"])
        return None

    async def request(self, key, scope, action, relative_id, fetch, build, owner="", platform='qq'):
        self._clean()
        session = self.sessions.get(key)
        if action == "start":
            # Native clients may retry start before its first response arrives.
            if not session or session.scope != scope or session.platform != platform or time.monotonic() - session.created > 2:
                self._drop(key)
                if len(self.sessions) >= self.max_sessions:
                    self._drop(min(self.sessions, key=lambda k: self.sessions[k].touched))
                session = Session(scope, platform=platform, owner=owner)
                self.sessions[key] = session
        elif not session or session.scope != scope or session.platform != platform:
            self._drop(key)
            raise RoamError("漫游会话已失效，请重新点击漫游", 409)
        session.touched = time.monotonic()
        session.owner = owner
        async with session.lock:
            if action == "start":
                index = 0
            else:
                position = next((i for i, entry in enumerate(session.entries)
                                 if entry["roamId"] == relative_id), None)
                if position is None:
                    raise RoamError("漫游位置已失效，请重新点击漫游", 409)
                index = max(0, position + (1 if action == "next" else -1))
            await self._fill(session, index + 1, fetch)
            if index >= len(session.entries):
                raise RoamError("暂时没有新的推荐歌曲，请稍后重新开始漫游")
            # Keep recent back-navigation while bounding long-running queues.
            if index > 128:
                trim = index - 128
                del session.entries[:trim]
                index -= trim
            result = self._view(session, index, build)
            self._schedule(session, index, fetch)
            return result

    async def close(self):
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.sessions.clear()
