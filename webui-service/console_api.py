"""Capability-driven platform API. Account secrets and audio URLs stay in source services."""
from dataclasses import dataclass
import asyncio
import base64
import io
import re

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from proxy.quality_policy import channel_preference, quality_channels


@dataclass(frozen=True)
class PlatformAdapter:
    id: str
    name: str
    source: str
    short: str
    login: bool = False
    recommend: bool = True
    qualities: tuple = ('original',)
    engine: str = 'musicdl'
    recommend_kind: str = 'personal'

    def public(self):
        options = ([{'value': 'qq', 'label': 'QQ 扫码'}, {'value': 'wx', 'label': '微信扫码'}] if self.id == 'qq'
                   else [{'value': 'app', 'label': self.name + ' App 扫码'}] if self.login else [])
        return {'id': self.id, 'name': self.name, 'logo': f'/app/fnmusic-ext/static/console/platforms/{self.id}.jpg',
                'capabilities': {'search': True, 'login': self.login, 'login_options': options,
                                 'recommend': self.recommend, 'recommend_kind': self.recommend_kind,
                                 'qualities': list(self.qualities)}}

    def normalize(self, row):
        if not isinstance(row, dict) or not str(row.get('id', '')).startswith(self.short + ':'):
            return None
        return {**{k: row.get(k) for k in ('id', 'title', 'artist', 'album', 'duration_s', 'cover_url')}, 'platform': self.id}


