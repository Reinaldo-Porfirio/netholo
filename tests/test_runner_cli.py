import sys

import pytest

from netholo import quest
from netholo.__main__ import _parse_args
from netholo.runner import run_command, run_streaming


async def test_run_command_returns_code_and_full_lines():
    long_line = "x" * 500  # o terminal corta em 200, mas os parsers recebem a linha inteira
    code, output = await run_command(
        [sys.executable, "-c", f"print('a'); print('{long_line}'); raise SystemExit(3)"], 10
    )
    assert code == 3
    assert output.splitlines() == ["a", long_line]


async def test_run_streaming_kills_on_timeout():
    seen = []

    async def on_line(line):
        seen.append(line)

    code = await run_streaming(
        [sys.executable, "-c", "import time; print('start', flush=True); time.sleep(30)"],
        1.5,
        on_line,
    )
    assert code is None
    assert seen == ["start"]


async def test_open_on_quest_without_adb(monkeypatch):
    monkeypatch.setattr(quest, "_adb", lambda: None)
    assert await quest.open_on_quest(8765, "http://localhost:8765/?t=x") is False


def test_cli_rejects_insecure_lan_and_conflicts():
    with pytest.raises(SystemExit):
        _parse_args(["--lan"])
    with pytest.raises(SystemExit):
        _parse_args(["--cert", "c.pem"])
    with pytest.raises(SystemExit):
        _parse_args(["--lan", "--adb", "--cert", "c.pem", "--key", "k.pem"])
    with pytest.raises(SystemExit):
        _parse_args(["--port", "70000"])
    args = _parse_args(["--demo", "--adb"])
    assert args.demo and args.adb and not args.lan
