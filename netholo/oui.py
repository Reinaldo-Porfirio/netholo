"""Fabricante do aparelho a partir do MAC (os 3 primeiros bytes são o OUI do fabricante).

A base pública de OUIs tem alguns MB, por isso não fica no repositório: é baixada sob demanda
com `python -m netholo --update-oui` e guardada na pasta de cache do usuário.
"""

from __future__ import annotations

import csv
import io
import logging
import os
import urllib.request
from collections.abc import Callable
from pathlib import Path

log = logging.getLogger(__name__)

CACHE_DIR = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".cache") / "netholo"
OUI_FILE = CACHE_DIR / "oui.tsv"
MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024


def is_randomized(mac: str) -> bool:
    """MAC "administrado localmente" (bit 2 do 1º byte): celulares usam um aleatório por rede
    para não serem rastreados, então nesses casos o fabricante não pode ser descoberto."""
    try:
        return bool(int(mac[:2], 16) & 0x02)
    except ValueError:
        return False


def _prefix(mac: str) -> str:
    return mac.replace(":", "").replace("-", "")[:6].upper()


def parse_manuf(text: str) -> dict[str, str]:
    """Formato do Wireshark: `00:00:0C<TAB>Cisco<TAB>Cisco Systems, Inc`."""
    table: dict[str, str] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 2 or "/" in parts[0]:
            continue  # prefixos menores que 24 bits ficam de fora (são raros em casa)
        prefix = _prefix(parts[0])
        vendor = (parts[2] if len(parts) > 2 and parts[2] else parts[1]).strip()
        if len(prefix) == 6 and vendor:
            table[prefix] = vendor
    return table


def parse_ieee_csv(text: str) -> dict[str, str]:
    """Formato do IEEE: `Registry,Assignment,Organization Name,Organization Address`."""
    table: dict[str, str] = {}
    for row in csv.reader(io.StringIO(text)):
        if len(row) >= 3 and len(row[1]) == 6 and row[0] != "Registry":
            table[row[1].upper()] = row[2].strip()
    return table


_SOURCES: list[tuple[str, Callable[[str], dict[str, str]]]] = [
    ("https://www.wireshark.org/download/automated/data/manuf", parse_manuf),
    ("https://standards-oui.ieee.org/oui/oui.csv", parse_ieee_csv),
]


def _download(url: str) -> str:
    # As URLs são constantes HTTPS (lista acima), nunca vindas do usuário: por isso os noqa.
    if not url.startswith("https://"):
        raise ValueError("só HTTPS é permitido")
    request = urllib.request.Request(url, headers={"User-Agent": "netholo-oui-updater"})  # noqa: S310
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
        data = response.read(MAX_DOWNLOAD_BYTES + 1)
    if len(data) > MAX_DOWNLOAD_BYTES:
        raise ValueError("arquivo maior que o esperado")
    return data.decode("utf-8", errors="replace")


def update(dest: Path = OUI_FILE) -> int:
    """Baixa a base de fabricantes e grava em `dest`. Devolve quantos prefixos foram salvos."""
    errors = []
    for url, parser in _SOURCES:
        try:
            table = parser(_download(url))
        except (OSError, ValueError) as exc:
            errors.append(f"{url}: {exc}")
            continue
        if len(table) < 1000:
            errors.append(f"{url}: conteúdo inesperado")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".tmp")
        tmp.write_text("".join(f"{k}\t{v}\n" for k, v in sorted(table.items())), "utf-8")
        tmp.replace(dest)
        return len(table)
    raise RuntimeError("Não foi possível baixar a base de fabricantes:\n" + "\n".join(errors))


class OuiDatabase:
    """Consulta de fabricante, carregada do cache na primeira vez que é usada."""

    def __init__(self, path: Path = OUI_FILE) -> None:
        self._path = path
        self._table: dict[str, str] | None = None

    @property
    def available(self) -> bool:
        return bool(self._load())

    def _load(self) -> dict[str, str]:
        if self._table is None:
            self._table = {}
            try:
                for line in self._path.read_text("utf-8").splitlines():
                    prefix, _, vendor = line.partition("\t")
                    if vendor:
                        self._table[prefix] = vendor
            except FileNotFoundError:
                log.info("Base de fabricantes ausente; rode: python -m netholo --update-oui")
        return self._table

    def lookup(self, mac: str | None) -> str | None:
        if not mac or is_randomized(mac):
            return None
        return self._load().get(_prefix(mac))
