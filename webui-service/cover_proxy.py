"""Lazy Kuwo artwork delivery; bounded memory cache and fixed public endpoints."""
from collections import OrderedDict
import re
import time
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import HTTPException

HEADERS = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.kuwo.cn/'}
MAX_IMAGE_BYTES = 2 * 1024 * 1024


def image_url(value):
    """Use Kuwo's HTTPS image alias, including its legacy HTTP kwcdn host."""
    parsed = urlsplit(value)
    host = parsed.hostname or ''
    if (parsed.scheme not in ('http', 'https') or parsed.username or parsed.password
            or parsed.port is not None or len(value) > 2048
            or not re.fullmatch(r'img[1-9]?\.(?:kwcdn\.)?kuwo\.cn', host)
            or not parsed.path.startswith(('/star/', '/pic_music/'))
            or not re.search(r'\.(?:jpg|jpeg|png|webp)$', parsed.path, re.I)):
        raise ValueError('Unrecognized artwork location')
    # The legacy kwcdn host does not have a matching TLS certificate. Its
    # corresponding imgN.kuwo.cn alias serves the same bytes with valid TLS.
    host = host.replace('.kwcdn.kuwo.cn', '.kuwo.cn')
    return urlunsplit(('https', host, parsed.path, parsed.query, ''))


async def read_limited(client, url, limit):
    async with client.stream('GET', url, headers=HEADERS) as response:
        response.raise_for_status()  # Redirects are never followed.
        if int(response.headers.get('content-length') or 0) > limit:
            raise ValueError('Artwork response too large')
        chunks, size = [], 0
        async for chunk in response.aiter_bytes(65536):
            size += len(chunk)
            if size > limit:
                raise ValueError('Artwork response too large')
            chunks.append(chunk)
        return b''.join(chunks)


class KuwoCovers:
    def __init__(self, transport=None):
        self.transport = transport
        self.cache = OrderedDict()

    def remember(self, rid, picture):
        self.cache[rid] = (time.monotonic() + (21600 if picture else 60), picture)
        self.cache.move_to_end(rid)
        while len(self.cache) > 128 or sum(len(value[1][0]) for value in self.cache.values() if value[1]) > 8 * 1024 * 1024:
            self.cache.popitem(last=False)

    async def get(self, rid):
        if not re.fullmatch(r'\d{1,20}', rid):
            raise HTTPException(400, '歌曲 ID 无效')
        cached = self.cache.get(rid)
        if cached and cached[0] > time.monotonic():
            self.cache.move_to_end(rid)
            if cached[1] is None:
                raise HTTPException(404, '暂时没有可用封面')
            return cached[1]
        self.cache.pop(rid, None)
        try:
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False,
                                         timeout=httpx.Timeout(5, connect=2), transport=self.transport) as client:
                resolver = ('https://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic'
                            f'&pictype=url&size=500&rid={rid}')
                text = (await read_limited(client, resolver, 4096)).decode('utf-8')
                match = re.search(r'https?://[^\s\'"<>]+', text)
                if not match:
                    raise ValueError('No artwork')
                data = await read_limited(client, image_url(match.group()), MAX_IMAGE_BYTES)
            if data.startswith(b'\xff\xd8\xff'):
                mime = 'image/jpeg'
            elif data.startswith(b'\x89PNG\r\n\x1a\n'):
                mime = 'image/png'
            elif data[:4] == b'RIFF' and data[8:12] == b'WEBP':
                mime = 'image/webp'
            else:
                raise ValueError('Not an image')
        except (httpx.HTTPError, ValueError, UnicodeError):
            self.remember(rid, None)
            raise HTTPException(404, '暂时没有可用封面') from None
        picture = (data, mime)
        self.remember(rid, picture)
        return picture
