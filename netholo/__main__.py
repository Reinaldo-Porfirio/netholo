"""Linha de comando: `python -m netholo [opções]`."""

from __future__ import annotations

import argparse
import asyncio
import logging
import ssl
from pathlib import Path

from aiohttp import web

from . import __version__, oui
from .agent import RealAgent, primary_ipv4
from .demo import DemoAgent
from .quest import open_on_quest
from .security import new_token
from .server import WEB_DIR, Settings, create_app

DEFAULT_PORT = 8765
ADB_TASK = web.AppKey("adb_task", asyncio.Task)


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="netholo",
        description="Laboratório de redes em realidade mista (agente + página WebXR).",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="porta (padrão 8765)")
    parser.add_argument(
        "--lan",
        action="store_true",
        help="aceitar conexões do Wi-Fi (exige --cert e --key); sem isso, só localhost",
    )
    parser.add_argument("--cert", type=Path, help="certificado TLS (ex.: gerado pelo mkcert)")
    parser.add_argument("--key", type=Path, help="chave privada do certificado TLS")
    parser.add_argument(
        "--adb",
        action="store_true",
        help="Quest no cabo USB: faz o adb reverse e abre a página no óculos sozinho",
    )
    parser.add_argument("--demo", action="store_true", help="usar dados de demonstração")
    parser.add_argument("--update-oui", action="store_true", help="baixar base de fabricantes")
    parser.add_argument("--web-dir", type=Path, default=WEB_DIR, help=argparse.SUPPRESS)
    parser.add_argument("-v", "--verbose", action="store_true", help="logs detalhados")
    parser.add_argument("--version", action="version", version=f"netholo {__version__}")
    args = parser.parse_args(argv)

    if bool(args.cert) != bool(args.key):
        parser.error("--cert e --key precisam ser usados juntos.")
    if args.lan and not args.cert:
        parser.error(
            "--lan exige HTTPS (--cert e --key): o WebXR só funciona em contexto seguro e o "
            "token não pode trafegar sem criptografia no Wi-Fi."
        )
    if args.lan and args.adb:
        parser.error("use --adb (cabo USB) ou --lan (Wi-Fi), não os dois.")
    if not (1 <= args.port <= 65535):
        parser.error("porta inválida.")
    return args


def _ssl_context(cert: Path, key: Path) -> ssl.SSLContext:
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert, key)
    return context


def _print_banner(settings: Settings, args: argparse.Namespace, scheme: str) -> None:
    query = f"/?t={settings.token}"
    mode = "modo demonstração, dados falsos" if args.demo else "rede real"
    print(f"\n  NetHolo {__version__} rodando ({mode})\n")
    print(f"  No PC (navegador):   {scheme}://localhost:{args.port}{query}")
    if args.lan:
        ip = primary_ipv4() or "IP-DO-PC"
        print(f"  No Quest (Wi-Fi):    {scheme}://{ip}:{args.port}{query}")
    elif args.adb:
        print("  No Quest (cabo USB): abrindo sozinho via adb...")
    else:
        print("  No Quest (cabo USB): rode de novo com --adb, ou faça")
        print(f"                       adb reverse tcp:{args.port} tcp:{args.port}")
        print(f"                       e abra {scheme}://localhost:{args.port}{query}")
    print("\n  O token muda a cada execução. Ctrl+C para sair.\n")


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.update_oui:
        count = oui.update()
        print(f"Base de fabricantes atualizada: {count} prefixos em {oui.OUI_FILE}")
        return

    settings = Settings(token=new_token(), web_dir=args.web_dir)
    agent = DemoAgent() if args.demo else RealAgent()
    app = create_app(settings, agent)
    ssl_context = _ssl_context(args.cert, args.key) if args.cert else None
    host = "0.0.0.0" if args.lan else "127.0.0.1"  # noqa: S104 - só com --lan e HTTPS
    scheme = "https" if ssl_context else "http"

    if args.adb:
        url = f"{scheme}://localhost:{args.port}/?t={settings.token}"

        async def start_adb(app: web.Application) -> None:
            # Guardado no app para a tarefa não ser coletada pelo garbage collector.
            app[ADB_TASK] = asyncio.create_task(open_on_quest(args.port, url))

        app.on_startup.append(start_adb)

    _print_banner(settings, args, scheme)
    # access_log=None: o log de acesso gravaria a URL com o token.
    web.run_app(
        app, host=host, port=args.port, ssl_context=ssl_context, print=None, access_log=None
    )


if __name__ == "__main__":
    main()
