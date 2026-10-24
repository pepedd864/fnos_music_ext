"""Kuwo's public metadata catalog. Public selections are not personal recommendations."""
import html
import re

import httpx
from fastapi import HTTPException


def normalize(row):
    if not isinstance(row, dict):
        return None
    r = {k.lower(): v for k, v in row.items()}
    rid = str(r.get('musicrid') or r.get('rid') or r.get('id') or '').removeprefix('MUSIC_')
    if not re.fullmatch(r'\d{1,20}', rid):
        return None
    text = lambda value: html.unescape(re.sub('<[^>]*>', '', str(value or '')))
    try:
        duration = float(r.get('song_duration') or r.get('duration') or 0)
    except (TypeError, ValueError):
        duration = 0
    return {'id': 'kuwo:' + rid, 'source': 'kuwo', 'title': text(r.get('songname') or r.get('name')),
            'artist': text(r.get('artist')), 'album': text(r.get('album')), 'duration_s': duration,
            'cover_url': str(r.get('pic') or r.get('albumpic') or ''), 'ext': 'mp3', 'file_size': 0,
            'resolve_on_play': True}


async def catalog(kind, query='', page=1, client=None):
    if kind == 'search':
        url, params = 'https://search.kuwo.cn/r.s', {'all': query, 'ft': 'music', 'client': 'kt', 'cluster': 0,
            'pn': page - 1, 'rn': 20, 'rformat': 'json', 'encoding': 'utf8', 'mobi': 1}
    else:
        url, params = 'https://kbangserver.kuwo.cn/ksong.s', {'from': 'pc', 'fmt': 'json', 'pn': page - 1,
            'rn': 20, 'type': 'bang', 'data': 'content', 'id': 16, 'show_copyright_off': 1, 'pcmp4': 1}
    async def fetch(cx):
        try:
            response = await cx.get(url, params=params, headers={'Referer': 'https://www.kuwo.cn/', 'User-Agent': 'Mozilla/5.0'}, timeout=12)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError()
        except (httpx.HTTPError, ValueError):
            raise HTTPException(503, '酷我目录服务暂不可达，请稍后重试') from None
        rows = data.get('abslist') if kind == 'search' else data.get('musiclist')
        items = [item for row in (rows or []) if (item := normalize(row))]
        total = int(data.get('TOTAL') or data.get('num') or 0)
        return {'ok': True, 'items': items, 'has_more': page * 20 < total, 'next_cursor': page,
                **({'recommend_kind': 'public', 'label': '酷我热歌榜'} if kind != 'search' else {})}
    if client is not None:
        return await fetch(client)
    async with httpx.AsyncClient(trust_env=False) as cx:
        return await fetch(cx)
