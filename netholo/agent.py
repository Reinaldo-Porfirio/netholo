"""O agente: executa os comandos de rede de cada nível e relata o progresso.

Cada método recebe um `Reporter`, que manda para o óculos:
- `command(texto)`: o comando que está rodando (aparece no terminal espelho);
- `line(texto)`: cada linha de saída real do comando;
- `event(nome, dados)`: dados estruturados para animar os hologramas.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
import time
from dataclasses import asdict
from pathlib import Path
from typing import Protocol

import psutil

from . import commands
from .connections import ConnectionMonitor, ReverseDns
from .errors import AgentError
from .oui import OuiDatabase, is_randomized
from .parsers import (
    PingStreamParser,
    normalize_mac,
    parse_arp,
    parse_default_gateway,
    parse_dns_servers,
    parse_ping_reply,
    parse_resolv_conf,
    parse_trace_line,
)
from .runner import command_text, run_streaming, run_text
from .security import ip_scope

LOCAL_INFO_TTL = 30.0
SCAN_COOLDOWN = 15.0
SWEEP_CONCURRENCY = 48
MAX_SWEEP_PREFIX = 24
TRACE_MAX_HOPS = 20


class Reporter(Protocol):
    async def event(self, name: str, data: dict) -> None: ...
    async def command(self, text: str) -> None: ...
    async def line(self, text: str) -> None: ...


class Agent(Protocol):
    """Interface comum ao agente real e ao de demonstração."""

    demo: bool

    async def local_info(self, reporter: Reporter) -> dict: ...
    async def lan_scan(self, reporter: Reporter) -> dict: ...
    async def ping(self, target: str, reporter: Reporter) -> dict: ...
    async def traceroute(self, target: str, reporter: Reporter) -> dict: ...
    async def dns(self, name: str, reporter: Reporter) -> dict: ...
    async def connections(self) -> dict: ...
    def throughput(self) -> dict: ...
    def close(self) -> None: ...


def primary_ipv4() -> str | None:
    """IP da placa que leva à Internet.

    "Conectar" um socket UDP não envia nenhum pacote: só faz o sistema escolher a rota,
    e com isso descobrimos qual IP local seria usado.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            sock.connect(("8.8.8.8", 80))
        except OSError:
            return None
        return sock.getsockname()[0]


def _interface_for(ip: str) -> tuple[str, str, str | None] | None:
    for name, addresses in psutil.net_if_addrs().items():
        ipv4 = next((a for a in addresses if a.family == socket.AF_INET and a.address == ip), None)
        if ipv4 is None:
            continue
        mac = next((a.address for a in addresses if a.family == psutil.AF_LINK), None)
        return name, ipv4.netmask or "255.255.255.0", normalize_mac(mac) if mac else None
    return None


def sweep_network(ip: str, netmask: str) -> ipaddress.IPv4Network:
    """Rede a varrer. Redes maiores que /24 são limitadas ao /24 do PC (no máximo 254 IPs)."""
    network = ipaddress.IPv4Interface(f"{ip}/{netmask}").network
    if network.prefixlen < MAX_SWEEP_PREFIX:
        network = ipaddress.IPv4Interface(f"{ip}/{MAX_SWEEP_PREFIX}").network
    return network


