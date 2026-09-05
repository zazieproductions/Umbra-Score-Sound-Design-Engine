"""Local ``.env`` loading for the UMBRA backend.

Secrets — the Freesound API key above all — belong in a git-ignored ``.env``
at the repository root. This module is the only place that reads it, and it
never logs, echoes or returns a secret value to a caller.

The parser is deliberately tiny and dependency-free (the service requirements
must stay installable offline):

    # comment lines are ignored
    export NAME=value          # optional `export ` prefix
    NAME=value                 # plain assignment
    NAME="value"               # surrounding quotes are stripped
    NAME='value'

Rules that keep it honest:

* **The process environment always wins.** A variable already exported in the
  shell is never overwritten by the file, so real deployments override the
  file without editing it.
* **Loading is idempotent.** Repeated calls are cheap and harmless; use
  ``force=True`` (tests, long-running reloads) to re-read the file.
* **Nothing here is ever sent to the browser.** Values land in
  ``os.environ`` for backend code only; no API endpoint returns them.

Full setup: ``docs/development/FREESOUND.md``.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Dict, List, Optional

#: Environment variable that points at an alternative env file (tests, CI).
ENV_FILE_ENV = "UMBRA_ENV_FILE"

#: Default file name, resolved at the repository root.
ENV_FILE_NAME = ".env"

_REPO_ROOT = Path(__file__).resolve().parent.parent
_LOCK = threading.Lock()
_LOADED_FILE: Optional[Path] = None

_QUOTES = ("'", '"')


def repo_root() -> Path:
    """Absolute path of the repository root (parent of ``backend/``)."""
    return _REPO_ROOT


def env_file_path() -> Path:
    """Path of the env file the backend will read.

    ``UMBRA_ENV_FILE`` wins when set (absolute, or relative to the cwd);
    otherwise the repository-root ``.env``.
    """
    override = os.environ.get(ENV_FILE_ENV)
    if override:
        p = Path(override).expanduser()
        return p if p.is_absolute() else (Path.cwd() / p)
    return _REPO_ROOT / ENV_FILE_NAME


def parse_env_text(text: str) -> Dict[str, str]:
    """Parse ``KEY=VALUE`` lines. No side effects, fully unit-testable."""
    values: Dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        # strip a trailing comment only for unquoted values
        if value and value[0] not in _QUOTES:
            hash_at = value.find(" #")
            if hash_at >= 0:
                value = value[:hash_at].strip()
        if len(value) >= 2 and value[0] in _QUOTES and value[-1] == value[0]:
            value = value[1:-1]
        values[key] = value
    return values


def load_local_env(*, force: bool = False) -> Optional[Path]:
    """Load the repo-root ``.env`` into ``os.environ`` (missing keys only).

    Returns the path that was loaded, or ``None`` when there is no file.
    Existing process variables are never overwritten.
    """
    global _LOADED_FILE
    with _LOCK:
        path = env_file_path()
        if not force and _LOADED_FILE is not None and _LOADED_FILE == path:
            return _LOADED_FILE
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            _LOADED_FILE = path
            return None
        for key, value in parse_env_text(text).items():
            os.environ.setdefault(key, value)
        _LOADED_FILE = path
        return path


def loaded_env_file() -> Optional[Path]:
    """Which file was loaded, if any (tests inspect this)."""
    return _LOADED_FILE


def missing_env_names(names: List[str]) -> List[str]:
    """Names that are unset *or* empty in the current environment."""
    return [n for n in names if not os.environ.get(n)]
