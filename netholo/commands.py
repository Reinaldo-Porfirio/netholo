"""Monta os comandos de rede de cada sistema operacional.

O alvo já chega validado (ver `security.validate_target`). Aqui só escolhemos os argumentos
certos para Windows (alvo principal do projeto) ou Linux (CI e uso na VM).
"""

from __future__ import annotations

from .runner import IS_WINDOWS


def ping(target: str, count: int = 4, timeout_ms: int = 1000) -> list[str]:
    if IS_WINDOWS:
        return ["ping", "-n", str(count), "-w", str(timeout_ms), target]
    # -O mostra "no answer yet" para pacotes perdidos, como o Windows faz com "Esgotado".
    return ["ping", "-c", str(count), "-W", str(max(1, timeout_ms // 1000)), "-O", target]


def traceroute(target: str, max_hops: int = 20) -> list[str]:
    if IS_WINDOWS:
        # -d: não resolve nomes (bem mais rápido); -w: espera por salto em ms.
        return ["tracert", "-d", "-h", str(max_hops), "-w", "800", target]
    return ["traceroute", "-n", "-m", str(max_hops), "-w", "1", target]


def arp_table() -> list[str]:
    return ["arp", "-a"] if IS_WINDOWS else ["ip", "neigh", "show"]


def default_route() -> list[str]:
    if IS_WINDOWS:
        return ["route", "print", "-4", "0.0.0.0"]  # noqa: S104 - filtro da rota padrão, não bind
    return ["ip", "-4", "route", "show", "default"]


def nslookup(name: str) -> list[str]:
    return ["nslookup", name]


def dns_servers() -> list[str] | None:
    """No Windows os servidores DNS vêm do PowerShell (saída em JSON, independe do idioma)."""
    if not IS_WINDOWS:
        return None  # no Linux lemos /etc/resolv.conf
    script = (
        "Get-DnsClientServerAddress -AddressFamily IPv4 | "
        "Select-Object InterfaceAlias,ServerAddresses | ConvertTo-Json -Compress"
    )
    return ["powershell", "-NoProfile", "-NonInteractive", "-Command", script]
