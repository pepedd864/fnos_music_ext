"""Kugou account catalog. Metadata requests never resolve audio.

Protocol references: MakcRe/KuGouMusicApi (MIT), module/login_qr_*,
search, everyday_recommend, user_detail and song_url. See THIRD_PARTY_NOTICES.md.
Only the account's ordinary song URL endpoint is used; no entitlement changes.
"""
import asyncio
import base64
import hashlib
import html
import io
import json
import logging
import os
from pathlib import Path
import re
import secrets
import tempfile
import time

import httpx
from fastapi import HTTPException

APPID, VERSION = 1005, 20489
ANDROID_SALT = 'OIlwieks28dk2k092lksi2UIkp'
WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
PUBLIC_KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB'


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def md5(value):
    return hashlib.md5(value.encode()).hexdigest()


def normalize(row):
    if not isinstance(row, dict):
        return None
    # Search and daily recommendations use different field casing.
    r = {k.lower(): v for k, v in row.items()}
    song_hash = str(r.get('hash') or r.get('filehash') or '').lower()
    if not re.fullmatch('[a-f0-9]{32}', song_hash):
        return None
    clean = lambda v: html.unescape(re.sub('<[^>]*>', '', str(v or '')))
    artist = clean(r.get('singername') or r.get('singer_name') or r.get('author_name'))
    title = clean(r.get('songname') or r.get('song_name') or r.get('audio_name') or r.get('filename'))
    if ' - ' in title and not r.get('songname') and not r.get('song_name'):
        singer, title = title.split(' - ', 1)
        artist = artist or singer
    mix_id = str(r.get('mixsongid') or r.get('album_audio_id') or '0')
    mix_id = mix_id if mix_id.isdigit() else '0'
    cover = r.get('image') or r.get('img') or r.get('cover') or ''
    if isinstance(cover, dict):
        cover = cover.get('url') or ''
    try:
        duration = max(0, min(float(r.get('duration') or r.get('timelength', 0) / 1000), 86400))
    except (ValueError, TypeError):
        duration = 0
    return {'id': f'kugou:{song_hash}:{mix_id}', 'source': 'kugou', 'title': title,
            'artist': artist, 'album': clean(r.get('albumname') or r.get('album_name')),
            'duration_s': duration, 'cover_url': str(cover).replace('{size}', '400'),
            'ext': 'mp3', 'file_size': 0, 'resolve_on_play': True}


