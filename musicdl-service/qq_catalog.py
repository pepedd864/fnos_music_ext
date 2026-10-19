"""QQ metadata and on-demand playback using the SDK's public API.

Search never resolves media, fetches lyrics, or probes every result. Only normal
unprotected audio formats authorized by QQ are requested; no trial fallback.
"""
import asyncio
from contextlib import suppress
import logging
import re
from urllib.parse import urljoin, urlsplit

from qq_auth import AuthError


QQ_QUALITIES = {"", "high", "balanced", "smooth", "master", "lossless", "mp3_320", "mp3_128", "mp3"}


class CatalogError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def validate_quality(quality):
    quality = str(quality or "").strip().lower()
    if quality not in QQ_QUALITIES:
        raise CatalogError("不支持的 QQ 音质档位", 400)
    return quality


def normalize(row):
    mid = str(row.get("mid") or "")
    if not re.fullmatch(r"[A-Za-z0-9]+", mid):
        return None
    title = str(row.get("title") or row.get("name") or "").strip()
    if not title or any(mark in title for mark in ("（试听）", "(试听)", "试听片段", "片段试听", "试听版", "[试听]", "【试听】", "- 试听")):
        return None
    album = row.get("album") or {}
    album_mid = str(album.get("mid") or "")
    sizes = row.get("file") or {}
    lossless = max(0, int(sizes.get("size_flac") or 0))
    variants = {}
    for quality, key, ext, bitrate in (
        ("mp3_128", "size_128mp3", "mp3", 128000),
        ("mp3_320", "size_320mp3", "mp3", 320000),
        ("lossless", "size_flac", "flac", 0),
    ):
        size = int(sizes.get(key) or 0)
        if size > 0:
            variants[quality] = {"ext": ext, "file_size": size, "bitrate": bitrate}
    modern = sizes.get("size_new") or []
    if modern and int(modern[0]) > 0:
        variants["master"] = {"ext": "flac", "file_size": int(modern[0]), "bitrate": 0}
    return {"id": f"qq:{mid}", "source": "qq", "title": title,
            "artist": " / ".join(s.get("name", "") for s in row.get("singer", [])),
            "album": album.get("title") or album.get("name") or "",
            "duration_s": int(row.get("interval") or 0),
            "ext": "flac" if lossless else "mp3",
            "file_size": (lossless or max(0, int(sizes.get("size_320mp3") or 0))
                          or max(0, int(sizes.get("size_128mp3") or 0))),
            "audio_variants": variants,
            "albummid": album_mid,
            "cover_url": (f"https://y.gtimg.cn/music/photo_new/T002R500x500M000{album_mid}.jpg"
                          if re.fullmatch(r"[A-Za-z0-9]+", album_mid) else ""),
            # Availability and actual format are checked on play, not guessed
            # from membership/pay metadata. No verified flag or signed URL.
            "resolve_on_play": True}


def sdk_factory(auth, *, metadata=False):
    for name in ("httpx", "httpcore", "qqmusicapi"):
        logging.getLogger(name).setLevel(logging.WARNING)
    from qqmusic_api import Client, Credential
    try:
        cookies = auth.cookies()
    except AuthError:
        if not metadata:
            raise
        cookies = {}  # Expired credentials must not prevent browsing metadata.
    auth._private_dir()
    return Client(credential=Credential.model_validate(cookies) if cookies else None,
                  device_path=str(auth.directory / "device.json"))


class QQCatalog:
    def __init__(self, auth, factory=sdk_factory):
        self.auth = auth
        self.factory = factory
        # Separate bounded lanes: a busy catalog must not queue playback behind
        # all the slow searches. Queue time is inside each deadline.
        self.search_slots = asyncio.Semaphore(2)
        self.play_slots = asyncio.Semaphore(4)

    async def _call(self, operation, *, metadata=False, timeout=8):
        async def run():
            async with self.search_slots if metadata else self.play_slots:
                client = None
                try:
                    client = self.factory(self.auth, metadata=metadata)
                    return await operation(client)
                finally:
                    if client:
                        with suppress(Exception):
                            await client.close()
        try:
            return await asyncio.wait_for(run(), timeout)
        except (CatalogError, AuthError):
            raise
        except asyncio.TimeoutError:
            raise CatalogError("QQ 音乐请求超时，请稍后重试", 504) from None
        except Exception:
            # SDK errors can carry request URLs, tickets and cookies.
            raise CatalogError("QQ 音乐服务暂时不可用，请检查网络后重试", 502) from None

    async def search(self, keyword, limit, page=1):
        async def query(client):
            result = await client.search.search_by_type(keyword, num=limit, page=page, highlight=False)
            data = result.model_dump(by_alias=True)
            return [item for row in data.get("song", []) if (item := normalize(row))]
        return await self._call(query, metadata=True)

    async def info(self, song_id):
        mid = self.mid(song_id)
        async def query(client):
            result = await client.song.query_song([mid])
            for row in result.model_dump(by_alias=True).get("tracks", []):
                item = normalize(row)
                if item and item["id"] == song_id:
                    return item
            raise CatalogError("QQ 音乐找不到这首歌曲", 404)
        return await self._call(query, metadata=True, timeout=3)

    @staticmethod
    def mid(song_id):
        mid = song_id.removeprefix("qq:")
        if not song_id.startswith("qq:") or not re.fullmatch(r"[A-Za-z0-9]{1,64}", mid):
            raise CatalogError("无效的 QQ 歌曲编号", 400)
        return mid

    async def resolve(self, song_id, quality="", rendition=None):
        mid = self.mid(song_id)
        quality = validate_quality(quality)
        async def query(client):
            from qqmusic_api.modules.song import SongFileInfo, SongFileType
            formats = [SongFileType.MASTER, SongFileType.FLAC, SongFileType.MP3_320, SongFileType.MP3_128]
            if rendition:
                formats = [f for f in formats if f.s == rendition]
            elif quality in ("mp3", "mp3_320"):
                formats = formats[2:]
            elif quality == "mp3_128":
                formats = formats[3:]
            elif quality == "lossless":
                formats = formats[1:]
            elif quality == "balanced":
                formats = formats[1:] + formats[:1]
            elif quality == "smooth":
                formats = list(reversed(formats))
            result = await client.song.get_song_urls([SongFileInfo(mid, file_type=f) for f in formats])
            for fmt in formats:
                for row in result.data:
                    if (row.mid != mid or row.result != 0 or not row.purl
                            or not row.filename.startswith(fmt.s)
                            or not row.filename.endswith(fmt.e)):
                        continue
                    # QQ returns relative signed paths. Refuse alternate hosts,
                    # encrypted or trial filenames instead of silently changing
                    # the track/representation behind a Range request.
                    url = urljoin("https://isure.stream.qqmusic.qq.com/", row.purl)
                    parsed = urlsplit(url)
                    if (parsed.scheme != "https" or parsed.hostname != "isure.stream.qqmusic.qq.com"
                            or not parsed.path.rsplit("/", 1)[-1].startswith(fmt.s)
                            or not parsed.path.endswith(fmt.e)):
                        continue
                    return {"download_url": url, "ext": fmt.e.lstrip("."),
                            "rendition": fmt.s, "ttl": min(600, max(1, (result.expiration or 300) - 30))}
            raise CatalogError("这首歌暂时没有当前账号可播放的完整音频，请验证会员或换一首", 403)
        return await self._call(query)

    async def lyric(self, song_id):
        mid = self.mid(song_id)
        async def query(client):
            result = await client.lyric.get_lyric(mid)
            return result.decrypt().lyric or ""
        return await self._call(query, metadata=True, timeout=2)
