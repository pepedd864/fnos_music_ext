"""Host-side, directory-scoped music catalog. Never writes the official music DB.

Only the authenticated desktop gateway calls dispatch(). File changes use file
IDs, pinned directory descriptors, identity checks and a private recovery journal.
"""
from __future__ import annotations

import contextlib
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import uuid

MEDIA_EXTENSIONS = {'.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.ape', '.wma', '.alac'}
PLATFORMS = {'qq', 'kugou', 'kuwo', 'netease'}
QUALITY = {'mp3_128', 'mp3_320', 'lossless'}


class LibraryError(ValueError):
    pass


def _key(text):
    return ' '.join(unicodedata.normalize('NFKC', str(text or '')).casefold().split())


def _identity(st):
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)


def _digest(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    h = hashlib.sha256()
    while chunk := os.read(fd, 1024 * 1024):
        h.update(chunk)
    os.lseek(fd, 0, os.SEEK_SET)
    return h.hexdigest()


def read_metadata(fd, path):
    """Read tags from an already pinned file; extension is never proof of codec."""
    from mutagen import File
    try:
        with os.fdopen(os.dup(fd), 'rb') as stream:
            audio = File(stream, easy=True)
    except Exception:
        raise LibraryError('无法读取音频标签，文件未加入曲库') from None
    if audio is None or not getattr(audio, 'info', None):
        raise LibraryError('无法识别音频，文件未加入曲库')
    tags = audio.tags or {}
    def tag(name):
        value = tags.get(name) or []
        return str(value[0] if isinstance(value, (list, tuple)) and value else value or '').strip()[:1000]
    info = audio.info
    title = tag('title') or Path(path).stem
    # Only remove the extension's own old quality marker, not recording names.
    title = re.sub(r'\s*[（(\[]?QQ-(?:128k|320k|FLAC|lossless)[）)\]]?$', '', title, flags=re.I).strip()
    return {'title': title, 'artist': tag('artist'), 'album': tag('album'),
            'duration_s': round(float(getattr(info, 'length', 0)), 3),
            'format': {'MP3': 'MP3', 'EasyMP3': 'MP3', 'FLAC': 'FLAC', 'MP4': 'M4A', 'EasyMP4': 'M4A', 'WAVE': 'WAV'}.get(type(audio).__name__, type(audio).__name__.upper()),
            'bitrate': int(getattr(info, 'bitrate', 0) or 0),
            'sample_rate': int(getattr(info, 'sample_rate', 0) or 0)}


class LibraryManager:
    def __init__(self, directory, metadata=read_metadata, media_url='http://127.0.0.1:8768'):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)
        self.trash = self.directory / 'trash'
        self.trash.mkdir(exist_ok=True, mode=0o700)
        self.staging = self.directory / 'staging'
        self.staging.mkdir(exist_ok=True, mode=0o700)
        self.db_path = self.directory / 'catalog.sqlite3'
        self.metadata = metadata
        self.media_url = media_url
        self.lock = threading.RLock()
        self.worker = None
        self._init_db()

    @contextlib.contextmanager
    def db(self):
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def _init_db(self):
        with self.db() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS roots(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,last_scan REAL);
                CREATE TABLE IF NOT EXISTS songs(id TEXT PRIMARY KEY,title TEXT,artist TEXT,album TEXT,duration REAL,preferred TEXT);
                CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,song_id TEXT,root_id TEXT,relative TEXT,
                    state TEXT,dev INTEGER,ino INTEGER,size INTEGER,mtime INTEGER,format TEXT,bitrate INTEGER,
                    sample_rate INTEGER,sha256 TEXT,trash_path TEXT,provider TEXT,track_id TEXT,
                    UNIQUE(root_id,relative));
                CREATE INDEX IF NOT EXISTS files_song ON files(song_id);
                CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,kind TEXT,state TEXT,title TEXT,
                    payload TEXT,progress INTEGER,error TEXT,created REAL,updated REAL);
                CREATE INDEX IF NOT EXISTS task_state ON tasks(state,created);
                CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
                PRAGMA user_version=1;
            ''')
            # Interrupted transfers are retryable; never silently repeat a file mutation.
            db.execute("UPDATE tasks SET state='interrupted',error='服务重启，任务中断；可重试',updated=? WHERE state IN ('running','queued')", (time.time(),))
        os.chmod(self.db_path, 0o600)
        self._recover_moves()

    @staticmethod
    def _root_path(path):
        if not isinstance(path, str) or not path.startswith('/') or any(c in path for c in '\x00\r\n') or '..' in Path(path).parts:
            raise LibraryError('请输入不含 .. 的绝对目录路径')
        p = Path(path)
        # Reject system/application data; adding a volume root would include these.
        if len(p.parts) < 3 or any(part.startswith('@') or part in {'.ssh', '.fnmusic-trash', 'sources-data'} for part in p.parts):
            raise LibraryError('请选择具体的音乐文件夹，不可选择磁盘根目录或应用数据目录')
        if p.parts[1] in {'etc', 'proc', 'sys', 'dev', 'bin', 'sbin', 'usr', 'var', 'run', 'root'}:
            raise LibraryError('不可管理系统目录')
        with LibraryManager._open_directory(p):
            pass
        return str(p)

    @staticmethod
    @contextlib.contextmanager
    def _open_directory(path):
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in Path(path).parts[1:]:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = nxt
            yield fd
        finally:
            os.close(fd)

    @contextlib.contextmanager
    def _parent(self, root, relative):
        parts = Path(relative).parts
        if not parts or Path(relative).is_absolute() or any(p in {'..', '.'} for p in parts):
            raise LibraryError('文件路径无效')
        with self._open_directory(root) as base:
            fd = os.dup(base)
            try:
                for part in parts[:-1]:
                    nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    os.close(fd)
                    fd = nxt
                yield fd, parts[-1]
            finally:
                os.close(fd)

    @contextlib.contextmanager
    def _open_file(self, root, relative, expected=None):
        with self._parent(root, relative) as (parent, name):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode):
                    raise LibraryError('只允许操作常规音频文件')
                if expected and _identity(st) != tuple(expected[k] for k in ('dev', 'ino', 'size', 'mtime')):
                    raise LibraryError('文件已被其他程序修改，请先重新扫描')
                yield fd, st, parent, name
            finally:
                os.close(fd)

    def roots(self):
        with self.db() as db:
            return [dict(r) for r in db.execute('SELECT * FROM roots ORDER BY path')]

    def add_root(self, path):
        path = self._root_path(path)
        if self.directory.is_relative_to(Path(path)) or Path(path).is_relative_to(self.directory):
            raise LibraryError('曲库目录不可包含扩展的索引或回收站')
        with self.lock, self.db() as db:
            for r in db.execute('SELECT path FROM roots'):
                if path == r['path']:
                    return {'id': db.execute('SELECT id FROM roots WHERE path=?', (path,)).fetchone()[0]}
                if Path(path).is_relative_to(r['path']) or Path(r['path']).is_relative_to(path):
                    raise LibraryError('该目录与已选目录重叠，请选择其中一个')
            rid = uuid.uuid4().hex
            db.execute('INSERT INTO roots VALUES (?,?,NULL)', (rid, path))
        return {'id': rid}

    def remove_root(self, rid):
        with self.lock, self.db() as db:
            if db.execute("SELECT 1 FROM files WHERE root_id=? AND state IN ('trash','moving','restoring')", (rid,)).fetchone():
                raise LibraryError('请先恢复该目录的回收站文件，再移除目录')
            if db.execute("SELECT 1 FROM tasks WHERE state IN ('running','queued')").fetchone():
                raise LibraryError('请等待正在执行的任务结束')
            db.execute('DELETE FROM files WHERE root_id=?', (rid,))
            db.execute('DELETE FROM roots WHERE id=?', (rid,))
            db.execute('DELETE FROM songs WHERE id NOT IN (SELECT song_id FROM files)')
        return {}

    def _ingest(self, db, rid, relative, st, meta, sha='', provider='', track_id='', song_hint=None):
        old = db.execute('SELECT * FROM files WHERE root_id=? AND relative=?', (rid, relative)).fetchone()
        if old and old['state'] in {'trash', 'moving', 'restoring'}:
            raise LibraryError('原路径已有回收记录，请先恢复或将新文件改名')
        # Exact copies can be grouped. Metadata matches require full artist/album
        # and almost identical duration. Never strip Live/remaster from titles.
        song = db.execute('SELECT song_id FROM files WHERE sha256=? AND size=? LIMIT 1', (sha, st.st_size)).fetchone() if sha else None
        sid = song[0] if song else None
        if not sid and provider and track_id:
            match = db.execute('SELECT song_id FROM files WHERE provider=? AND track_id=? LIMIT 1', (provider, track_id)).fetchone()
            sid = match[0] if match else None
        sid = sid or song_hint
        if not sid and meta['artist'] and meta['album']:
            for row in db.execute('SELECT * FROM songs WHERE ABS(duration-?) < 1.1', (meta['duration_s'],)):
                if all(_key(row[k]) == _key(meta[k]) for k in ('title', 'artist', 'album')):
                    sid = row['id']
                    break
        sid = sid or uuid.uuid4().hex
        fid = old['id'] if old else uuid.uuid4().hex
        db.execute('INSERT OR IGNORE INTO songs VALUES (?,?,?,?,?,?)', (sid, meta['title'], meta['artist'], meta['album'], meta['duration_s'], fid))
        db.execute('''INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                   (fid, sid, rid, relative, 'available', *_identity(st), meta['format'], meta['bitrate'], meta['sample_rate'], sha, None,
                    provider or (old['provider'] if old else ''), track_id or (old['track_id'] if old else '')))
        return fid

    def snapshot(self, query='', page=1, filter='all', root_id=''):
        page = max(1, min(int(page), 100000))
        with self.db() as db:
            roots = [dict(r) for r in db.execute('SELECT * FROM roots ORDER BY path')]
            params = [f'%{query[:200]}%'] * 3
            where = "f.state IN ('available','missing') AND (s.title LIKE ? OR s.artist LIKE ? OR s.album LIKE ?)"
            if root_id:
                where += ' AND f.root_id=?'
                params.append(root_id)
            having = ' HAVING COUNT(*)>1' if filter == 'multi' else ''
            groups = f'SELECT s.id FROM songs s JOIN files f ON f.song_id=s.id WHERE {where} GROUP BY s.id{having}'
            total = db.execute('SELECT COUNT(*) FROM (' + groups + ')', params).fetchone()[0]
            ids = [r[0] for r in db.execute(groups + ' ORDER BY s.title,s.id LIMIT 50 OFFSET ?', (*params, (page-1)*50))]
            songs = []
            for sid in ids:
                song = dict(db.execute('SELECT * FROM songs WHERE id=?', (sid,)).fetchone())
                files = [self._file_view(dict(r)) for r in db.execute('SELECT f.*,r.path AS root FROM files f JOIN roots r ON r.id=f.root_id WHERE song_id=? AND state IN (\'available\',\'missing\') ORDER BY bitrate DESC', (sid,))]
                song['files'] = files
                if song['preferred'] not in [f['id'] for f in files if f['state'] == 'available']:
                    song['preferred'] = next((f['id'] for f in files if f['state'] == 'available'), None)
                selected = next((f for f in files if f['id'] == song['preferred']), None)
                song['cover_url'] = (f"/app/fnmusic-ext/api/library/cover?id={selected['id']}&v={selected['sha256']}"
                                     if selected else '')
                song['duration_s'] = song.pop('duration')
                songs.append(song)
            trash = [self._file_view(dict(r)) for r in db.execute("SELECT f.*,r.path AS root,s.title,s.artist FROM files f JOIN roots r ON r.id=f.root_id JOIN songs s ON s.id=f.song_id WHERE state IN ('trash','moving','restoring') ORDER BY f.rowid DESC")]
            stats = dict(db.execute("SELECT COUNT(DISTINCT song_id) AS songs,COUNT(*) AS files,SUM(size) AS bytes FROM files WHERE state='available'").fetchone())
            stats['multi'] = db.execute("SELECT COUNT(*) FROM (SELECT song_id FROM files WHERE state='available' GROUP BY song_id HAVING COUNT(*)>1)").fetchone()[0]
            stats['exact_copies'] = db.execute("SELECT COALESCE(SUM(n-1),0) FROM (SELECT COUNT(*) n FROM files WHERE state='available' AND sha256!='' GROUP BY sha256 HAVING n>1)").fetchone()[0]
            tasks = [dict(r) for r in db.execute('SELECT id,kind,state,title,progress,error,created,updated FROM tasks ORDER BY created DESC LIMIT 100')]
            return {'roots': roots, 'songs': songs, 'total': total, 'page': page, 'trash': trash, 'stats': stats, 'tasks': tasks}

    @staticmethod
    def _file_view(row):
        row['path'] = str(Path(row.pop('root')) / row['relative'])
        for key in ('dev', 'ino', 'mtime', 'trash_path'):
            row.pop(key, None)
        return row

    def cover(self, fid):
        """Read embedded artwork from an indexed, identity-checked audio file.

        Try another version of the same recording when the selected file has no
        artwork. No network lookup, image rewriting or audio-file mutation.
        """
        from mutagen import File, MutagenError
        with self.db() as db:
            selected = db.execute("SELECT song_id FROM files WHERE id=? AND state='available'", (fid,)).fetchone()
            if not selected:
                return None
            rows = list(db.execute("SELECT f.*,r.path AS root FROM files f JOIN roots r ON r.id=f.root_id WHERE f.song_id=? AND state='available' ORDER BY f.id!=?", (selected['song_id'], fid)))
        for row in rows:
            try:
                with self._open_file(row['root'], row['relative'], row) as (fd, _, _, _):
                    with os.fdopen(os.dup(fd), 'rb') as stream:
                        audio = File(stream)
                    pictures = sorted(getattr(audio, 'pictures', []), key=lambda p: p.type != 3)
                    candidates = [p.data for p in pictures]
                    tags = getattr(audio, 'tags', None) or {}
                    if hasattr(tags, 'getall'):
                        candidates.extend(p.data for p in sorted(tags.getall('APIC'), key=lambda p: p.type != 3))
                    candidates.extend(bytes(p) for p in tags.get('covr', []))
                    for encoded in tags.get('metadata_block_picture', []):
                        if len(encoded) <= 7*1024*1024:
                            from mutagen.flac import Picture
                            candidates.append(Picture(base64.b64decode(encoded, validate=True)).data)
                    for data in candidates:
                        if not 0 < len(data) <= 5*1024*1024:
                            continue
                        mime = ('image/jpeg' if data.startswith(b'\xff\xd8\xff') else
                                'image/png' if data.startswith(b'\x89PNG\r\n\x1a\n') else
                                'image/webp' if data[:4] == b'RIFF' and data[8:12] == b'WEBP' else None)
                        if mime:
                            return data, mime
            except (OSError, ValueError, LibraryError, MutagenError):
                continue
        return None

    def prefer(self, fid):
        with self.lock, self.db() as db:
            row = db.execute("SELECT f.*,r.path AS root FROM files f JOIN roots r ON r.id=f.root_id WHERE f.id=? AND state='available'", (fid,)).fetchone()
            if not row:
                raise LibraryError('文件不存在或已移入回收站')
            with self._open_file(row['root'], row['relative'], row):
                db.execute('UPDATE songs SET preferred=? WHERE id=?', (fid, row['song_id']))
        return {}

    def _recover_moves(self):
        with self.db() as db:
            rows = list(db.execute("SELECT f.*,r.path AS root FROM files f JOIN roots r ON r.id=f.root_id WHERE state IN ('moving','restoring')"))
            for row in rows:
                src = Path(row['root']) / row['relative']
                dest = self.trash / row['trash_path']
                # If both exist, retain the journal and both copies for recovery.
                if src.exists() and dest.exists():
                    continue
                state = 'trash' if dest.is_file() and not src.exists() else 'available' if src.is_file() else 'missing'
                db.execute('UPDATE files SET state=? WHERE id=?', (state, row['id']))

    def move_to_trash(self, fid):
        with self.lock:
            with self.db() as db:
                row = db.execute("SELECT f.*,r.path AS root FROM files f JOIN roots r ON r.id=f.root_id WHERE f.id=? AND state='available'", (fid,)).fetchone()
                if not row:
                    raise LibraryError('该文件已被移动或不存在')
                target = uuid.uuid4().hex + Path(row['relative']).suffix.lower()
                with self._open_file(row['root'], row['relative'], row) as (fd, st, parent, name):
                    sha = _digest(fd)
                    db.execute("UPDATE files SET state='moving',trash_path=?,sha256=? WHERE id=?", (target, sha, fid))
                    db.commit()  # Intent must survive a crash between copy and unlink.
                    dest = self.trash / target
                    try:
                        with dest.open('xb') as output:
                            os.chmod(dest, 0o600)
                            os.lseek(fd, 0, os.SEEK_SET)
                            with os.fdopen(os.dup(fd), 'rb') as source:
                                shutil.copyfileobj(source, output, 1024*1024)
                            output.flush()
                            os.fsync(output.fileno())
                        check = os.open(dest, os.O_RDONLY | os.O_NOFOLLOW)
                        try:
                            if _digest(check) != sha or _identity(os.fstat(fd)) != _identity(st):
                                raise LibraryError('复制校验失败，原文件已保留')
                        finally:
                            os.close(check)
                        if _identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != _identity(st):
                            raise LibraryError('文件已被替换，原文件已保留')
                        os.unlink(name, dir_fd=parent)
                        os.fsync(parent)
                    except Exception:
                        # Never remove a recovery copy if source vanished.
                        if os.path.lexists(Path(row['root']) / row['relative']):
                            dest.unlink(missing_ok=True)
                            db.execute("UPDATE files SET state='available',trash_path=NULL WHERE id=?", (fid,))
                            db.commit()
                        raise
                    db.execute("UPDATE files SET state='trash' WHERE id=?", (fid,))
        return {}

    def restore(self, fid):
        with self.lock, self.db() as db:
            row = db.execute("SELECT f.*,r.path AS root FROM files f JOIN roots r ON r.id=f.root_id WHERE f.id=? AND state IN ('trash','restoring','moving')", (fid,)).fetchone()
            if not row or not row['trash_path']:
                raise LibraryError('回收记录不存在')
            source = self.trash / row['trash_path']
            with self._parent(row['root'], row['relative']) as (parent, name):
                fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    if _digest(fd) != row['sha256']:
                        raise LibraryError('回收文件校验失败，未恢复')
                    db.execute("UPDATE files SET state='restoring' WHERE id=?", (fid,))
                    db.commit()
                    try:
                        output = os.open(name, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o644, dir_fd=parent)
                    except FileExistsError:
                        raise LibraryError('原路径已有文件，请先将现有文件改名，恢复不会覆盖') from None
                    try:
                        while chunk := os.read(fd, 1024*1024):
                            view = memoryview(chunk)
                            while view:
                                view = view[os.write(output, view):]
                        os.fsync(output)
                        if _digest(output) != row['sha256']:
                            raise LibraryError('恢复校验失败，回收文件已保留')
                        st = os.fstat(output)
                    except BaseException:
                        os.unlink(name, dir_fd=parent)
                        raise
                    finally:
                        os.close(output)
                    os.fsync(parent)
                    source.unlink()
                    db.execute("UPDATE files SET state='available',dev=?,ino=?,size=?,mtime=?,trash_path=NULL WHERE id=?", (*_identity(st), fid))
                finally:
                    os.close(fd)
        return {}

    def enqueue(self, kind, payload):
        if kind not in {'scan', 'convert', 'download'}:
            raise LibraryError('未知任务类型')
        # Store a strict, small payload. Never persist direct audio URLs/cookies.
        if kind == 'download':
            p = payload.get('platform')
            track = payload.get('track') or {}
            if p not in PLATFORMS or not isinstance(track, dict):
                raise LibraryError('请选择支持的平台歌曲')
            tid = str(track.get('id') or '')
            if not re.fullmatch(r'[A-Za-z0-9_:.-]{1,180}', tid):
                raise LibraryError('歌曲标识无效')
            allowed_prefix = {name: name + ':' for name in PLATFORMS}[p]
            if not tid.startswith(allowed_prefix):
                raise LibraryError('歌曲标识与平台不匹配')
            payload = {'platform': p, 'root_id': str(payload.get('root_id') or ''), 'quality': str(payload.get('quality') or ''),
                       'track': {k: str(track.get(k) or '')[:1000] for k in ('id', 'title', 'artist', 'album')}}
            payload['track']['duration_s'] = max(0, min(float(track.get('duration_s') or 0), 86400))
            if p == 'kuwo' and payload['quality'] != 'original':
                raise LibraryError('该平台目前按音源实际音质保存，暂不支持指定档位')
        elif kind == 'convert':
            payload = {'file_id': str(payload.get('file_id') or ''), 'quality': str(payload.get('quality') or ''), 'root_id': str(payload.get('root_id') or '')}
        else:
            payload = {}
        if kind == 'convert' and payload['quality'] not in {'mp3_128', 'mp3_320'} or kind == 'download' and payload['quality'] not in QUALITY | {'original'}:
            raise LibraryError('不支持的目标音质')
        title = '扫描曲库' if kind == 'scan' else payload.get('track', {}).get('title') or '转换音质'
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        with self.lock, self.db() as db:
            old = db.execute("SELECT id FROM tasks WHERE kind=? AND payload=? AND state IN ('running','queued')", (kind, encoded)).fetchone()
            if old:
                return {'task_id': old[0]}
            if db.execute("SELECT COUNT(*) FROM tasks WHERE state IN ('running','queued')").fetchone()[0] >= 100:
                raise LibraryError('任务队列已满，请稍后再添加')
            tid = uuid.uuid4().hex
            db.execute('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)', (tid, kind, 'queued', title, encoded, 0, '', time.time(), time.time()))
        self._start_worker()
        return {'task_id': tid}

    def _start_worker(self):
        with self.lock:
            if self.worker and self.worker.is_alive():
                return
            self.worker = threading.Thread(target=self._run, daemon=True)
            self.worker.start()

    def _task_update(self, tid, **changes):
        with self.db() as db:
            changes['updated'] = time.time()
            db.execute('UPDATE tasks SET ' + ','.join(f'{k}=?' for k in changes) + ' WHERE id=?', (*changes.values(), tid))

    def _run(self):
        while True:
            with self.lock, self.db() as db:
                task = db.execute("SELECT * FROM tasks WHERE state='queued' ORDER BY created LIMIT 1").fetchone()
                if task is None:
                    self.worker = None
                    return
                db.execute("UPDATE tasks SET state='running',updated=? WHERE id=?", (time.time(), task['id']))
            try:
                if task['kind'] == 'scan':
                    note = self.scan(task['id'])
                else:
                    note = self._produce(task['kind'], json.loads(task['payload']), task['id'])
                self._task_update(task['id'], state='done', progress=100, error=note or '')
            except Exception as exc:
                message = str(exc) if isinstance(exc, LibraryError) else '任务未完成，请检查目录权限、可用空间或平台连接后重试'
                self._task_update(task['id'], state='failed', error=message[:500])

    def scan(self, task_id=None):
        skipped, count = 0, 0
        # fwalk gives pinned dir descriptors; O_NOFOLLOW rejects links and FIFOs.
        for root in self.roots():
            seen = set()
            with self._open_directory(root['path']) as rootfd:
                before = os.fstat(rootfd)
                def fail_walk(exc):
                    raise exc
                for directory, dirs, names, dirfd in os.fwalk('.', topdown=True, follow_symlinks=False, dir_fd=rootfd, onerror=fail_walk):
                    dirs[:] = [d for d in dirs if not d.startswith('.') and not d.startswith('@')]
                    for name in names:
                        if Path(name).suffix.lower() not in MEDIA_EXTENSIONS or name.startswith('.'):
                            continue
                        relative = str(Path(directory) / name)
                        seen.add(relative)
                        try:
                            with self.lock, self.db() as db, self._open_file(root['path'], relative) as (fd, st, _, _):
                                old = db.execute('SELECT * FROM files WHERE root_id=? AND relative=?', (root['id'], relative)).fetchone()
                                if old and _identity(st) == tuple(old[k] for k in ('dev', 'ino', 'size', 'mtime')):
                                    db.execute("UPDATE files SET state='available' WHERE id=? AND state='missing'", (old['id'],))
                                    continue
                                meta = self.metadata(fd, relative)
                                # Hash new files, not the entire unchanged library on every scan.
                                sha = _digest(fd)
                                if _identity(os.fstat(fd)) != _identity(st):
                                    raise LibraryError('文件正在变化')
                                self._ingest(db, root['id'], relative, st, meta, sha)
                            count += 1
                            if task_id and count % 25 == 0:
                                self._task_update(task_id, error=f'已读取 {count} 个文件')
                        except (OSError, ValueError, ImportError):
                            skipped += 1
                # Do not mark a disconnected/replaced root as an empty library.
                with self._open_directory(root['path']) as checkfd:
                    after = os.fstat(checkfd)
                    if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                        raise LibraryError('目录在扫描期间发生变化，请重新扫描')
            with self.lock, self.db() as db:
                for row in db.execute("SELECT id,relative FROM files WHERE root_id=? AND state='available'", (root['id'],)):
                    if row['relative'] not in seen:
                        db.execute("UPDATE files SET state='missing' WHERE id=?", (row['id'],))
                db.execute('UPDATE roots SET last_scan=? WHERE id=?', (time.time(), root['id']))
        return f'已更新 {count} 个文件' + (f'，{skipped} 个文件未能读取' if skipped else '')

    def _produce(self, kind, payload, tid):
        with self.db() as db:
            root = db.execute('SELECT * FROM roots WHERE id=?', (payload['root_id'],)).fetchone()
            if not root:
                raise LibraryError('请选择保存目录')
            source = db.execute("SELECT f.*,r.path AS root FROM files f JOIN roots r ON r.id=f.root_id WHERE f.id=? AND state='available'", (payload.get('file_id', ''),)).fetchone()
        stage = self.staging / (tid + '.part')
        stage.unlink(missing_ok=True)
        source_meta = None
        provider, track_id = '', ''
        try:
            if kind == 'convert':
                if not source:
                    raise LibraryError('原文件不存在，请重新扫描')
                rate = 128 if payload['quality'] == 'mp3_128' else 320
                if source['bitrate'] and source['format'] not in {'FLAC', 'WAV', 'AIFF', 'APE', 'ALAC'} and source['bitrate'] < rate*1000 - 10000:
                    raise LibraryError('原文件码率低于目标档位，不能转换为真正的更高音质')
                ffmpeg = shutil.which('ffmpeg')
                if not ffmpeg:
                    raise LibraryError('NAS 宿主缺少 ffmpeg，暂不可进行本地转换')
                with self._open_file(source['root'], source['relative'], source) as (fd, st, _, _):
                    source_meta = self.metadata(fd, source['relative'])
                    result = subprocess.run([ffmpeg, '-v', 'error', '-nostdin', '-i', f'/proc/self/fd/{fd}', '-map', '0:a:0', '-vn', '-codec:a', 'libmp3lame', '-b:a', f'{rate}k', '-f', 'mp3', str(stage)], pass_fds=(fd,), capture_output=True, timeout=600)
                    if result.returncode or _identity(os.fstat(fd)) != _identity(st):
                        raise LibraryError('音频转换失败，原文件已保留')
                provider, track_id = source['provider'], source['track_id']
            else:
                track = payload['track']
                track_id, provider = track['id'], payload['platform']
                with self.db() as db:
                    existing = list(db.execute("SELECT f.*,r.path AS root FROM files f JOIN roots r ON r.id=f.root_id WHERE f.provider=? AND f.track_id=? AND f.state='available'", (provider, track_id)))
                for f in existing:
                    requested = payload['quality']
                    matches = requested == 'original' or requested == 'lossless' and f['format'] == 'FLAC' or requested in {'mp3_128', 'mp3_320'} and f['format'] == 'MP3' and abs(f['bitrate'] - (128000 if requested == 'mp3_128' else 320000)) < 25000
                    if matches:
                        try:
                            with self._open_file(f['root'], f['relative'], f):
                                return '该音质已在曲库中，未重复保存'
                        except (OSError, LibraryError):
                            pass
                # Fixed loopback service, never accept a caller-provided URL.
                url = self.media_url + '/stream?' + urllib.parse.urlencode({'id': track_id, 'proxy': 'true', 'quality': '' if payload['quality'] == 'original' else payload['quality']})
                try:
                    with urllib.request.urlopen(url, timeout=45) as response, stage.open('xb') as output:
                        if response.status != 200:
                            raise LibraryError('音源未返回完整音频，请重新搜索或验证账号')
                        size = 0
                        expected_size = int(response.headers.get('Content-Length') or 0)
                        deadline = time.monotonic() + 600
                        while chunk := response.read(65536):
                            size += len(chunk)
                            if time.monotonic() > deadline:
                                raise LibraryError('下载超过十分钟，请稍后重试')
                            if size > 1024*1024*1024:
                                raise LibraryError('音频超过单文件 1GB 上限')
                            output.write(chunk)
                        if expected_size and size != expected_size:
                            raise LibraryError('下载未完成，音频未保存，请重试')
                        output.flush()
                        os.fsync(output.fileno())
                except Exception as exc:
                    if isinstance(exc, LibraryError):
                        raise
                    raise LibraryError('下载失败，请重新搜索歌曲或验证对应平台的账号') from None
                source_meta = track
            fd = os.open(stage, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                meta = self.metadata(fd, stage)
                if meta['duration_s'] < 1:
                    raise LibraryError('返回内容不是完整音频')
                expected_duration = float(source_meta.get('duration_s') or 0)
                if expected_duration and abs(meta['duration_s'] - expected_duration) > max(3, expected_duration*0.02):
                    raise LibraryError('返回音频的时长与歌曲不符，文件未保存')
                # Preserve reliable source identity for re-acquisition.
                for key in ('title', 'artist', 'album'):
                    meta[key] = source_meta.get(key) or meta[key]
                if kind == 'download' and provider in {'qq', 'kugou', 'netease'} and payload['quality'] != 'original':
                    expected = {'mp3_128': ('MP3', 128000), 'mp3_320': ('MP3', 320000), 'lossless': ('FLAC', 0)}[payload['quality']]
                    if meta['format'] != expected[0] or expected[1] and abs(meta['bitrate']-expected[1]) > 25000:
                        raise LibraryError('实际音质与所选档位不符，文件未安装')
                sha = _digest(fd)
            finally:
                os.close(fd)
            ext = {'MP3': '.mp3', 'FLAC': '.flac', 'M4A': '.m4a', 'WAV': '.wav', 'OGGVORBIS': '.ogg', 'OGGOPUS': '.opus'}.get(meta['format'])
            if not ext:
                raise LibraryError('当前不支持保存这种音频格式')
            safe = re.sub(r'[/\\\x00-\x1f]', '_', f"{meta['artist']} - {meta['title']}").strip(' .')[:140]
            # The quality is in metadata/UI; never append it to a song title.
            relative = safe + '-' + tid[:8] + ext
            with self.lock, self._parent(root['path'], relative) as (parent, name):
                with self.db() as db:
                    if db.execute("SELECT 1 FROM files WHERE sha256=? AND state='available'", (sha,)).fetchone():
                        return '相同音频已在曲库中，未重复保存'
                temporary = '.fnmusic-' + tid + '.part'
                try:
                    os.unlink(temporary, dir_fd=parent)
                except FileNotFoundError:
                    pass
                output = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o644, dir_fd=parent)
                try:
                    with stage.open('rb') as src, os.fdopen(output, 'wb', closefd=False) as dst:
                        shutil.copyfileobj(src, dst, 1024*1024)
                        dst.flush()
                        os.fsync(output)
                    if _digest(output) != sha:
                        raise LibraryError('音频写入校验失败，文件未安装')
                    st = os.fstat(output)
                    # Publish fully written bytes without overwriting any file.
                    os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                    os.fsync(parent)
                    with self.db() as db:
                        self._ingest(db, root['id'], relative, st, meta, sha, provider, track_id, source['song_id'] if kind == 'convert' else None)
                except BaseException:
                    raise
                finally:
                    os.close(output)
                    os.unlink(temporary, dir_fd=parent)
            return '已保存；可在飞牛音乐中刷新曲库'
        finally:
            stage.unlink(missing_ok=True)

    def dispatch(self, req):
        action = req.get('action')
        if action == 'list':
            return self.snapshot(str(req.get('query') or ''), req.get('page', 1), req.get('filter', 'all'), str(req.get('root_id') or ''))
        if action == 'add_root':
            return self.add_root(req.get('path'))
        if action == 'remove_root':
            return self.remove_root(str(req.get('id') or ''))
        if action == 'trash':
            return self.move_to_trash(str(req.get('id') or ''))
        if action == 'restore':
            return self.restore(str(req.get('id') or ''))
        if action == 'prefer':
            return self.prefer(str(req.get('id') or ''))
        if action == 'enqueue':
            return self.enqueue(req.get('kind'), req.get('payload') or {})
        if action in {'cancel', 'retry'}:
            with self.lock, self.db() as db:
                row = db.execute('SELECT * FROM tasks WHERE id=?', (str(req.get('id') or ''),)).fetchone()
                if not row or row['state'] not in ({'queued'} if action == 'cancel' else {'failed', 'interrupted'}):
                    raise LibraryError('任务当前状态不允许此操作')
                db.execute('UPDATE tasks SET state=?,error=?,updated=? WHERE id=?', ('cancelled' if action == 'cancel' else 'queued', '', time.time(), row['id']))
            if action == 'retry':
                self._start_worker()
            return {}
        raise LibraryError('未知曲库操作')