class KugouCatalog:
    def __init__(self, directory=None, transport=None):
        self.directory = Path(directory or Path(os.environ.get('XDG_DATA_HOME', '/data')) / 'kugou')
        self.path = self.directory / 'credential.json'
        self.transport = transport
        self.lock = asyncio.Lock()
        self.data = {}
        self.session = None
        self.generation = 0
        self.resolved = {}
        for name in ('httpx', 'httpcore'):
            logging.getLogger(name).setLevel(logging.WARNING)
        try:
            saved = json.loads(self.path.read_text())
            if self.valid(saved):
                self.data = saved
        except (OSError, ValueError, TypeError):
            pass

    @staticmethod
    def valid(data):
        return isinstance(data, dict) and str(data.get('userid', '')).isdigit() and int(data['userid']) > 0 and isinstance(data.get('token'), str) and bool(data['token'])

    def status(self):
        present = self.valid(self.data)
        expired = bool(self.data.get('invalid'))
        return {'configured': present, 'logged_in': present and not expired,
                'state': 'expired' if present and expired else 'stored' if present else 'anonymous',
                'account': '****' + str(self.data['userid'])[-4:] if present else '', 'expires_at': None}

    def save(self, data):
        if not self.valid(data):
            raise HTTPException(502, '酷狗登录未返回有效凭据，请重新扫码')
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        fd, name = tempfile.mkstemp(prefix='.credential-', dir=self.directory)
        try:
            with os.fdopen(fd, 'w') as file:
                json.dump(data, file); file.flush(); os.fsync(file.fileno())
            os.replace(name, self.path)
        finally:
            Path(name).unlink(missing_ok=True)
        self.data = dict(data)
        self.generation += 1
        self.resolved.clear()

    async def request(self, path, *, host='https://gateway.kugou.com', router='', web=False,
                      params=None, body=None, credential=None):
        credential = self.data if credential is None else credential
        defaults = {'dfid': credential.get('dfid') or '-', 'mid': credential.get('mid') or md5('fnmusic-kugou-catalog'),
                    'uuid': '-', 'appid': APPID, 'clientver': VERSION, 'clienttime': int(time.time())}
        if credential.get('token'):
            defaults.update(token=credential['token'], userid=credential['userid'])
        query = {**defaults, **(params or {})}
        salt = WEB_SALT if web else ANDROID_SALT
        payload = encoded(body) if body is not None else ''
        query['signature'] = md5(salt + ''.join(f'{k}={query[k]}' for k in sorted(query)) + payload + salt)
        headers = {'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
                   'mid': str(query['mid']), 'dfid': str(query['dfid']), 'clienttime': str(query['clienttime']),
                   'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F'}
        if router:
            headers['x-router'] = router
        if body is not None:
            headers['Content-Type'] = 'application/json'
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=httpx.Timeout(15, connect=4), trust_env=False) as client:
                response = await client.request('POST' if body is not None else 'GET', host + path,
                                                params=query, content=payload or None, headers=headers)
            data = response.json()
        except (httpx.HTTPError, ValueError):
            raise HTTPException(503, '酷狗服务暂不可达，请稍后重试') from None
        if response.status_code != 200 or not isinstance(data, dict):
            raise HTTPException(502, '酷狗返回异常，请稍后重试')
        if data.get('status') == 0:
            raise HTTPException(502, '酷狗未完成请求，请验证账号；如平台要求安全验证，请先在官方 App 完成')
        return data

    async def login(self):
        async with self.lock:
            device = {'mid': secrets.token_hex(16)}
            result = await self.request('/v2/qrcode', host='https://login-user.kugou.com', web=True, credential=device,
                                        params={'appid': 1001, 'type': 1, 'plat': 4, 'srcappid': 2919,
                                                'qrcode_txt': f'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid={APPID}&'})
            key = str((result.get('data') or {}).get('qrcode') or '')
            if not re.fullmatch(r'[A-Za-z0-9_-]{8,200}', key):
                raise HTTPException(502, '酷狗未返回登录二维码')
            import qrcode
            image = qrcode.make(f'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid={APPID}&qrcode={key}')
            buffer = io.BytesIO(); image.save(buffer, format='PNG')
            self.session = {'id': secrets.token_urlsafe(24), 'key': key, 'device': device, 'until': time.monotonic() + 180}
            return {'ok': True, 'session_id': self.session['id'], 'expires_in': 180,
                    'image': 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()}

    async def check(self, session_id):
        async with self.lock:
            session = self.session
            if not session or not secrets.compare_digest(str(session_id), session['id']):
                raise HTTPException(400, '二维码会话无效，请重新生成')
            if time.monotonic() > session['until']:
                self.session = None
                return {'state': 'timeout'}
            result = await self.request('/v2/get_userinfo_qrcode', host='https://login-user.kugou.com', web=True,
                                        credential=session['device'], params={'plat': 4, 'appid': APPID, 'srcappid': 2919, 'qrcode': session['key']})
            data = result.get('data') or {}
            state = {0: 'timeout', 1: 'scan', 2: 'conf', 4: 'done'}.get(data.get('status'), 'scan')
            if state == 'done':
                self.save({**session['device'], **{k: data[k] for k in ('userid', 'token') if k in data}})
            if state in ('done', 'timeout'):
                self.session = None
            return {'ok': True, 'state': state}

    async def verify(self):
        if not self.valid(self.data):
            return {'ok': True, 'verified': False}
        from cryptography.hazmat.primitives.serialization import load_pem_public_key
        raw = encoded({'token': self.data['token'], 'clienttime': int(time.time())}).encode()
        key = load_pem_public_key(('-----BEGIN PUBLIC KEY-----\n' + PUBLIC_KEY + '\n-----END PUBLIC KEY-----').encode()).public_numbers()
        # Official protocol uses raw RSA with right zero padding, not an OAuth credential.
        encrypted = pow(int.from_bytes(raw.ljust(128, b'\0'), 'big'), key.e, key.n).to_bytes(128, 'big').hex().upper()
        result = await self.request('/v3/get_my_info', router='usercenter.kugou.com', params={'plat': 1},
                                    body={'visit_time': int(time.time()), 'usertype': 1, 'p': encrypted, 'userid': int(self.data['userid'])})
        verified = result.get('status') == 1 and bool(result.get('data'))
        if verified and self.data.get('invalid'):
            self.save({**self.data, 'invalid': False})
        return {'ok': True, 'verified': verified}

    async def logout(self):
        async with self.lock:
            self.path.unlink(missing_ok=True)
            self.data = {}; self.session = None; self.generation += 1; self.resolved.clear()
        return {'ok': True}

    async def search(self, query, page=1, limit=20):
        result = await self.request('/v2/search/song', router='complexsearch.kugou.com',
                                    params={'keyword': query, 'page': page, 'pagesize': limit, 'platform': 'AndroidFilter',
                                            'iscorrection': 1, 'privilegefilter': 0, 'area_code': 1, 'dopicfull': 1})
        data = result.get('data') or {}
        items = [item for row in data.get('lists', []) if (item := normalize(row))]
        return {'ok': True, 'items': items, 'has_more': page * limit < int(data.get('total') or 0)}

    async def recommend(self, cursor=0):
        if not self.status()['logged_in']:
            raise HTTPException(401, '请先登录酷狗音乐账号')
        generation = self.generation
        result = await self.request('/everyday_song_recommend', router='everydayrec.service.kugou.com', params={'platform': 'ios'}, body={})
        if generation != self.generation:
            raise HTTPException(409, '账号已改变，请重新获取推荐')
        data = result.get('data') or {}
        rows = data.get('song_list') or data.get('songs') or data.get('list') or []
        items = [item for row in rows if (item := normalize(row))]
        start = cursor * 10
        return {'ok': True, 'items': items[start:start + 10], 'next_cursor': cursor + 1, 'has_more': start + 10 < len(items)}

    @staticmethod
    def accepts(song_id):
        return bool(re.fullmatch(r'kugou:[a-fA-F0-9]{32}(?::\d{1,20})?', song_id))

    async def resolve(self, song_id, quality=''):
        if not self.accepts(song_id):
            raise HTTPException(400, '酷狗歌曲标识无效')
        quality = quality or 'mp3_128'
        if quality not in ('mp3_128', 'mp3_320', 'lossless'):
            raise HTTPException(400, '不支持的酷狗音质')
        cache_key = (song_id, quality, self.generation)
        cached = self.resolved.get(cache_key)
        if cached and cached['ts'] + 300 > time.time():
            return cached
        parts = song_id.split(':')
        mid = self.data.get('mid') or md5('fnmusic-kugou-catalog')
        result = await self.request('/v5/url', router='trackercdn.kugou.com', params={
            'album_id': 0, 'area_code': 1, 'hash': parts[1], 'ssa_flag': 'is_fromtrack', 'version': 11430,
            'page_id': 151369488, 'quality': {'mp3_128': 128, 'mp3_320': 320, 'lossless': 'flac'}[quality],
            'album_audio_id': int(parts[2]) if len(parts) > 2 else 0, 'behavior': 'play', 'pid': 2, 'cmd': 26,
            'pidversion': 3001, 'IsFreePart': 0, 'ppage_id': '463467626,350369493,788954147', 'cdnBackup': 1,
            'module': '', 'clientver': 11430, 'key': md5(parts[1] + '57ae12eb6890223e355ccfcb74edf70d' + str(APPID) + mid + str(self.data.get('userid') or 0))})
        urls = result.get('url') or (result.get('data') or {}).get('url') or []
        url = urls[0] if isinstance(urls, list) and urls else urls if isinstance(urls, str) else ''
        if not url.startswith(('https://', 'http://')) or result.get('is_free_part') or result.get('is_part'):
            raise HTTPException(403, '当前酷狗账号没有该歌曲或音质的完整播放权限')
        entry = {'item': {'id': song_id, 'source': 'kugou', 'download_url': url, 'ext': 'flac' if quality == 'lossless' else 'mp3'},
                 'download_headers': {}, 'ts': time.time(), 'keyword': ''}
        if cache_key[2] != self.generation:
            raise HTTPException(409, '账号已改变，请重新播放')
        self.resolved[cache_key] = entry
        if len(self.resolved) > 256:
            self.resolved.pop(next(iter(self.resolved)))
        return entry
