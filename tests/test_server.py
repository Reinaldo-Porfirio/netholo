"""Testes do servidor com o agente de demonstração (nada de rede real)."""

import pytest
from aiohttp import WSMsgType

from netholo.demo import DemoAgent
from netholo.server import CONTENT_SECURITY_POLICY, Settings, create_app

TOKEN = "token-de-teste-123"


@pytest.fixture
async def client(aiohttp_client):
    app = create_app(Settings(token=TOKEN), DemoAgent(speed=0, seed=1))
    return await aiohttp_client(app)


async def _connect(client, **kwargs):
    ws = await client.ws_connect(f"/ws?token={TOKEN}", **kwargs)
    hello = await ws.receive_json()
    assert hello["type"] == "hello" and hello["demo"] is True
    return ws


async def _until_done(ws, request_id):
    """Junta tudo o que chega para um pedido até o 'done' ou 'error'."""
    received = []
    while True:
        message = await ws.receive_json(timeout=5)
        if message.get("type") == "push":
            continue
        received.append(message)
        if message.get("id") == request_id and message["type"] in ("done", "error"):
            return received


async def test_index_has_security_headers(client):
    response = await client.get("/")
    assert response.status == 200
    assert "NetHolo" in await response.text()
    assert response.headers["Content-Security-Policy"] == CONTENT_SECURITY_POLICY
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["X-Content-Type-Options"] == "nosniff"


async def test_static_files_and_no_path_traversal(client):
    assert (await client.get("/js/main.js")).status == 200
    assert (await client.get("/js/../../netholo/server.py")).status in (403, 404)
    assert (await client.get("/js/%2e%2e/%2e%2e/pyproject.toml")).status in (403, 404)


async def test_websocket_requires_token(client):
    response = await client.get("/ws?token=errado")
    assert response.status == 401
    response = await client.get("/ws")
    assert response.status == 401


async def test_websocket_rejects_foreign_origin(client):
    response = await client.get(f"/ws?token={TOKEN}", headers={"Origin": "https://evil.example"})
    assert response.status == 403


async def test_ping_streams_terminal_events_and_result(client):
    ws = await _connect(client)
    await ws.send_json({"id": 1, "type": "ping", "params": {"target": "192.168.0.1"}})
    messages = await _until_done(ws, 1)
    kinds = [m["type"] for m in messages]
    assert kinds[0] == "terminal" and "ping" in messages[0]["command"]
    assert sum(1 for m in messages if m.get("event") == "ping.reply") == 4
    assert messages[-1]["type"] == "done" and messages[-1]["data"]["sent"] == 4
    await ws.close()


async def test_scan_trace_dns_and_connections(client):
    ws = await _connect(client)
    await ws.send_json({"id": 2, "type": "lan.scan"})
    scan = await _until_done(ws, 2)
    assert any(m.get("event") == "lan.device" for m in scan)

    await ws.send_json({"id": 3, "type": "traceroute", "params": {"target": "1.1.1.1"}})
    trace = await _until_done(ws, 3)
    assert trace[-1]["data"]["reached"] is True

    await ws.send_json({"id": 4, "type": "dns", "params": {"name": "github.com"}})
    first = (await _until_done(ws, 4))[-1]["data"]
    await ws.send_json({"id": 5, "type": "dns", "params": {"name": "github.com"}})
    second = (await _until_done(ws, 5))[-1]["data"]
    assert first["cached"] is False and second["cached"] is True

    await ws.send_json({"id": 6, "type": "connections.watch", "params": {"on": True}})
    while True:
        message = await ws.receive_json(timeout=5)
        if message.get("topic") == "connections":
            assert message["data"]["processes"]
            break
    await ws.close()


@pytest.mark.parametrize(
    ("payload", "fragment"),
    [
        ({"id": 7, "type": "rm -rf"}, "desconhecida"),
        ({"id": 8, "type": "ping", "params": {"target": "-t 8.8.8.8"}}, "inválido"),
        ({"id": 9, "type": "ping", "params": "8.8.8.8"}, "objeto"),
        ({"id": 10, "type": "dns", "params": {"name": "nada.invalid"}}, "não encontrou"),
        ({"id": 11, "type": "connections.watch", "params": {"on": "sim"}}, "true ou false"),
    ],
)
async def test_invalid_requests_get_safe_errors(client, payload, fragment):
    ws = await _connect(client)
    await ws.send_json(payload)
    reply = (await _until_done(ws, payload["id"]))[-1]
    assert reply["type"] == "error" and fragment in reply["message"]
    await ws.close()


async def test_malformed_messages(client):
    ws = await _connect(client)
    await ws.send_str("isso não é json")
    assert (await ws.receive_json())["type"] == "error"
    await ws.send_json({"type": "ping"})  # sem id
    assert (await ws.receive_json())["type"] == "error"
    await ws.close()


async def test_oversized_message_closes_connection(client):
    ws = await _connect(client)
    await ws.send_str("x" * 10_000)
    message = await ws.receive(timeout=5)
    while message.type == WSMsgType.TEXT:  # pode chegar um push antes do fechamento
        message = await ws.receive(timeout=5)
    assert message.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR)


async def test_rate_limit(client):
    ws = await _connect(client)
    for i in range(30):
        await ws.send_json({"id": 100 + i, "type": "nada"})
    messages = [await ws.receive_json(timeout=5) for _ in range(30)]
    assert any("Muitas mensagens" in m.get("message", "") for m in messages)
    await ws.close()
