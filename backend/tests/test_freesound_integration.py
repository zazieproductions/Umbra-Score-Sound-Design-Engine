"""Tests for the server-side Freesound integration.

Every test is MOCKED: no request ever reaches freesound.org. `httpx.MockTransport`
is injected through the FastAPI dependency, and the API key is a throwaway
literal defined right here — never a real credential, never loaded from `.env`.

What these tests pin down:

* the key is read from the environment only, and never appears in a response
* authenticated search / metadata / similar / preview / download routing
* honest failure modes: not configured (503), rejected key (502),
  OAuth-required (501), upstream unreachable (502)
* the preview proxy refuses non-Freesound media hosts (SSRF guard)
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, Dict, List, Optional

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app import app
from backend.env import parse_env_text
from backend.integrations import freesound as fs
from backend.integrations.freesound import FreesoundClient, FreesoundError
from backend.integrations.router import get_client

# A throwaway test key. It is NOT a credential for any real account — it exists
# so the suite can assert the key is *handled* correctly without ever holding a
# real one.
TEST_KEY = "umbra-test-key-not-a-real-credential"
TEST_OAUTH = "umbra-test-oauth-token"

Handler = Callable[[httpx.Request], httpx.Response]


def json_response(payload: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=payload)


def sound_payload(sound_id: int = 9201, **over: Any) -> Dict[str, Any]:
    sound: Dict[str, Any] = {
        "id": sound_id,
        "url": f"https://freesound.org/sounds/{sound_id}/",
        "name": f"door_creak_{sound_id}",
        "tags": ["door", "wood", "hinge"],
        "description": "old wooden door opening slowly",
        "username": "field_recorder_anne",
        "license": "Attribution",
        "type": "wav",
        "channels": 1,
        "filesize": 88200,
        "duration": 1.8,
        "samplerate": 44100,
        "created": "2021-01-01T00:00:00Z",
        "num_downloads": 100,
        "avg_rating": 4.0,
        "previews": {
            "preview-hq-mp3": f"https://freesound.org/data/previews/{sound_id}_hq.mp3",
            "preview-lq-mp3": f"https://freesound.org/data/previews/{sound_id}_lq.mp3",
        },
        "images": {},
        "score": 92,
        "md5": f"md5-{sound_id}",
    }
    sound.update(over)
    return sound


def search_handler(results: List[Dict[str, Any]], count: Optional[int] = None) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/apiv2/search/"
        return json_response(
            {"count": count if count is not None else len(results), "next": None, "previous": None, "results": results}
        )

    return handler


@pytest.fixture()
def isolated_env(tmp_path, monkeypatch):
    """Point the env loader at an empty file so no real .env leaks into tests."""
    monkeypatch.setenv("UMBRA_ENV_FILE", str(tmp_path / "no-such-env-file"))
    monkeypatch.delenv("FREESOUND_API_KEY", raising=False)
    monkeypatch.delenv("FREESOUND_OAUTH_TOKEN", raising=False)
    monkeypatch.delenv("FREESOUND_API_BASE", raising=False)
    fs.forget_probes()
    yield tmp_path
    fs.forget_probes()


@pytest.fixture()
def client(isolated_env):
    """TestClient with lifespan started, so /api/health has its app state."""
    with TestClient(app) as test_client:
        yield test_client


def override_client(key: Optional[str], handler: Handler, *, oauth: Optional[str] = None) -> None:
    transport = httpx.MockTransport(handler)
    app.dependency_overrides[get_client] = lambda: FreesoundClient(
        key, oauth=oauth, transport=transport
    )


@pytest.fixture(autouse=True)
def clear_overrides():
    yield
    app.dependency_overrides.pop(get_client, None)


# ----------------------------------------------------------------- .env loading


def test_parse_env_text_handles_comments_export_and_quotes():
    parsed = parse_env_text(
        "\n".join(
            [
                "# a comment",
                "",
                "PLAIN=value",
                "export EXPORTED=value2",
                'QUOTED="quoted value"',
                "SINGLE='single value'",
                "INLINE=value3 # trailing comment",
                "EMPTY=",
            ]
        )
    )
    assert parsed["PLAIN"] == "value"
    assert parsed["EXPORTED"] == "value2"
    assert parsed["QUOTED"] == "quoted value"
    assert parsed["SINGLE"] == "single value"
    assert parsed["INLINE"] == "value3"
    assert parsed["EMPTY"] == ""


def test_load_local_env_does_not_override_real_environment(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("UMBRA_TEST_VAR=from-file\nUMBRA_TEST_ONLY_FILE=yes\n", encoding="utf-8")
    monkeypatch.setenv("UMBRA_ENV_FILE", str(env_file))
    monkeypatch.setenv("UMBRA_TEST_VAR", "from-environment")
    monkeypatch.delenv("UMBRA_TEST_ONLY_FILE", raising=False)

    from backend.env import load_local_env

    load_local_env(force=True)

    assert __import__("os").environ["UMBRA_TEST_VAR"] == "from-environment"
    assert __import__("os").environ["UMBRA_TEST_ONLY_FILE"] == "yes"


# ---------------------------------------------------------------------- status


def test_status_not_configured_is_honest(client: TestClient):
    res = client.get("/api/integrations/freesound/status")
    assert res.status_code == 200
    body = res.json()
    assert body["configured"] is False
    assert body["connected"] is None
    assert "FREESOUND_API_KEY" in body["reason"]
    assert ".env" in (body["hint"] or "")
    # a misconfigured integration must never look available
    assert body["capabilities"]["search"] is True  # capability of the integration
    # nothing derived from a credential is published
    assert "keyHint" not in body
    assert TEST_KEY not in json.dumps(body)


def test_status_connected_when_key_accepted(isolated_env, client: TestClient):
    isolated_env  # env isolation fixture (keeps real .env out of the test)
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY
    override_client(TEST_KEY, search_handler([sound_payload()]))

    body = client.get("/api/integrations/freesound/status?probe=always").json()

    assert body["configured"] is True
    assert body["connected"] is True
    assert body["keySource"] == "environment:FREESOUND_API_KEY"
    assert body["oauth"] == {"configured": False, "quality": "preview"}
    assert body["capabilities"]["originalDownload"] is False
    # the secret itself must never be echoed
    assert TEST_KEY not in json.dumps(body)


def test_status_reports_rejected_key(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY

    def handler(request: httpx.Request) -> httpx.Response:
        return json_response({"detail": "Authentication credentials were not provided."}, status=401)

    override_client(TEST_KEY, handler)
    body = client.get("/api/integrations/freesound/status?probe=always").json()

    assert body["configured"] is True
    assert body["connected"] is False
    assert "rejected" in body["reason"]
    assert TEST_KEY not in json.dumps(body)


def test_status_unknown_when_freesound_unreachable(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network unreachable")

    override_client(TEST_KEY, handler)
    body = client.get("/api/integrations/freesound/status?probe=always").json()

    assert body["configured"] is True
    assert body["connected"] is None  # unknown — never claimed as a success
    assert body["reason"]


def test_status_never_probe_does_no_network(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("probe=never must not call Freesound")

    override_client(TEST_KEY, handler)
    body = client.get("/api/integrations/freesound/status?probe=never").json()

    assert body["configured"] is True
    assert body["connected"] is None
    assert body["probed"] is False


# ---------------------------------------------------------------------- search


def test_search_routes_through_backend_with_header_auth(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("Authorization")
        return json_response(
            {"count": 1, "next": None, "previous": None, "results": [sound_payload(9201)]}
        )

    override_client(TEST_KEY, handler)
    res = client.post(
        "/api/integrations/freesound/search",
        json={"query": "wooden door creak", "page": 2, "filters": ["duration:[0 TO 3]"], "pageSize": 15},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["provider"] == "freesound"
    assert body["count"] == 1
    assert body["sounds"][0]["id"] == 9201
    assert body["sounds"][0]["username"] == "field_recorder_anne"
    assert body["sounds"][0]["license"] == "Attribution"

    # authenticated with the header, never with a token in the URL
    assert seen["auth"] == f"Token {TEST_KEY}"
    assert "token=" not in seen["url"]
    assert "freesound.org/apiv2/search/" in seen["url"]
    assert "query=wooden+door+creak" in seen["url"]
    assert "duration%3A%5B0+TO+3%5D" in seen["url"] or "duration:" in seen["url"]
    assert "page=2" in seen["url"] and "page_size=15" in seen["url"]
    assert "license" in seen["url"] and "previews" in seen["url"]


def test_search_without_key_returns_503_and_no_results(client: TestClient):
    res = client.post("/api/integrations/freesound/search", json={"query": "door"})
    assert res.status_code == 503
    body = res.json()
    assert body["code"] == "not_configured"
    assert "FREESOUND_API_KEY" in body["error"]
    assert "sounds" not in body  # no invented results


def test_search_surfaces_upstream_auth_failure(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY
    override_client(TEST_KEY, lambda request: json_response({"detail": "bad key"}, status=403))

    res = client.post("/api/integrations/freesound/search", json={"query": "door"})
    assert res.status_code == 502
    body = res.json()
    assert body["code"] == "unauthorized"
    assert body["upstreamStatus"] == 403


def test_search_rejects_empty_query(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY
    override_client(TEST_KEY, search_handler([]))
    res = client.post("/api/integrations/freesound/search", json={"query": "   "})
    assert res.status_code == 422


# ------------------------------------------------------------ metadata / similar


def test_sound_metadata_endpoint(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/apiv2/sounds/9201/"
        return json_response(sound_payload(9201))

    override_client(TEST_KEY, handler)
    body = client.get("/api/integrations/freesound/sounds/9201").json()
    assert body["sound"]["id"] == 9201
    assert body["sound"]["url"].endswith("/sounds/9201/")
    assert body["sound"]["license"] == "Attribution"


def test_similar_uses_laion_clap_space(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return json_response({"count": 1, "next": None, "previous": None, "results": [sound_payload(9202)]})

    override_client(TEST_KEY, handler)
    body = client.get("/api/integrations/freesound/sounds/9201/similar?page=1").json()
    assert body["sounds"][0]["id"] == 9202
    assert "similarity_space=laion_clap" in seen["url"]


def test_analysis_endpoint(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY
    override_client(
        TEST_KEY, lambda request: json_response({"mfcc": "0.1,0.2", "bpm": 96.0})
    )
    body = client.get("/api/integrations/freesound/sounds/9201/analysis").json()
    assert body["features"]["bpm"] == 96.0


# -------------------------------------------------------------------- previews


def test_preview_proxy_returns_bytes_and_marks_quality(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("_hq.mp3"):
            return httpx.Response(200, content=b"ID3fake-audio-bytes", headers={"content-type": "audio/mpeg"})
        return json_response(sound_payload(9201))

    override_client(TEST_KEY, handler)
    res = client.get("/api/integrations/freesound/sounds/9201/preview")

    assert res.status_code == 200
    assert res.content == b"ID3fake-audio-bytes"
    assert res.headers["content-type"].startswith("audio/mpeg")
    assert res.headers["X-Umbra-Quality"] == "preview"


def test_preview_proxy_refuses_non_freesound_hosts(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY
    evil = sound_payload(
        9201,
        previews={"preview-hq-mp3": "https://evil.example.com/steal.mp3"},
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return json_response(evil)

    override_client(TEST_KEY, handler)
    res = client.get("/api/integrations/freesound/sounds/9201/preview")

    assert res.status_code == 502
    assert "unexpected host" in res.json()["error"]


# ------------------------------------------------------------------- downloads


def test_original_download_requires_oauth(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY
    override_client(TEST_KEY, lambda request: json_response({}))

    res = client.get("/api/integrations/freesound/sounds/9201/download")

    assert res.status_code == 501
    body = res.json()
    assert body["code"] == "oauth_required"
    assert "FREESOUND_OAUTH_TOKEN" in body["error"]


def test_original_download_with_oauth_token(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization")
        seen["path"] = request.url.path
        return httpx.Response(200, content=b"RIFFfake-wav", headers={"content-type": "audio/wav"})

    override_client(TEST_KEY, handler, oauth=TEST_OAUTH)
    res = client.get("/api/integrations/freesound/sounds/9201/download")

    assert res.status_code == 200
    assert res.headers["X-Umbra-Quality"] == "original"
    assert seen["auth"] == f"Bearer {TEST_OAUTH}"
    assert seen["path"] == "/apiv2/sounds/9201/download/"


# --------------------------------------------------------------------- health


def test_health_reports_configuration_not_secret(isolated_env, client: TestClient):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY
    body = client.get("/api/health").json()
    assert body["integrations"]["freesound"]["configured"] is True
    assert TEST_KEY not in json.dumps(body)

    os.environ.pop("FREESOUND_API_KEY")
    assert client.get("/api/health").json()["integrations"]["freesound"]["configured"] is False


# --------------------------------------------------------------- error mapping


def test_error_mapping_covers_upstream_codes():
    def err(status: int) -> FreesoundError:
        return FreesoundClient(TEST_KEY)._error_for(httpx.Response(status, json={"detail": "nope"}))

    assert err(401).code == "unauthorized"
    assert err(403).code == "unauthorized"
    assert err(404).code == "not_found"
    assert err(429).code == "rate_limited"
    assert err(500).code == "upstream_error"


def test_no_secret_is_ever_logged(isolated_env, caplog):
    import os

    os.environ["FREESOUND_API_KEY"] = TEST_KEY
    with caplog.at_level(logging.DEBUG, logger="umbra.integrations.freesound"):
        fs.describe_credentials()
    assert TEST_KEY not in caplog.text
