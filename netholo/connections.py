"""Conexões do PC por programa (nível 6) e vazão da placa de rede.

Equivale a `netstat -ano` + Gerenciador de Tarefas: o psutil lê a tabela de conexões do
sistema e diz qual processo (PID) é dono de cada uma.
"""

from __future__ import annotations

import asyncio
import socket
import time
from collections import OrderedDict, defaultdict
from concurrent.futures import ThreadPoolExecutor

import psutil

from .errors import AgentError
from .security import ip_scope
from .services import service_name

MAX_CONNECTIONS = 150
MAX_PROCESSES = 10
MAX_PER_PROCESS = 12


class ReverseDns:
    """DNS reverso (IP → nome) com cache e limite de consultas simultâneas.

    `gethostbyaddr` bloqueia, então roda num pool de threads próprio e pequeno, para que
    consultas lentas não travem o resto do agente.
    """

    def __init__(self, max_entries: int = 1024, workers: int = 8) -> None:
        self._cache: OrderedDict[str, str | None] = OrderedDict()
        self._max_entries = max_entries
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="rdns")
        self._inflight: dict[str, asyncio.Future[str | None]] = {}

    def cached(self, ip: str) -> str | None:
        return self._cache.get(ip)

    def _store(self, ip: str, name: str | None) -> None:
        self._cache[ip] = name
        self._cache.move_to_end(ip)
        while len(self._cache) > self._max_entries:
            self._cache.popitem(last=False)

    @staticmethod
    def _lookup(ip: str) -> str | None:
        try:
            name = socket.gethostbyaddr(ip)[0]
        except OSError:
            return None
        return None if name == ip else name

    def _start(self, ip: str) -> asyncio.Future[str | None]:
        future = self._inflight.get(ip)
        if future is None:
            loop = asyncio.get_running_loop()
            future = loop.run_in_executor(self._pool, self._lookup, ip)
            self._inflight[ip] = future
            future.add_done_callback(lambda f, ip=ip: self._finish(ip, f))
        return future

    async def resolve(self, ip: str, timeout: float = 2.0) -> str | None:
        if ip in self._cache:
            return self._cache[ip]
        try:
            # shield: se o tempo acabar, a consulta continua e o resultado vai para o cache.
            return await asyncio.wait_for(asyncio.shield(self._start(ip)), timeout)
        except TimeoutError:
            return None

    def _finish(self, ip: str, future: asyncio.Future[str | None]) -> None:
        self._inflight.pop(ip, None)
        if not future.cancelled() and future.exception() is None:
            self._store(ip, future.result())

    async def resolve_many(self, ips: list[str], timeout: float = 2.0) -> dict[str, str | None]:
        names = await asyncio.gather(*(self.resolve(ip, timeout) for ip in ips))
        return dict(zip(ips, names, strict=True))

    def prefetch(self, ips: set[str]) -> None:
        """Agenda consultas em segundo plano; os nomes aparecem nas próximas atualizações."""
        for ip in ips:
            if ip not in self._cache:
                self._start(ip)

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)


class ConnectionMonitor:
    def __init__(self, rdns: ReverseDns) -> None:
        self._rdns = rdns
        self._process_names: dict[int, str] = {}
        self._last_io: tuple[float, int, int] | None = None

    def _process_name(self, pid: int | None) -> str:
        if not pid:
            return "sistema"
        if pid not in self._process_names:
            try:
                self._process_names[pid] = psutil.Process(pid).name()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                return "desconhecido"
        return self._process_names[pid]

    def _collect(self) -> list[dict]:
        try:
            raw = psutil.net_connections(kind="inet")
        except psutil.AccessDenied as exc:
            raise AgentError("Sem permissão para ler as conexões neste sistema.") from exc

        alive_pids = {c.pid for c in raw if c.pid}
        for pid in list(self._process_names):
            if pid not in alive_pids:  # PIDs são reaproveitados pelo sistema
                del self._process_names[pid]

        connections = []
        for conn in raw:
            if not conn.raddr:
                continue
            is_tcp = conn.type == socket.SOCK_STREAM
            if is_tcp and conn.status != psutil.CONN_ESTABLISHED:
                continue
            remote_ip, remote_port = conn.raddr.ip, conn.raddr.port
            scope = ip_scope(remote_ip)
            if scope in ("loopback", "unknown"):
                continue
            local_port = conn.laddr.port if conn.laddr else None
            connections.append(
                {
                    "process": self._process_name(conn.pid),
                    "proto": "TCP" if is_tcp else "UDP",
                    "lport": local_port,
                    "rip": remote_ip,
                    "rport": remote_port,
                    "service": service_name(remote_port) or service_name(local_port),
                    "status": conn.status if is_tcp else None,
                    "scope": scope,
                }
            )
            if len(connections) >= MAX_CONNECTIONS:
                break
        return connections

    async def snapshot(self) -> dict:
        connections = await asyncio.to_thread(self._collect)
        self._rdns.prefetch({c["rip"] for c in connections})

        by_process: dict[str, list[dict]] = defaultdict(list)
        for conn in connections:
            conn["host"] = self._rdns.cached(conn["rip"])
            by_process[conn.pop("process")].append(conn)

        ranked = sorted(by_process.items(), key=lambda item: (-len(item[1]), item[0]))
        processes = [
            {"name": name, "count": len(conns), "connections": conns[:MAX_PER_PROCESS]}
            for name, conns in ranked[:MAX_PROCESSES]
        ]
        return {"total": len(connections), "processes": processes}

    def throughput(self) -> dict:
        """Bytes por segundo desde a última chamada (todas as placas de rede somadas)."""
        io = psutil.net_io_counters()
        now = time.monotonic()
        rx_bps = tx_bps = 0.0
        if self._last_io is not None:
            then, rx_before, tx_before = self._last_io
            elapsed = max(now - then, 1e-3)
            rx_bps = max(io.bytes_recv - rx_before, 0) / elapsed
            tx_bps = max(io.bytes_sent - tx_before, 0) / elapsed
        self._last_io = (now, io.bytes_recv, io.bytes_sent)
        return {"rx_bps": round(rx_bps), "tx_bps": round(tx_bps)}
