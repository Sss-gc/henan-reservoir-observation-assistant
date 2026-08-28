from __future__ import annotations

import httpx

from backend.app.services.imagery import _request_json, _search_source


RESERVOIR = {
    "geometry": {
        "type": "Polygon",
        "coordinates": [[[113.0, 34.0], [113.1, 34.0], [113.1, 34.1], [113.0, 34.0]]],
    }
}


def test_stac_search_follows_next_link_and_deduplicates() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(200, json={
                "features": [{"id": "one"}, {"id": "duplicate"}],
                "links": [{"rel": "next", "href": "/next", "method": "POST", "body": {"token": "2"}}],
            })
        return httpx.Response(200, json={
            "features": [{"id": "duplicate"}, {"id": "two"}],
            "links": [],
        })

    with httpx.Client(transport=httpx.MockTransport(handler), base_url="https://example.test") as client:
        items = _search_source(
            client,
            {"url": "https://example.test/search", "collection": "demo"},
            RESERVOIR,
            __import__("datetime").datetime(2026, 1, 1),
            __import__("datetime").datetime(2026, 2, 1),
            10,
        )
    assert calls == 2
    assert [item["id"] for item in items] == ["one", "duplicate", "two"]


def test_stac_request_retries_server_failure(monkeypatch) -> None:
    calls = 0
    monkeypatch.setattr("backend.app.services.imagery.time.sleep", lambda _: None)

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503 if calls < 3 else 200, json={} if calls == 3 else {"error": "busy"})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert _request_json(client, "GET", "https://example.test/search") == {}
    assert calls == 3
