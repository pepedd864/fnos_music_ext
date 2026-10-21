from pathlib import Path
import os
import threading

import pytest
from proxy.library_manager import LibraryManager, LibraryError


def metadata(fd, path):
    return {'title': 'Song Live' if 'live' in str(path) else 'Song', 'artist': 'Artist', 'album': 'Album',
            'duration_s': 180, 'format': 'FLAC' if str(path).endswith('.flac') else 'MP3',
            'bitrate': 128000, 'sample_rate': 44100}


@pytest.fixture
def manager(tmp_path):
    root = tmp_path / 'music'
    root.mkdir()
    m = LibraryManager(tmp_path / 'private', metadata=metadata)
    m.add_root(str(root))
    return m, root


def test_scan_groups_versions_but_keeps_live_and_detects_copies(manager):
    m, root = manager
    (root / 'one.mp3').write_bytes(b'audio-one')
    (root / 'two.flac').write_bytes(b'audio-two')
    (root / 'live.mp3').write_bytes(b'live-audio')
    (root / 'copy.mp3').write_bytes(b'audio-one')
    m.scan()
    data = m.snapshot()
    assert data['stats']['songs'] == 2
    assert data['stats']['files'] == 4
    assert data['stats']['exact_copies'] == 1
    assert sorted(len(s['files']) for s in data['songs']) == [1, 3]
    m.scan()
    assert m.snapshot()['stats'] == data['stats']
    assert m.snapshot(query='Live')['total'] == 1
    assert m.snapshot(filter='multi')['total'] == 1


def test_trash_restore_durable_and_does_not_overwrite(manager):
    m, root = manager
    path = root / 'one.mp3'
    path.write_bytes(b'original-audio')
    m.scan()
    fid = m.snapshot()['songs'][0]['files'][0]['id']
    m.move_to_trash(fid)
    assert not path.exists()
    assert len(m.snapshot()['trash']) == 1
    m = LibraryManager(m.directory, metadata=metadata)
    path.write_bytes(b'other-file')
    with pytest.raises(LibraryError, match='已有文件'):
        m.restore(fid)
    assert path.read_bytes() == b'other-file'
    path.unlink()
    m.restore(fid)
    assert path.read_bytes() == b'original-audio'
    assert m.snapshot()['trash'] == []
    assert m.snapshot()['songs'][0]['files'][0]['id'] == fid


def test_modified_file_and_symlink_escape_are_rejected(manager, tmp_path):
    m, root = manager
    outside = tmp_path / 'outside'
    outside.mkdir()
    external = outside / 'secret.mp3'
    external.write_bytes(b'private')
    (root / 'linked.mp3').symlink_to(external)
    (root / 'folder').symlink_to(outside, target_is_directory=True)
    (root / 'fifo.mp3').touch()
    (root / 'one.mp3').write_bytes(b'audio')
    m.scan()
    files = [f for s in m.snapshot()['songs'] for f in s['files']]
    assert not any(f['path'].endswith('linked.mp3') for f in files)
    assert not any('/folder/' in f['path'] for f in files)
    fid = next(f['id'] for f in files if f['path'].endswith('one.mp3'))
    (root / 'one.mp3').unlink()
    (root / 'one.mp3').symlink_to(external)
    with pytest.raises(OSError):
        m.move_to_trash(fid)
    assert external.read_bytes() == b'private'
    assert not m.snapshot()['trash']


def test_overlapping_roots_and_private_tree_not_allowed(manager):
    m, root = manager
    child = root / 'album'
    child.mkdir()
    with pytest.raises(LibraryError, match='重叠'):
        m.add_root(str(child))
    with pytest.raises(LibraryError):
        m.add_root(str(m.directory))
    with pytest.raises(LibraryError):
        m.add_root('/etc')
    assert len(m.roots()) == 1


def test_missing_file_is_listed_without_deleting_other_roots(manager):
    m, root = manager
    path = root / 'one.mp3'
    path.write_bytes(b'audio')
    m.scan()
    path.unlink()
    m.scan()
    assert m.snapshot()['songs'][0]['files'][0]['state'] == 'missing'
    path.write_bytes(b'new audio')
    m.scan()
    assert m.snapshot()['songs'][0]['files'][0]['state'] == 'available'


def test_preference_is_preserved_across_rescan_and_trash_falls_back(manager):
    m, root = manager
    (root / 'one.mp3').write_bytes(b'mp3 audio')
    (root / 'two.flac').write_bytes(b'flac audio')
    m.scan()
    song = m.snapshot()['songs'][0]
    fid = song['files'][1]['id']
    m.prefer(fid)
    m.scan()
    assert m.snapshot()['songs'][0]['preferred'] == fid
    m.move_to_trash(fid)
    assert m.snapshot()['songs'][0]['preferred'] != fid
    with pytest.raises(LibraryError):
        m.remove_root(m.roots()[0]['id'])
    m.restore(fid)
    assert m.snapshot()['songs'][0]['preferred'] == fid


def test_tasks_dedupe_cancel_retry_and_survive_restart(manager, monkeypatch):
    m, root = manager
    monkeypatch.setattr(m, '_start_worker', lambda: None)
    first = m.enqueue('scan', {})['task_id']
    assert m.enqueue('scan', {})['task_id'] == first
    assert len(m.snapshot()['tasks']) == 1
    m = LibraryManager(m.directory, metadata=metadata)
    assert m.snapshot()['tasks'][0]['state'] == 'interrupted'
    monkeypatch.setattr(m, '_start_worker', lambda: None)
    m.dispatch({'action': 'retry', 'id': first})
    assert m.snapshot()['tasks'][0]['state'] == 'queued'
    m.dispatch({'action': 'cancel', 'id': first})
    assert m.snapshot()['tasks'][0]['state'] == 'cancelled'
    with pytest.raises(LibraryError):
        m.enqueue('download', {'platform': 'qq', 'quality': 'mp3_128', 'track': {'id': 'https://evil'}})
    with pytest.raises(LibraryError):
        m.enqueue('download', {'platform': 'kuwo', 'quality': 'lossless', 'track': {'id': 'kuwo:123'}})


@pytest.mark.skipif(not Path('/proc/self/fd').exists(), reason='host conversion uses Linux pinned file descriptors')
def test_real_audio_conversion_preserves_source_and_groups_versions(manager):
    import shutil
    import subprocess
    from proxy.library_manager import read_metadata
    if not shutil.which('ffmpeg'):
        pytest.skip('ffmpeg required')
    m, root = manager
    m.metadata = read_metadata
    source = root / 'original.flac'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-metadata', 'title=Test Tone', '-metadata', 'artist=Test', '-metadata', 'album=Test Album', str(source)], check=True)
    original = source.read_bytes()
    m.scan()
    file = m.snapshot()['songs'][0]['files'][0]
    payload = {'file_id': file['id'], 'quality': 'mp3_128', 'root_id': m.roots()[0]['id']}
    m._produce('convert', payload, 'a'*32)
    assert source.read_bytes() == original
    songs = m.snapshot()['songs']
    assert len(songs) == 1
    assert len(songs[0]['files']) == 2
    assert {f['format'] for f in songs[0]['files']} == {'MP3', 'FLAC'}
    assert len(m.snapshot()['tasks']) == 0
    m._produce('convert', payload, 'b'*32)
    assert m.snapshot()['stats']['files'] == 2