TIERS = ('mp3_128', 'mp3_320', 'lossless')
ADAPTERS = {p.id: p for p in (
    PlatformAdapter('qq', 'QQ 音乐', 'QQMusicClient', 'qq', True, qualities=TIERS),
    PlatformAdapter('kugou', '酷狗音乐', 'KugouMusicClient', 'kugou', True, qualities=TIERS),
    PlatformAdapter('kuwo', '酷我音乐', 'KuwoMusicClient', 'kuwo', recommend_kind='public'),
    PlatformAdapter('netease', '网易云音乐', 'musicbox', 'netease', True, qualities=TIERS, engine='musicbox'),
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
        values = service.read_env()
        if p.id == 'netease':
            raw = values.get('FNMUSIC_CONSOLE_NETEASE_ENABLED', values.get('FNMUSIC_NETEASE_ENABLED', 'false'))
            return str(raw).lower() in ('true', '1', 'yes')
        return any(s in {p.source, p.short, p.id} for s in source_list(values))

    async def upstream(request, path, params=None, timeout=20, engine='musicdl', method='GET', body=None):
        try:
            response = await service.get_http(request).request(method, service.CONF[engine + '_url'] + path,
                params=params, json=body, timeout=httpx.Timeout(timeout, connect=3))
        except httpx.HTTPError:
            raise HTTPException(503, '音乐服务暂时无法连接，请检查音源运行状态') from None
        if response.status_code != 200:
            if response.status_code == 401:
                raise HTTPException(401, '账号已过期，请验证或重新登录')
            if response.status_code == 403:
                raise HTTPException(403, '该账号没有当前资源的完整访问权限')
            raise HTTPException(response.status_code, '平台请求未完成，请稍后重试或验证账号')
        try:
            data = response.json()
        except ValueError:
            raise HTTPException(502, '平台响应格式异常') from None
        if not isinstance(data, dict) or data.get('ok') is False:
            raise HTTPException(502, '平台请求未完成，请验证账号或稍后重试')
        return data

    async def account_status(p, request):
        if not p.login:
            return {'state': 'public', 'logged_in': False, 'account': ''}
        try:
            if p.id == 'netease':
                result = await upstream(request, '/api/v1/auth/status', engine='musicbox', timeout=8)
                data = result.get('data') if isinstance(result.get('data'), dict) else result
                logged = bool(data.get('logged_in'))
                uid = str(data.get('user_id') or data.get('userid') or '')
                return {'state': 'stored' if logged else 'anonymous', 'logged_in': logged,
                        'account': '****' + uid[-4:] if uid else str(data.get('nickname') or '')[:60]}
            return await upstream(request, f'/auth/{p.id}/status', timeout=5)
        except HTTPException:
            return {'state': 'unavailable', 'logged_in': False, 'account': ''}

    @app.get('/api/console/platforms')
    async def platforms(request: Request):
        values = service.read_env()
        accounts = await asyncio.gather(*(account_status(p, request) for p in ADAPTERS.values()))
        items = []
        for p, auth in zip(ADAPTERS.values(), accounts):
            status = ('公开渠道 · 无需登录' if not p.login else '已登录' if auth.get('logged_in') else
                      '登录已过期' if auth.get('state') == 'expired' else '暂时无法连接' if auth.get('state') == 'unavailable' else '待登录')
            preference = channel_preference(values, p.id) if p.qualities != ('original',) else 'original'
            items.append({**p.public(), 'enabled': enabled(p), 'status': status,
                          'auth': {k: auth.get(k) for k in ('state', 'logged_in', 'account', 'expires_at')},
                          'quality_preference': preference})
        return JSONResponse({'ok': True, 'items': items, 'quality': channel_preference(values, 'qq'),
                             'quality_mode': values.get('FNMUSIC_QUALITY_MODE') or 'high'}, headers={'Cache-Control': 'no-store'})

    @app.get('/api/console/quality')
    async def quality_settings():
        return {'ok': True, 'channels': quality_channels(service.read_env())}

    @app.put('/api/console/platforms/{pid}')
    async def platform_toggle(pid: str, request: Request):
        p = adapter(pid)
        body = await request.json()
        if type(body.get('enabled')) is not bool:
            raise HTTPException(400, 'enabled 必须为布尔值')
        async with config_lock:
            if pid == 'netease':
                service.write_env({'FNMUSIC_CONSOLE_NETEASE_ENABLED': str(body['enabled']).lower()})
                actions = []
                await service._reconcile_musicbox_resident(service.get_http(request), service.read_env(), actions)
                if any(not action.get('ok') for action in actions):
                    raise HTTPException(503, '网易云进程未能就绪，请在运行状态页重试')
            else:
                sources = [s for s in source_list(service.read_env()) if s not in {p.source, p.short, p.id}]
                if body['enabled']:
                    sources.append(p.source)
                if not sources:
                    raise HTTPException(400, '请至少保留一个启用的聚合音乐平台')
                service.write_env({'FNMUSIC_ONLINE_SOURCES': ','.join(dict.fromkeys(sources)), 'MUSICDL_SOURCES': ','.join(dict.fromkeys(sources))})
        return {'ok': True}

    @app.api_route('/api/console/platforms/{pid}/auth/{operation:path}', methods=['GET', 'POST'])
    async def platform_auth(pid: str, operation: str, request: Request):
        p = adapter(pid)
        methods = {'status': 'GET', 'login': 'POST', 'login/check': 'POST', 'verify': 'POST', 'logout': 'POST'}
        if not p.login or methods.get(operation) != request.method:
            raise HTTPException(404, '该平台没有此账号操作')
        if operation == 'status':
            return JSONResponse(await account_status(p, request), headers={'Cache-Control': 'no-store'})
        raw = await request.body()
        if len(raw) > 1024:
            raise HTTPException(413, '账号请求过大')
        try:
            body = await request.json() if raw else {}
        except ValueError:
            raise HTTPException(400, '账号请求格式无效') from None
        if not isinstance(body, dict):
            raise HTTPException(400, '账号请求格式无效')
        if p.id != 'netease':
            if operation == 'login':
                body = {'kind': body.get('kind') or 'qq'} if pid == 'qq' else {}
            elif operation == 'login/check':
                body = {'session_id': str(body.get('session_id') or '')[:128]}
            else:
                body = {}
            data = await upstream(request, f'/auth/{pid}/{operation}', method='POST', body=body, timeout=30)
        else:
            if operation == 'login':
                result = await service.api_preview(service.PreviewBody(provider='musicbox'), request)
                if isinstance(result, JSONResponse) and result.status_code >= 400:
                    raise HTTPException(503, '网易云服务尚未就绪，请稍后重试')
            params = None
            if operation == 'login/check':
                key = str(body.get('session_id') or '')
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', key):
                    raise HTTPException(400, '登录会话无效')
                params = {'unikey': key}
            result = await upstream(request, '/api/v1/auth/' + operation, engine='musicbox',
                                    method='GET' if operation == 'login/check' else 'POST', params=params, timeout=30)
            payload = result.get('data') if isinstance(result.get('data'), dict) else result
            if operation == 'login':
                key = str(payload.get('unikey') or payload.get('codekey') or '')
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', key):
                    raise HTTPException(502, '网易云未返回二维码')
                import qrcode
                import qrcode.image.svg
                image = qrcode.make('https://music.163.com/login?codekey=' + key, image_factory=qrcode.image.svg.SvgPathImage)
                buffer = io.BytesIO(); image.save(buffer)
                data = {'session_id': key, 'expires_in': 180, 'image': 'data:image/svg+xml;base64,' + base64.b64encode(buffer.getvalue()).decode()}
            elif operation == 'login/check':
                state = {800: 'timeout', 801: 'scan', 802: 'conf', 803: 'done'}.get(payload.get('code'), 'scan')
                if state == 'done':
                    service._resident_login_cache.update(ts=0.0, value=None)
                    service._resident_start_block.update(until=0.0, reason='')
                    service._public_discovery_cache.clear()
                data = {'state': state}
            else:
                data = {'verified': bool(payload.get('verified'))} if operation == 'verify' else {'ok': True}
        fields = ('session_id', 'expires_in', 'image') if operation == 'login' else ('state',) if operation == 'login/check' else ('verified',) if operation == 'verify' else ()
        return JSONResponse({'ok': True, **{k: data[k] for k in fields if k in data}}, headers={'Cache-Control': 'no-store'})

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
        if locks[pid].locked():
            raise HTTPException(429, '该平台正在处理请求，请稍候')
        async with locks[pid]:
            if pid == 'qq':
                data = await upstream(request, '/search', {'keyword': keyword, 'sources': p.source, 'limit': 20, 'page': page}, timeout=30)
            else:
                path = '/api/v1/catalog/search' if p.engine == 'musicbox' else f'/catalog/{pid}/search'
                data = await upstream(request, path, {'q': keyword, 'page': page}, engine=p.engine, timeout=30)
        items = [item for row in data.get('items', []) if (item := p.normalize(row))]
        return {'ok': True, 'items': items, 'page': page,
                'warning': '部分结果未能获取，请稍后重试' if data.get('errors') else '',
                'has_more': bool(data.get('has_more', pid == 'qq' and len(items) == 20))}

    @app.get('/api/console/platforms/{pid}/recommend')
    async def platform_recommend(pid: str, request: Request):
        p = adapter(pid)
        if not p.recommend:
            raise HTTPException(501, '该平台的推荐尚未接入')
        if not enabled(p):
            raise HTTPException(409, '请先启用该平台')
        cursor = str(request.query_params.get('cursor') or '0')
        if not re.fullmatch(r'\d{1,4}', cursor) or int(cursor) > 1000:
            raise HTTPException(400, '推荐页码无效')
        path = '/recommend/qq' if pid == 'qq' else '/api/v1/catalog/recommend' if p.engine == 'musicbox' else f'/catalog/{pid}/recommend'
        data = await upstream(request, path, {'cursor': int(cursor)}, engine=p.engine, timeout=30)
        return {'ok': True, 'items': [item for row in data.get('items', []) if (item := p.normalize(row))],
                'next_cursor': data.get('next_cursor'), 'has_more': bool(data.get('has_more')),
                'recommend_kind': p.recommend_kind, 'label': data.get('label') or ''}

    @app.post('/api/library')
    async def host_only_library():
        raise HTTPException(501, '请从飞牛桌面打开管理页，以访问 NAS 音乐目录')
