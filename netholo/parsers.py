"""Leitura da saída dos comandos de rede.

O Windows traduz as mensagens ("Resposta de", "Esgotado o tempo limite"...), então os
parsers se apoiam no que não muda com o idioma: endereços IP, MACs, "TTL=", "ms" e a
estrutura das linhas. Todas as funções são puras, o que facilita testar com saídas reais.
"""

from __future__ import annotations

import ipaddress
import json
import re
from dataclasses import dataclass

_IPV4 = r"\d{1,3}(?:\.\d{1,3}){3}"
_MAC = r"[0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5}"

_ARP_RE = re.compile(rf"({_IPV4})\s+(?:dev\s+\S+\s+lladdr\s+)?({_MAC})")
_WIN_ROUTE_RE = re.compile(rf"^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+({_IPV4})\s+({_IPV4})\s+(\d+)")
_LINUX_ROUTE_RE = re.compile(rf"^default\s+via\s+({_IPV4})")
_TTL_RE = re.compile(r"ttl=(\d+)", re.IGNORECASE)
_RTT_RE = re.compile(r"([=<])\s*([\d.,]+)\s*ms", re.IGNORECASE)
_HOP_RE = re.compile(r"^\s*(\d{1,2})\s+(.*)$")
_HOP_TIME_RE = re.compile(r"(<?)([\d.,]+)\s*ms", re.IGNORECASE)
_LAST_IP_RE = re.compile(rf"({_IPV4})(?!.*{_IPV4})")
_BROADCAST_MAC = "ff:ff:ff:ff:ff:ff"


@dataclass(frozen=True, slots=True)
class ArpEntry:
    ip: str
    mac: str


def normalize_mac(mac: str) -> str:
    return mac.replace("-", ":").lower()


def _to_float(text: str) -> float:
    return float(text.replace(",", "."))


def parse_arp(output: str, network: ipaddress.IPv4Network | None = None) -> list[ArpEntry]:
    """Entradas da tabela ARP (Windows `arp -a` ou Linux `ip neigh`).

    Descarta broadcast e multicast, e, se `network` for informado, o que estiver fora dela.
    """
    entries: dict[str, ArpEntry] = {}
    for match in _ARP_RE.finditer(output):
        ip_text, mac_raw = match.groups()
        mac = normalize_mac(mac_raw)
        try:
            ip = ipaddress.IPv4Address(ip_text)
        except ValueError:
            continue
        if mac == _BROADCAST_MAC or int(mac[:2], 16) & 1 or ip.is_multicast:
            continue
        if network is not None and (
            ip not in network or ip in (network.network_address, network.broadcast_address)
        ):
            continue
        entries[ip_text] = ArpEntry(ip_text, mac)
    return list(entries.values())


def parse_default_gateway(output: str, interface_ip: str | None = None) -> str | None:
    """Gateway padrão a partir de `route print -4 0.0.0.0` (Windows) ou `ip route` (Linux)."""
    candidates: list[tuple[int, str, str]] = []
    for line in output.splitlines():
        if m := _WIN_ROUTE_RE.match(line):
            gateway, iface, metric = m.groups()
            candidates.append((int(metric), gateway, iface))
        elif m := _LINUX_ROUTE_RE.match(line.strip()):
            return m.group(1)
    if not candidates:
        return None
    preferred = [c for c in candidates if c[2] == interface_ip]
    return min(preferred or candidates)[1]


def parse_dns_servers(output: str) -> dict[str, list[str]]:
    """JSON do `Get-DnsClientServerAddress` → {interface: [servidores]}.

    O `ConvertTo-Json` devolve um objeto (não uma lista) quando só há uma interface.
    """
    try:
        data = json.loads(output) if output.strip() else []
    except json.JSONDecodeError:
        return {}
    if isinstance(data, dict):
        data = [data]
    result: dict[str, list[str]] = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        alias = item.get("InterfaceAlias")
        servers = item.get("ServerAddresses") or []
        if isinstance(servers, str):
            servers = [servers]
        if isinstance(alias, str):
            result[alias] = [s for s in servers if isinstance(s, str)]
    return result


def parse_resolv_conf(text: str) -> list[str]:
    servers = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "nameserver":
            servers.append(parts[1])
    return servers


@dataclass(frozen=True, slots=True)
class PingReply:
    seq: int
    ok: bool
    rtt_ms: float | None = None
    ttl: int | None = None


def parse_ping_reply(line: str) -> tuple[float | None, int | None] | None:
    """Se a linha é uma resposta de ping ("TTL=" presente), devolve (rtt_ms, ttl)."""
    ttl_match = _TTL_RE.search(line)
    if not ttl_match:
        return None
    rtt = None
    if rtt_match := _RTT_RE.search(line):
        operator, value = rtt_match.groups()
        rtt = _to_float(value)
        if operator == "<":
            rtt /= 2  # "tempo<1ms": usamos 0,5 ms
    return rtt, int(ttl_match.group(1))


class PingStreamParser:
    """Transforma a saída do ping, linha a linha, em respostas numeradas.

    No Windows a saída tem um cabeçalho, uma linha por pacote (resposta ou erro) e, depois de
    uma linha em branco, as estatísticas. Uma linha de pacote sem "TTL=" significa perda
    (inclusive "Host de destino inacessível", que o Windows conta como sucesso no código de
    saída, uma pegadinha clássica). No Linux usamos `-O`, que imprime os pacotes sem resposta.
    """

    def __init__(self) -> None:
        self._seen_header = False
        self._finished = False
        self._seq = 0

    def feed(self, line: str) -> PingReply | None:
        text = line.strip()
        if self._finished:
            return None
        if not text:
            if self._seen_header and self._seq:
                self._finished = True
            return None
        if not self._seen_header:
            self._seen_header = True
            return None
        if text.startswith("---"):
            self._finished = True
            return None
        reply = parse_ping_reply(text)
        self._seq += 1
        if reply is None:
            return PingReply(seq=self._seq, ok=False)
        rtt, ttl = reply
        return PingReply(seq=self._seq, ok=True, rtt_ms=rtt, ttl=ttl)


@dataclass(frozen=True, slots=True)
class Hop:
    hop: int
    ip: str | None
    rtt_ms: float | None
    lost: int


def parse_trace_line(line: str) -> Hop | None:
    """Uma linha de `tracert`/`traceroute` → salto. Cabeçalhos e rodapés devolvem None."""
    match = _HOP_RE.match(line)
    if not match:
        return None
    hop_number, rest = int(match.group(1)), match.group(2)
    times = []
    for less_than, value in _HOP_TIME_RE.findall(rest):
        ms = _to_float(value)
        times.append(ms / 2 if less_than else ms)
    lost = rest.count("*")
    if not times and not lost:
        return None
    ip_match = _LAST_IP_RE.search(rest)
    ip = ip_match.group(1) if ip_match else None
    avg = round(sum(times) / len(times), 1) if times else None
    return Hop(hop=hop_number, ip=ip, rtt_ms=avg, lost=lost)
