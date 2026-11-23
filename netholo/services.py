"""Portas conhecidas → nome do serviço (o "para que serve" de cada conexão)."""

from __future__ import annotations

WELL_KNOWN_PORTS: dict[int, str] = {
    20: "FTP (dados)",
    21: "FTP",
    22: "SSH",
    23: "Telnet",
    25: "SMTP",
    53: "DNS",
    67: "DHCP",
    68: "DHCP",
    80: "HTTP",
    110: "POP3",
    123: "NTP (hora)",
    137: "NetBIOS",
    143: "IMAP",
    443: "HTTPS",
    445: "SMB (arquivos)",
    465: "SMTP seguro",
    587: "SMTP (envio)",
    853: "DNS sobre TLS",
    993: "IMAP seguro",
    995: "POP3 seguro",
    1900: "SSDP (UPnP)",
    3306: "MySQL",
    3389: "Área de Trabalho Remota",
    3478: "STUN (chamadas)",
    5222: "XMPP (chat)",
    5228: "Google (notificações)",
    5353: "mDNS",
    5432: "PostgreSQL",
    8080: "HTTP alternativo",
    8443: "HTTPS alternativo",
}


def service_name(port: int | None) -> str | None:
    if port is None:
        return None
    return WELL_KNOWN_PORTS.get(port)
