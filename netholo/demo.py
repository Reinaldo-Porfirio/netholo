"""Agente de demonstração: dados inventados, com o mesmo "ritmo" do agente real.

Serve para testar a cena sem rede, rodar os testes automáticos e gravar prints/GIFs para o
README sem expor a rede de casa. Os IPs públicos usam as faixas reservadas para documentação
(203.0.113.0/24 e 198.51.100.0/24), que não existem na Internet.
"""

from __future__ import annotations

import asyncio
import hashlib
import random

from .agent import Reporter
from .errors import AgentError

_LOCAL = {
    "hostname": "DEMO-PC",
    "interface": "Wi-Fi",
    "ip": "192.168.0.10",
    "netmask": "255.255.255.0",
    "prefix": 24,
    "network": "192.168.0.0/24",
    "hosts": 254,
    "mac": "02:00:5e:10:00:10",
    "gateway": "192.168.0.1",
    "dns": ["192.168.0.1"],
    "speed_mbps": 866,
}

# (último byte do IP, MAC, fabricante, nome). MACs com o bit "aleatório" imitam celulares.
_DEVICE_ROWS = [
    (1, "02:00:5e:00:00:01", "Roteador (demo)", "roteador.lan"),
    (23, "da:a1:19:3c:00:23", None, None),
    (30, "02:00:5e:00:00:30", "Smart TV (demo)", "tv-sala.lan"),
    (41, "02:00:5e:00:00:41", "Notebook (demo)", "notebook.lan"),
    (52, "02:00:5e:00:00:52", "Espressif (demo)", "lampada-smart.lan"),
    (60, "02:00:5e:00:00:60", "Impressora (demo)", None),
    (77, "7a:3f:02:9e:00:77", None, None),
]
_DEVICES = [
    {
        "ip": f"192.168.0.{last}",
        "role": "gateway" if last == 1 else "device",
        "mac": mac,
        "vendor": vendor,
        "randomized": vendor is None,
        "name": name,
    }
    for last, mac, vendor, name in _DEVICE_ROWS
]

_HOPS = [
    ("192.168.0.1", 1.0, "private"),
    ("100.64.0.1", 6.5, "cgnat"),
    ("10.120.0.1", 8.0, "private"),
    (None, None, "unknown"),
    ("198.51.100.20", 12.4, "public"),
    ("203.0.113.9", 14.1, "public"),
]

# programa → [(porta remota, serviço, IP remoto, nome do host)]
_PROCESSES = {
    "chrome.exe": [
        (443, "HTTPS", "203.0.113.10", "cdn.demo.example"),
        (443, "HTTPS", "203.0.113.11", "cdn.demo.example"),
        (443, "HTTPS", "203.0.113.24", "video.demo.example"),
        (443, "HTTPS", "198.51.100.7", None),
    ],
    "discord.exe": [
        (443, "HTTPS", "198.51.100.40", "chat.demo.example"),
        (3478, "STUN (chamadas)", "198.51.100.41", None),
    ],
    "spotify.exe": [(443, "HTTPS", "203.0.113.55", "audio.demo.example")],
    "Code.exe": [(443, "HTTPS", "198.51.100.90", "api.demo.example")],
    "svchost.exe": [(123, "NTP (hora)", "203.0.113.123", "time.demo.example")],
}
_UDP_PORTS = {123, 3478}


def _fake_ip(name: str) -> str:
    digest = hashlib.sha256(name.encode()).digest()
    return f"203.0.113.{digest[0] % 200 + 20}"


