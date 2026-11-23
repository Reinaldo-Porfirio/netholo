"""Atalho para usar o Quest pelo cabo USB, sem digitar nada no óculos.

1. `adb reverse tcp:PORTA tcp:PORTA`: dentro do Quest, "localhost:PORTA" passa a apontar para
   o PC pelo cabo. Como é localhost, o navegador considera a página segura e libera o WebXR
   sem precisar de certificado HTTPS.
2. `adb shell am start -a VIEW -d URL`: abre a URL (com o token) no navegador do Quest.
"""

from __future__ import annotations

import asyncio
import logging
import shutil

from .runner import run_command

log = logging.getLogger(__name__)


def _adb() -> str | None:
    return shutil.which("adb")


async def open_on_quest(port: int, url: str, delay: float = 1.0) -> bool:
    adb = _adb()
    if adb is None:
        log.warning(
            "adb não encontrado. Instale o Android Platform Tools (winget install "
            "Google.PlatformTools) ou abra a URL no Quest manualmente."
        )
        return False

    code, output = await run_command([adb, "reverse", f"tcp:{port}", f"tcp:{port}"], 15)
    if code != 0:
        log.warning("adb reverse falhou (o Quest está conectado e autorizado?): %s", output)
        return False

    await asyncio.sleep(delay)  # dá tempo do servidor começar a escutar
    # O `adb shell` monta uma linha de comando no Quest: as aspas impedem que "?" e "="
    # da URL sejam interpretados pelo shell de lá. O token só tem [A-Za-z0-9_-].
    code, output = await run_command(
        [adb, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", f"'{url}'"], 15
    )
    if code != 0:
        log.warning("Não consegui abrir o navegador do Quest: %s", output)
        return False
    log.info("Página aberta no navegador do Quest.")
    return True
