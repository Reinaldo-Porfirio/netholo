import pytest

from netholo.errors import InvalidRequestError
from netholo.oui import OuiDatabase, is_randomized, parse_ieee_csv, parse_manuf
from netholo.runner import sanitize_line
from netholo.security import (
    ip_scope,
    new_token,
    origin_allowed,
    token_matches,
    validate_hostname,
    validate_target,
)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("192.168.0.1", "192.168.0.1"),
        (" 8.8.8.8 ", "8.8.8.8"),
        ("GitHub.com", "github.com"),
        ("roteador.lan", "roteador.lan"),
        ("::1", "::1"),
    ],
)
def test_valid_targets(value, expected):
    assert validate_target(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "-t 8.8.8.8",  # injeção de argumento: viraria "ping infinito"
        "-n",
        "8.8.8.8; calc.exe",
        "8.8.8.8 && whoami",
        "$(whoami)",
        "exa mple.com",
        "a" * 300,
        "",
        "   ",
        "224.0.0.1",  # multicast
        "0.0.0.0",
        "255.255.255.255",
        "host-.com",
        123,
        None,
        ["8.8.8.8"],
    ],
)
def test_invalid_targets(value):
    with pytest.raises(InvalidRequestError):
        validate_target(value)


def test_hostname_rejects_ip_like_garbage_and_long_labels():
    with pytest.raises(InvalidRequestError):
        validate_hostname("x" * 64 + ".com")
    assert validate_hostname("wikipedia.org") == "wikipedia.org"


def test_token():
    token = new_token()
    assert len(token) >= 12
    assert token_matches(token, token)
    assert not token_matches(token, None)
    assert not token_matches(token, "")
    assert not token_matches(token, token + "x")
    assert new_token() != token


def test_origin_check():
    assert origin_allowed("http://localhost:8765", "localhost:8765")
    # Cliente que não é navegador não manda Origin (mas ainda precisa do token).
    assert origin_allowed(None, "localhost:8765")
    assert not origin_allowed("https://site-malicioso.example", "localhost:8765")
    assert not origin_allowed("http://localhost:9999", "localhost:8765")
    assert not origin_allowed("http://localhost:8765", None)


@pytest.mark.parametrize(
    ("ip", "scope"),
    [
        ("192.168.0.1", "private"),
        ("10.1.2.3", "private"),
        ("100.64.0.1", "cgnat"),
        ("127.0.0.1", "loopback"),
        ("169.254.10.10", "link-local"),
        ("1.1.1.1", "public"),
        ("lixo", "unknown"),
        (None, "unknown"),
    ],
)
def test_ip_scope(ip, scope):
    assert ip_scope(ip) == scope


def test_sanitize_line_strips_control_chars_and_limits_size():
    assert sanitize_line("ok\x1b[31m vermelho\r\n") == "ok [31m vermelho"
    assert len(sanitize_line("x" * 1000)) == 200


def test_oui_parsers_and_lookup(tmp_path):
    manuf = "# comentário\n00:00:0C\tCisco\tCisco Systems, Inc\n00:1B:C5:00:00:00/36\tX\tIgnorado\n"
    assert parse_manuf(manuf) == {"00000C": "Cisco Systems, Inc"}
    csv_text = (
        "Registry,Assignment,Organization Name,Organization Address\n"
        'MA-L,A42BB0,"TP-LINK","China"\n'
    )
    assert parse_ieee_csv(csv_text) == {"A42BB0": "TP-LINK"}

    path = tmp_path / "oui.tsv"
    path.write_text("A42BB0\tTP-LINK\n", "utf-8")
    db = OuiDatabase(path)
    assert db.lookup("a4:2b:b0:11:22:33") == "TP-LINK"
    assert db.lookup("da:a1:19:3c:00:23") is None  # MAC aleatório: sem fabricante
    assert OuiDatabase(tmp_path / "nao-existe.tsv").lookup("a4:2b:b0:11:22:33") is None


def test_randomized_mac():
    assert is_randomized("da:a1:19:00:00:00")
    assert is_randomized("02:00:5e:00:00:01")
    assert not is_randomized("a4:2b:b0:11:22:33")
