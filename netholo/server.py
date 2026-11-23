"""Servidor HTTP + WebSocket.

O mesmo processo entrega a página WebXR (arquivos de `web/`) e mantém um WebSocket em `/ws`.
O WebSocket é um "cano" sempre aberto: o óculos manda pedidos (JSON) e o agente responde com
eventos em tempo real, sem o óculos precisar perguntar de novo (como acontece no HTTP comum).

Protocolo (tudo JSON):
  óculos → PC   {"id": 7, "type": "ping", "params": {"target": "192.168.0.1"}}
  PC → óculos   {"type": "terminal", "id": 7, "command": "ping -n 4 ..."}
                {"type": "terminal", "id": 7, "line": "Resposta de ..."}
                {"type": "event", "id": 7, "event": "ping.reply", "data": {...}}
                {"type": "done", "id": 7, "data": {...}}  ou  {"type": "error", "id": 7, ...}
                {"type": "push", "topic": "throughput", "data": {...}}  (a cada 1 s)
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

from . import __version__
from .agent import Agent
from .errors import USER_FACING_ERRORS, AgentError, InvalidRequestError
from .runner import sanitize_line
from .security import origin_allowed, token_matches, validate_hostname, validate_target

log = logging.getLogger(__name__)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_MESSAGE_BYTES = 4096
MAX_CONCURRENT_TASKS = 3
RATE_LIMIT_MESSAGES = 20  # por janela
RATE_LIMIT_WINDOW = 2.0  # segundos
CONNECTIONS_EVERY = 3  # segundos

# script-src libera só o próprio servidor e a CDN do three.js (versão fixa no código).
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; connect-src 'self'; "
    "img-src 'self' data: blob:; style-src 'self'; object-src 'none'; base-uri 'none'; "
    "frame-ancestors 'none'; form-action 'none'"
)
SECURITY_HEADERS = {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    # O token vai na URL; sem Referer ele nunca é enviado para a CDN.
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


@dataclass(frozen=True)
class Settings:
    token: str
    web_dir: Path = WEB_DIR


SETTINGS_KEY = web.AppKey("settings", Settings)
AGENT_KEY = web.AppKey("agent", Agent)


class RequestContext:
    """Liga a saída de um pedido ao `id` dele (implementa o `Reporter` do agente)."""

    def __init__(self, session: Session, request_id: int) -> None:
        self._session = session
        self._id = request_id

    async def event(self, name: str, data: dict) -> None:
        await self._session.send({"type": "event", "id": self._id, "event": name, "data": data})

    async def command(self, text: str) -> None:
        await self._session.send({"type": "terminal", "id": self._id, "command": text})

    async def line(self, text: str) -> None:
        await self._session.send({"type": "terminal", "id": self._id, "line": sanitize_line(text)})


Handler = Callable[["Session", RequestContext, dict], Awaitable[dict]]


async def _local_info(session: Session, ctx: RequestContext, params: dict) -> dict:
    return await session.agent.local_info(ctx)


async def _lan_scan(session: Session, ctx: RequestContext, params: dict) -> dict:
    return await session.agent.lan_scan(ctx)


async def _ping(session: Session, ctx: RequestContext, params: dict) -> dict:
    return await session.agent.ping(validate_target(params.get("target")), ctx)


async def _traceroute(session: Session, ctx: RequestContext, params: dict) -> dict:
    return await session.agent.traceroute(validate_target(params.get("target")), ctx)


async def _dns(session: Session, ctx: RequestContext, params: dict) -> dict:
    return await session.agent.dns(validate_hostname(params.get("name")), ctx)


async def _watch_connections(session: Session, ctx: RequestContext, params: dict) -> dict:
    enabled = params.get("on")
    if not isinstance(enabled, bool):
        raise InvalidRequestError("'on' precisa ser true ou false.")
    session.watch_connections = enabled
    if enabled:
        await session.push_connections()
    return {"on": enabled}


# Lista fechada: o óculos só consegue pedir exatamente estas ações.
HANDLERS: dict[str, Handler] = {
    "local.info": _local_info,
    "lan.scan": _lan_scan,
    "ping": _ping,
    "traceroute": _traceroute,
    "dns": _dns,
    "connections.watch": _watch_connections,
}


class Session:
    """Uma conexão WebSocket (um óculos ou uma aba do navegador)."""

    def __init__(self, ws: web.WebSocketResponse, agent: Agent) -> None:
        self.ws = ws
        self.agent = agent
        self.watch_connections = False
        self._send_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()
        self._running: set[str] = set()
        self._recent: deque[float] = deque()

    async def send(self, message: dict[str, Any]) -> None:
        if self.ws.closed:
            return
        async with self._send_lock:
            with contextlib.suppress(ConnectionResetError):
                await self.ws.send_json(message)

    async def _error(self, request_id: int | None, message: str) -> None:
        await self.send({"type": "error", "id": request_id, "message": message})

    async def run(self) -> None:
        pusher = asyncio.create_task(self._push_loop())
        try:
            await self.send({"type": "hello", "version": __version__, "demo": self.agent.demo})
            async for message in self.ws:
                if message.type == WSMsgType.TEXT:
                    await self._on_text(message.data)
                elif message.type == WSMsgType.ERROR:
                    break
        finally:
            pusher.cancel()
            for task in self._tasks:
                task.cancel()
            await asyncio.gather(pusher, *self._tasks, return_exceptions=True)

    def _within_rate_limit(self) -> bool:
        now = time.monotonic()
        while self._recent and now - self._recent[0] > RATE_LIMIT_WINDOW:
            self._recent.popleft()
        self._recent.append(now)
        return len(self._recent) <= RATE_LIMIT_MESSAGES

    async def _on_text(self, raw: str) -> None:
        if not self._within_rate_limit():
            await self._error(None, "Muitas mensagens em pouco tempo.")
            return
        try:
            request = json.loads(raw)
        except json.JSONDecodeError:
            await self._error(None, "Mensagem não é um JSON válido.")
            return
        if not isinstance(request, dict):
            await self._error(None, "Formato de mensagem inválido.")
            return

        request_id = request.get("id")
        if not isinstance(request_id, int) or isinstance(request_id, bool):
            await self._error(None, "Pedido sem 'id' numérico.")
            return
        action = request.get("type")
        handler = HANDLERS.get(action) if isinstance(action, str) else None
        params = request.get("params", {})
        if handler is None:
            await self._error(request_id, "Ação desconhecida.")
        elif not isinstance(params, dict):
            await self._error(request_id, "'params' precisa ser um objeto.")
        elif action in self._running:
            await self._error(request_id, "Essa ação já está em andamento.")
        elif len(self._tasks) >= MAX_CONCURRENT_TASKS:
            await self._error(request_id, "Muitas ações ao mesmo tempo; espere uma terminar.")
        else:
            task = asyncio.create_task(self._execute(request_id, action, handler, params))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _execute(self, request_id: int, action: str, handler: Handler, params: dict) -> None:
        self._running.add(action)
        try:
            data = await handler(self, RequestContext(self, request_id), params)
            await self.send({"type": "done", "id": request_id, "data": data})
        except USER_FACING_ERRORS as exc:
            await self._error(request_id, str(exc))
        except Exception:
            log.exception("Falha ao executar %s", action)
            await self._error(request_id, "Erro interno no agente (veja o terminal do PC).")
        finally:
            self._running.discard(action)

    async def push_connections(self) -> None:
        try:
            data = await self.agent.connections()
        except AgentError as exc:
            self.watch_connections = False
            await self._error(None, str(exc))
            return
        await self.send({"type": "push", "topic": "connections", "data": data})

    async def _push_loop(self) -> None:
        ticks = 0
        while not self.ws.closed:
            await asyncio.sleep(1)
            ticks += 1
            await self.send(
                {"type": "push", "topic": "throughput", "data": self.agent.throughput()}
            )
            if self.watch_connections and ticks % CONNECTIONS_EVERY == 0:
                await self.push_connections()


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    settings = request.app[SETTINGS_KEY]
    if not origin_allowed(request.headers.get("Origin"), request.host):
        raise web.HTTPForbidden(text="Origem não permitida.")
    if not token_matches(settings.token, request.query.get("token")):
        raise web.HTTPUnauthorized(text="Token inválido.")

    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_MESSAGE_BYTES)
    await ws.prepare(request)
    log.info("Visualizador conectado (%s)", request.remote)
    await Session(ws, request.app[AGENT_KEY]).run()
    log.info("Visualizador desconectado (%s)", request.remote)
    return ws


async def _add_security_headers(request: web.Request, response: web.StreamResponse) -> None:
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    if request.path == "/":
        response.headers["Cache-Control"] = "no-store"


async def _close_agent(app: web.Application) -> None:
    app[AGENT_KEY].close()


def create_app(settings: Settings, agent: Agent) -> web.Application:
    app = web.Application(client_max_size=MAX_MESSAGE_BYTES)
    app[SETTINGS_KEY] = settings
    app[AGENT_KEY] = agent
    app.on_response_prepare.append(_add_security_headers)
    app.on_cleanup.append(_close_agent)

    index = settings.web_dir / "index.html"

    async def index_handler(request: web.Request) -> web.FileResponse:
        return web.FileResponse(index)

    app.router.add_get("/", index_handler)
    app.router.add_get("/ws", websocket_handler)
    for folder in ("js", "css"):
        app.router.add_static(f"/{folder}/", settings.web_dir / folder, follow_symlinks=False)
    return app