class DemoAgent:
    demo = True

    def __init__(self, speed: float = 1.0, seed: int | None = None) -> None:
        self._speed = speed
        self._rng = random.Random(seed)  # noqa: S311 - só para dados de demonstração
        self._dns_cache: set[str] = set()
        self._rx = 400_000.0

    async def _sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds * self._speed)

    async def local_info(self, reporter: Reporter) -> dict:
        await reporter.command("ipconfig /all  (modo demonstração)")
        for label, value in [
            ("Adaptador", _LOCAL["interface"]),
            ("Endereço IPv4", _LOCAL["ip"]),
            ("Máscara de sub-rede", f"{_LOCAL['netmask']}  (/24)"),
            ("Gateway padrão", _LOCAL["gateway"]),
            ("Servidores DNS", ", ".join(_LOCAL["dns"])),
            ("Endereço físico (MAC)", _LOCAL["mac"]),
        ]:
            await reporter.line(f"{label:.<26} {value}")
        return dict(_LOCAL)

    async def lan_scan(self, reporter: Reporter) -> dict:
        await reporter.command("arp -a")
        await reporter.line("Interface: 192.168.0.10 --- 0xb")
        await reporter.event("lan.sweep", {"network": _LOCAL["network"], "total": 253})
        await reporter.command("ping sweep 192.168.0.0/24  (253 IPs, 48 por vez)")
        for device in _DEVICES:
            await self._sleep(0.35)
            data = {**device, "online": True, "rtt_ms": round(self._rng.uniform(1, 9), 1)}
            await reporter.line(f"  {device['ip']:<16} {device['mac']}")
            await reporter.event("lan.device", data)
        await reporter.line(f"{len(_DEVICES)} aparelhos encontrados em {_LOCAL['network']}")
        return {"network": _LOCAL["network"], "count": len(_DEVICES)}

    async def ping(self, target: str, reporter: Reporter) -> dict:
        await reporter.command(f"ping -n 4 -w 1000 {target}")
        await reporter.line(f"Disparando {target} com 32 bytes de dados:")
        local = target.startswith("192.168.")
        times = []
        for seq in range(1, 5):
            await self._sleep(0.8)
            if self._rng.random() < 0.08:
                await reporter.line("Esgotado o tempo limite do pedido.")
                await reporter.event(
                    "ping.reply", {"seq": seq, "ok": False, "rtt_ms": None, "ttl": None}
                )
                continue
            rtt = round(self._rng.uniform(1, 8) if local else self._rng.uniform(14, 40), 1)
            times.append(rtt)
            await reporter.line(f"Resposta de {target}: bytes=32 tempo={round(rtt)}ms TTL=64")
            await reporter.event("ping.reply", {"seq": seq, "ok": True, "rtt_ms": rtt, "ttl": 64})
        return {
            "target": target,
            "sent": 4,
            "received": len(times),
            "avg_ms": round(sum(times) / len(times), 1) if times else None,
        }

    async def traceroute(self, target: str, reporter: Reporter) -> dict:
        address = target if target[0].isdigit() else _fake_ip(target)
        await reporter.event("trace.start", {"target": target, "address": address})
        await reporter.command(f"tracert -d -h 20 -w 800 {address}")
        hops = [*_HOPS, (address, 16.0, "public")]
        for number, (ip, rtt, scope) in enumerate(hops, start=1):
            await self._sleep(0.7)
            lost = 3 if ip is None else 0
            shown = f"{round(rtt)} ms" if rtt else "*"
            where = ip or "Esgotado o tempo limite do pedido."
            await reporter.line(f"{number:>3}    {shown:>6}  {shown:>6}  {shown:>6}  {where}")
            await reporter.event(
                "trace.hop", {"hop": number, "ip": ip, "rtt_ms": rtt, "lost": lost, "scope": scope}
            )
        return {"target": target, "address": address, "hops": len(hops), "reached": True}

    async def dns(self, name: str, reporter: Reporter) -> dict:
        if name.endswith(".invalid"):
            raise AgentError(f"O DNS não encontrou {name}.")
        cached = name in self._dns_cache
        self._dns_cache.add(name)
        await self._sleep(0.2)
        address = _fake_ip(name)
        await reporter.command(f"nslookup {name}")
        for line in [
            "Servidor:  roteador.lan",
            "Address:  192.168.0.1",
            "",
            "Não é resposta autoritativa:",
            f"Nome:    {name}",
            f"Address:  {address}",
        ]:
            await reporter.line(line)
        return {
            "name": name,
            "addresses": [address],
            "ms": 0.6 if cached else 23.5,
            "servers": _LOCAL["dns"],
            "cached": cached,
        }

    @staticmethod
    def _connection(index: int, port: int, service: str, ip: str, host: str | None) -> dict:
        udp = port in _UDP_PORTS
        return {
            "proto": "UDP" if udp else "TCP",
            "lport": 50_000 + index * 17 + port % 97,
            "rip": ip,
            "rport": port,
            "service": service,
            "status": None if udp else "ESTABLISHED",
            "scope": "public",
            "host": host,
        }

    async def connections(self) -> dict:
        processes = [
            {
                "name": name,
                "count": len(rows),
                "connections": [self._connection(i, *row) for i, row in enumerate(rows)],
            }
            for name, rows in _PROCESSES.items()
        ]
        processes.sort(key=lambda p: -p["count"])
        return {"total": sum(p["count"] for p in processes), "processes": processes}

    def throughput(self) -> dict:
        self._rx = min(max(self._rx * self._rng.uniform(0.7, 1.4), 30_000), 4_000_000)
        return {"rx_bps": round(self._rx), "tx_bps": round(self._rx * self._rng.uniform(0.05, 0.2))}

    def close(self) -> None:
        return None
