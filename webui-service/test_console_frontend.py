"""Run the Ant Design console's configuration contracts with Node, without npm dependencies."""
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
HERE = Path(__file__).resolve().parent


@pytest.mark.skipif(NODE is None, reason="Node is required in CI")
def test_console_settings_contracts():
    result = subprocess.run(
        [NODE, "--test", *[str(path) for path in sorted((HERE / 'console/tests').glob('*.test.mjs'))]],
        capture_output=True, text=True, timeout=120, cwd=HERE,
    )
    assert result.returncode == 0, result.stdout + result.stderr