class RealAgent:
    demo = False

    def __init__(self, oui: OuiDatabase | None = None) -> None:
        self._oui = oui or OuiDatabase()
        self._rdns = ReverseDns()
        self._monitor = ConnectionMonitor(self._rdns)
        self._local_cache: tuple[float, dict] | None = None
        self._scan_lock = asyncio.Lock()
        self._last_scan = float("-inf")

    # ---------- Nível 1: configuração do PC ----------

    async def _dns_servers(self, interface: str) -> list[str]:
        args = commands.dns_servers()
        if args is None:
            try:
                return parse_resolv_conf(Path("/etc/resolv.conf").read_text("utf-8"))
            except OSError:
                return []
        servers = parse_dns_servers(await run_text(args, timeout=10))
        return servers.get(interface, [])

    async def _collect_local(self) -> dict:
        ip = primary_ipv4()
        found = _interface_for(ip) if ip else None
        if not ip or not found:
            raise AgentError("Nenhuma rede IPv4 ativa foi encontrada neste PC.")
        interface, netmask, mac = found
        gateway = parse_default_gateway(await run_text(commands.default_route(), 5), ip)
        dns = await self._dns_servers(interface)
        network = ipaddress.IPv4Interface(f"{ip}/{netmask}").network
        stats = psutil.net_if_stats().get(interface)
        return {
            "hostname": socket.gethostname(),
            "interface": interface,
            "ip": ip,
            "netmask": netmask,
            "prefix": network.prefixlen,
            "network": str(network),
            "hosts": max(network.num_addresses - 2, 0),
            "mac": mac,
            "gateway": gateway,
            "dns": dns,
            "speed_mbps": stats.speed if stats else None,
        }

    async def _local(self, force: bool = False) -> dict:
        now = time.monotonic()
        if force or self._local_cache is None or now - self._local_cache[0] > LOCAL_INFO_TTL:
            self._local_cache = (now, await self._collect_local())
        return self._local_cache[1]

    async def local_info(self, reporter: Reporter) -> dict:
        await reporter.command("ipconfig /all  (lido com psutil + route print)")
        info = await self._local(force=True)
        rows = [
            ("Adaptador", info["interface"]),
            ("Endereço IPv4", info["ip"]),
            ("Máscara de sub-rede", f"{info['netmask']}  (/{info['prefix']})"),
            ("Rede", f"{info['network']}  ({info['hosts']} IPs possíveis)"),
            ("Gateway padrão", info["gateway"] or "nenhum"),
            ("Servidores DNS", ", ".join(info["dns"]) or "nenhum"),
            ("Endereço físico (MAC)", info["mac"] or "?"),
        ]
        for label, value in rows:
            await reporter.line(f"{label:.<26} {value}")
        return info

    # ---------- Nível 2: aparelhos da rede local ----------

    def _mac_fields(self, mac: str) -> dict:
        return {"mac": mac, "vendor": self._oui.lookup(mac), "randomized": is_randomized(mac)}

    async def _ping_once(self, ip: str, timeout_ms: int = 500) -> float | None:
        output = await run_text(commands.ping(ip, count=1, timeout_ms=timeout_ms), timeout=4)
        for line in output.splitlines():
            if reply := parse_ping_reply(line):
                return reply[0] if reply[0] is not None else 0.0
        return None

    async def lan_scan(self, reporter: Reporter) -> dict:
        if self._scan_lock.locked():
            raise AgentError("Já existe uma varredura em andamento.")
        if time.monotonic() - self._last_scan < SCAN_COOLDOWN:
            raise AgentError("Espere alguns segundos antes de varrer de novo.")
        async with self._scan_lock:
            self._last_scan = time.monotonic()
            return await self._scan(reporter)

    async def _scan(self, reporter: Reporter) -> dict:
        info = await self._local()
        network = sweep_network(info["ip"], info["netmask"])
        roles = {info["ip"]: "self", info["gateway"]: "gateway"}
        devices: dict[str, dict] = {}

        async def publish(ip: str, **fields: object) -> None:
            device = devices.setdefault(ip, {"ip": ip, "role": roles.get(ip, "device")})
            changed = {k: v for k, v in fields.items() if device.get(k) != v}
            if changed or len(device) == 2:
                device.update(fields)
                await reporter.event("lan.device", dict(device))

        async def read_arp(show: bool) -> None:
            args = commands.arp_table()
            output = await run_text(args, timeout=10)
            if show:
                await reporter.command(command_text(args))
                for line in output.splitlines()[:40]:
                    await reporter.line(line)
            for entry in parse_arp(output, network):
                await publish(entry.ip, **self._mac_fields(entry.mac))

        # 1) O que o PC já conhece (cache ARP): aparece na hora.
        await read_arp(show=True)

        # 2) Ping em cada IP da sub-rede para acordar quem estiver online.
        hosts = [str(h) for h in network.hosts() if str(h) != info["ip"]]
        await reporter.command(
            f"ping sweep {network}  ({len(hosts)} IPs, {SWEEP_CONCURRENCY} por vez)"
        )
        await reporter.event("lan.sweep", {"network": str(network), "total": len(hosts)})
        limit = asyncio.Semaphore(SWEEP_CONCURRENCY)

        async def probe(ip: str) -> None:
            async with limit:
                rtt = await self._ping_once(ip)
            if rtt is not None:
                await publish(ip, rtt_ms=rtt, online=True)

        await asyncio.gather(*(probe(ip) for ip in hosts))

        # 3) Quem respondeu agora está na tabela ARP: pegamos MAC, fabricante e nome.
        await read_arp(show=False)
        names = await self._rdns.resolve_many(list(devices), timeout=2.0)
        for ip, name in names.items():
            if name:
                await publish(ip, name=name)

        await reporter.line(f"{len(devices)} aparelhos encontrados em {network}")
        return {"network": str(network), "count": len(devices)}

    # ---------- Nível 3: ping ----------

    async def ping(self, target: str, reporter: Reporter) -> dict:
        args = commands.ping(target, count=4)
        await reporter.command(command_text(args))
        parser = PingStreamParser()
        replies = []

        async def on_line(line: str) -> None:
            await reporter.line(line)
            if reply := parser.feed(line):
                replies.append(reply)
                await reporter.event("ping.reply", asdict(reply))

        await run_streaming(args, timeout=20, on_line=on_line)
        times = [r.rtt_ms for r in replies if r.ok and r.rtt_ms is not None]
        return {
            "target": target,
            "sent": len(replies),
            "received": sum(r.ok for r in replies),
            "avg_ms": round(sum(times) / len(times), 1) if times else None,
        }

    # ---------- Nível 4: traceroute ----------

    async def _resolve_ipv4(self, name: str) -> str:
        loop = asyncio.get_running_loop()
        try:
            infos = await asyncio.wait_for(
                loop.getaddrinfo(name, None, family=socket.AF_INET, type=socket.SOCK_STREAM), 5
            )
        except (OSError, TimeoutError) as exc:
            raise AgentError(f"Não foi possível encontrar o IP de {name}.") from exc
        return infos[0][4][0]

    async def traceroute(self, target: str, reporter: Reporter) -> dict:
        address = await self._resolve_ipv4(target)
        await reporter.event("trace.start", {"target": target, "address": address})
        args = commands.traceroute(address, TRACE_MAX_HOPS)
        await reporter.command(command_text(args))
        hops = []

        async def on_line(line: str) -> None:
            await reporter.line(line)
            if hop := parse_trace_line(line):
                hops.append(hop)
                await reporter.event("trace.hop", {**asdict(hop), "scope": ip_scope(hop.ip)})

        await run_streaming(args, timeout=90, on_line=on_line)
        return {
            "target": target,
            "address": address,
            "hops": len(hops),
            "reached": any(h.ip == address for h in hops),
        }

    # ---------- Nível 5: DNS ----------

    async def dns(self, name: str, reporter: Reporter) -> dict:
        info = await self._local()
        loop = asyncio.get_running_loop()
        started = time.perf_counter()
        try:
            infos = await asyncio.wait_for(loop.getaddrinfo(name, None, type=socket.SOCK_STREAM), 5)
        except (OSError, TimeoutError) as exc:
            raise AgentError(f"O DNS não encontrou {name}.") from exc
        elapsed_ms = (time.perf_counter() - started) * 1000
        addresses = list(dict.fromkeys(item[4][0] for item in infos))[:8]

        args = commands.nslookup(name)
        await reporter.command(command_text(args))
        await run_streaming(args, timeout=10, on_line=reporter.line)
        return {
            "name": name,
            "addresses": addresses,
            "ms": round(elapsed_ms, 1),
            "servers": info["dns"],
            # Abaixo de ~2 ms a resposta quase certamente veio do cache local do Windows.
            "cached": elapsed_ms < 2,
        }

    # ---------- Nível 6: conexões ----------

    async def connections(self) -> dict:
        return await self._monitor.snapshot()

    def throughput(self) -> dict:
        return self._monitor.throughput()

    def close(self) -> None:
        self._rdns.close()
