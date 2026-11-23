"""Execução de comandos do sistema de forma segura e assíncrona.

- Sempre `create_subprocess_exec` (lista de argumentos, sem shell): não existe "injeção de
  comando" porque nenhum texto é interpretado por um shell.
- Tempo limite em toda execução; o processo é encerrado se passar do limite.
- A saída é lida linha a linha para o terminal espelho mostrar em tempo real.
"""

from __future__ import annotations

import asyncio
import contextlib
import locale
import subprocess
import sys
import time
from collections.abc import Awaitable, Callable, Sequence

MAX_LINE_LENGTH = 200
IS_WINDOWS = sys.platform == "win32"

LineHandler = Callable[[str], Awaitable[None]]


def _console_encoding() -> str:
    # Programas de console do Windows (ping, tracert, arp) escrevem na página de código OEM
    # (cp850 no Windows em português), não em UTF-8.
    if IS_WINDOWS:
        import ctypes

        return f"cp{ctypes.windll.kernel32.GetOEMCP()}"
    return locale.getpreferredencoding(False)


ENCODING = _console_encoding()
_CREATION_FLAGS = subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0


def sanitize_line(text: str) -> str:
    """Remove caracteres de controle e limita o tamanho antes de mandar ao navegador."""
    clean = "".join(ch if ch.isprintable() else " " for ch in text.rstrip("\r\n"))
    return clean[:MAX_LINE_LENGTH]


def command_text(args: Sequence[str]) -> str:
    """Texto do comando para exibir no terminal espelho."""
    return " ".join(args)


async def run_streaming(args: Sequence[str], timeout: float, on_line: LineHandler) -> int | None:
    """Executa `args` e chama `on_line` para cada linha da saída, assim que ela aparece.

    Devolve o código de saída (None se o processo foi encerrado por tempo limite).
    """
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        creationflags=_CREATION_FLAGS,
    )
    if proc.stdout is None:  # pragma: no cover - PIPE sempre cria o stdout
        raise RuntimeError("stdout indisponível")

    deadline = time.monotonic() + timeout
    reached_eof = False
    try:
        while (remaining := deadline - time.monotonic()) > 0:
            try:
                raw = await asyncio.wait_for(proc.stdout.readline(), remaining)
            except TimeoutError:
                break
            if not raw:
                reached_eof = True
                break
            # A linha vai inteira para os parsers; `sanitize_line` só é aplicada no que vai
            # para o navegador (RequestContext.line), senão um JSON longo seria cortado.
            await on_line(raw.decode(ENCODING, errors="replace").rstrip("\r\n"))
    finally:
        if proc.returncode is None and not reached_eof:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
        code = await proc.wait()
    return code if reached_eof else None


async def run_command(
    args: Sequence[str], timeout: float, max_lines: int = 5000
) -> tuple[int | None, str]:
    """Executa e devolve (código de saída, saída inteira). Para comandos curtos."""
    lines: list[str] = []

    async def collect(line: str) -> None:
        if len(lines) < max_lines:
            lines.append(line)

    code = await run_streaming(args, timeout, collect)
    return code, "\n".join(lines)


async def run_text(args: Sequence[str], timeout: float) -> str:
    """Como `run_command`, mas só a saída (quando o código de saída não importa)."""
    return (await run_command(args, timeout))[1]
