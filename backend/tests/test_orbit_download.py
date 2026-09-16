from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from backend.app.services import orbit


def test_omm_download_retries_timeouts_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = 0
    delays: list[int] = []

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise httpx.ReadTimeout("temporary timeout", request=request)
        return httpx.Response(200, json=[{"NORAD_CAT_ID": 40697, "EPOCH": "2026-09-16T00:00:00Z"}])

    monkeypatch.setattr(orbit.time, "sleep", delays.append)
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        omm, _ = orbit._download_omm(client, SimpleNamespace(norad_cat_id=40697))

    assert omm["NORAD_CAT_ID"] == 40697
    assert attempts == 3
    assert delays == [1, 2]


def test_omm_download_stops_after_three_timeouts(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = 0

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        raise httpx.ReadTimeout("persistent timeout", request=request)

    monkeypatch.setattr(orbit.time, "sleep", lambda _: None)
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(httpx.ReadTimeout):
            orbit._download_omm(client, SimpleNamespace(norad_cat_id=40697))

    assert attempts == 3
