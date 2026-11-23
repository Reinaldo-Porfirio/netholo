"""Validações de segurança.

Tudo o que chega do óculos é tratado como entrada não confiável: o navegador só pode pedir
ações de uma lista fechada, e os alvos (IPs e nomes) passam por validação estrita antes de
virarem argumento de um comando do sistema.
"""

from __future__ import annotations

import ipaddress
import re
import secrets
from urllib.parse import urlsplit

from .errors import InvalidRequestError

# Nome de host no formato RFC 1123: rótulos de 1 a 63 caracteres (letras, números e hífen),
# sem hífen no começo ou no fim, separados por ponto, até 253 caracteres no total.
_LABEL = r"(?!-)[A-Za-z0-9-]{1,63}(?<!-)"
_HOSTNAME_RE = re.compile(rf"^(?=.{{1,253}}$){_LABEL}(?:\.{_LABEL})*\.?$")

MAX_TARGET_LENGTH = 253


def new_token() -> str:
    """Token curto e aleatório (72 bits) para autorizar o acesso ao WebSocket."""
    return secrets.token_urlsafe(9)


def token_matches(expected: str, provided: str | None) -> bool:
    """Compara em tempo constante para não vazar o token por diferença de tempo."""
    if not provided:
        return False
    return secrets.compare_digest(expected.encode(), provided.encode())


def origin_allowed(origin: str | None, host: str | None) -> bool:
    """Aceita o WebSocket só se a página que abriu a conexão veio deste mesmo servidor.

    Sem essa checagem, qualquer site aberto no navegador poderia tentar abrir um WebSocket
    para o agente (o ataque se chama cross-site WebSocket hijacking). Clientes que não são
    navegador não mandam Origin; eles ainda precisam do token.
    """
    if origin is None:
        return True
    if not host:
        return False
    return urlsplit(origin).netloc.lower() == host.lower()


def validate_target(value: object) -> str:
    """Valida o alvo de ping/traceroute: um IP ou um nome de host.

    Mesmo sem shell, um argumento que começa com "-" seria lido como opção pelo ping
    (ex.: "-t" faria ping infinito), por isso o formato é conferido de forma estrita.
    """
    if not isinstance(value, str):
        raise InvalidRequestError("O alvo precisa ser um texto.")
    target = value.strip()
    if not target or len(target) > MAX_TARGET_LENGTH:
        raise InvalidRequestError("Alvo vazio ou longo demais.")

    try:
        ip = ipaddress.ip_address(target)
    except ValueError:
        return validate_hostname(target)

    if ip.is_multicast or ip.is_unspecified or ip == ipaddress.IPv4Address("255.255.255.255"):
        raise InvalidRequestError("Esse endereço não pode ser usado como alvo.")
    return str(ip)


def validate_hostname(value: object) -> str:
    if not isinstance(value, str):
        raise InvalidRequestError("O nome precisa ser um texto.")
    name = value.strip().lower()
    if not _HOSTNAME_RE.match(name):
        raise InvalidRequestError("Nome de host inválido.")
    return name


def ip_scope(address: str | None) -> str:
    """Classifica um IP para as lições: privado, CGNAT (provedor), público ou local."""
    if not address:
        return "unknown"
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return "unknown"
    if ip.is_loopback:
        return "loopback"
    if ip.is_link_local:
        return "link-local"
    if isinstance(ip, ipaddress.IPv4Address) and ip in _CGNAT:
        return "cgnat"
    if ip.is_private:
        return "private"
    return "public"


_CGNAT = ipaddress.IPv4Network("100.64.0.0/10")
