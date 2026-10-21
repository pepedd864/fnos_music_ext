"""Platform adapters for the management console; engine details stay behind this API."""
from dataclasses import dataclass
import asyncio
import re

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse


@dataclass(frozen=True)
class PlatformAdapter:
    id: str
    name: str
    source: str
    short: str
    login: bool = False
    recommend: bool = False
    qualities: tuple = ('original',)

    def public(self):
        return {'id': self.id, 'name': self.name, 'logo': f'/app/fnmusic-ext/static/console/platforms/{self.id}.jpg',
                'capabilities': {'search': True, 'login': self.login, 'recommend': self.recommend,
                                 'qualities': list(self.qualities)}}

    def normalize(self, row):
        if not isinstance(row, dict) or not str(row.get('id', '')).startswith(self.short + ':'):
            return None
        # Signed download locations, request headers and cookies never cross this boundary.
        return {**{k: row.get(k) for k in ('id', 'title', 'artist', 'album', 'duration_s', 'cover_url')}, 'platform': self.id}


ADAPTERS = {p.id: p for p in (
    PlatformAdapter('qq', 'QQ 音乐', 'QQMusicClient', 'qq', True, True, ('mp3_128', 'mp3_320', 'lossless')),
    PlatformAdapter('kugou', '酷狗音乐', 'KugouMusicClient', 'kugou'),
    PlatformAdapter('kuwo', '酷我音乐', 'KuwoMusicClient', 'kuwo'),
)}


def source_list(values):
    raw = values.get('FNMUSIC_ONLINE_SOURCES') or values.get('MUSICDL_SOURCES') or 'KuwoMusicClient,MiguMusicClient'
    return [s.strip() for s in raw.split(',') if s.strip()]


def install_console_api(app, service):
    locks = {p: asyncio.Lock() for p in ADAPTERS}
    config_lock = asyncio.Lock()

    def adapter(pid):
        if pid not in ADAPTERS:
            raise HTTPException(404, '未知音乐平台')
        return ADAPTERS[pid]

    def enabled(p):
        return any(s in {p.source, p.short, p.id} for s in source_list(service.read_env()))

    async def upstream(request, path, params=None, timeout=20):
        try:
            response = await service.get_http(request).get(service.CONF['musicdl_url'] + path, params=params, timeout=httpx.Timeout(timeout, connect=3))
        except httpx.HTTPError:
            raise HTTPException(503, '音乐服务暂时无法连接，请在高级设置检查音源运行状态') from None
        if response.status_code != 200:
            # Source services already sanitize auth failures. Never forward URLs/tracebacks.
            if response.status_code == 401:
                raise HTTPException(401, '账号已过期，请验证或重新登录')
            raise HTTPException(response.status_code, '平台请求未完成，请稍后重试或验证账号')
        try:
            return response.json()
        except ValueError:
            raise HTTPException(502, '平台响应格式异常') from None

    @app.get('/api/console/platforms')
    async def platforms(request: Request):
        values = service.read_env()
        auth = {'state': 'unavailable', 'logged_in': False, 'account': ''}
        try:
            auth = await upstream(request, '/auth/qq/status', timeout=5)
        except HTTPException:
            pass
        items = []
        for p in ADAPTERS.values():
            status = '已登录' if p.id == 'qq' and auth.get('logged_in') else '登录已过期' if p.id == 'qq' and auth.get('state') == 'expired' else '暂时无法连接' if p.id == 'qq' and auth.get('state') == 'unavailable' else '待登录'
            items.append({**p.public(), 'enabled': enabled(p), 'status': status,
                          'auth': {k: auth.get(k) for k in ('state', 'logged_in', 'account', 'expires_at')} if p.id == 'qq' else {'state': 'unsupported', 'logged_in': False}})
        return JSONResponse({'ok': True, 'items': items, 'quality': values.get('FNMUSIC_QQ_QUALITY') or 'mp3_128'}, headers={'Cache-Control': 'no-store'})

    @app.put('/api/console/platforms/{pid}')
    async def platform_toggle(pid: str, request: Request):
        p = adapter(pid)
        body = await request.json()
        if type(body.get('enabled')) is not bool:
            raise HTTPException(400, 'enabled 必须为布尔值')
        async with config_lock:
            sources = [s for s in source_list(service.read_env()) if s not in {p.source, p.short, p.id}]
            if body['enabled']:
                sources.append(p.source)
            if not sources:
                raise HTTPException(400, '请至少保留一个启用的音乐平台')
            # Native proxy hot-reloads its selection. Console searches always pass
            # explicit sources, so existing streams/QQ QR sessions need no restart.
            service.write_env({'FNMUSIC_ONLINE_SOURCES': ','.join(dict.fromkeys(sources)), 'MUSICDL_SOURCES': ','.join(dict.fromkeys(sources))})
        return {'ok': True}

    @app.get('/api/console/platforms/{pid}/search')
    async def platform_search(pid: str, request: Request):
        p = adapter(pid)
        if not enabled(p):
            raise HTTPException(409, '请先启用该平台')
        keyword = str(request.query_params.get('q') or '').strip()
        if not keyword or len(keyword) > 200:
            raise HTTPException(400, '请输入 1 至 200 字的搜索词')
        rawpage = str(request.query_params.get('page') or '1')
        if not re.fullmatch(r'\d{1,3}', rawpage) or not 1 <= int(rawpage) <= 100:
            raise HTTPException(400, '页码无效')
        page = int(rawpage)
        if pid != 'qq' and page != 1:
            raise HTTPException(400, '该平台暂不支持翻页')
        if locks[pid].locked():
            raise HTTPException(429, '该平台正在处理请求，请稍候')
        async with locks[pid]:
            data = await upstream(request, '/search', {'keyword': keyword, 'sources': p.source, 'limit': 20, 'page': page}, timeout=30)
        items = [item for row in data.get('items', []) if (item := p.normalize(row))]
        error = bool(data.get('errors'))
        return {'ok': True, 'items': items, 'page': page,
                'warning': '部分结果未能获取，请稍后重试' if error else '',
                'has_more': pid == 'qq' and len(items) == 20}

    @app.get('/api/console/platforms/{pid}/recommend')
    async def platform_recommend(pid: str, request: Request):
        p = adapter(pid)
        if not p.recommend:
            raise HTTPException(501, '该平台的个人推荐尚未接入')
        if not enabled(p):
            raise HTTPException(409, '请先启用该平台')
        cursor = str(request.query_params.get('cursor') or '0')
        if not re.fullmatch(r'\d{1,4}', cursor) or int(cursor) > 1000:
            raise HTTPException(400, '推荐页码无效')
        data = await upstream(request, '/recommend/qq', {'cursor': int(cursor)})
        return {'ok': True, 'items': [item for row in data.get('items', []) if (item := p.normalize(row))],
                'next_cursor': data.get('next_cursor'), 'has_more': bool(data.get('has_more'))}

    @app.post('/api/library')
    async def host_only_library():
        raise HTTPException(501, '请从飞牛桌面打开管理页，以访问 NAS 音乐目录')
