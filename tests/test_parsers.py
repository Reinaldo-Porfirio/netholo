"""Parsers testados com saídas reais (anonimizadas) do Windows em português e do Linux."""

import ipaddress

from netholo.parsers import (
    PingStreamParser,
    parse_arp,
    parse_default_gateway,
    parse_dns_servers,
    parse_ping_reply,
    parse_resolv_conf,
    parse_trace_line,
)

WINDOWS_ARP = """
Interface: 192.168.0.10 --- 0xb
  Endereço IP           Endereço físico       Tipo
  192.168.0.1           a4-2b-b0-11-22-33     dinâmico
  192.168.0.23          da-a1-19-3c-00-23     dinâmico
  192.168.0.255         ff-ff-ff-ff-ff-ff     estático
  224.0.0.22            01-00-5e-00-00-16     estático
  239.255.255.250       01-00-5e-7f-ff-fa     estático

Interface: 172.20.0.1 --- 0x1c
  172.20.0.5            00-15-5d-aa-bb-cc     dinâmico
"""

LINUX_NEIGH = """192.168.0.1 dev eth0 lladdr a4:2b:b0:11:22:33 REACHABLE
192.168.0.30 dev eth0 lladdr 02:00:5e:00:00:30 STALE
192.168.0.99 dev eth0 FAILED
"""


def test_arp_windows_filters_broadcast_multicast_and_other_networks():
    network = ipaddress.IPv4Network("192.168.0.0/24")
    entries = parse_arp(WINDOWS_ARP, network)
    assert [(e.ip, e.mac) for e in entries] == [
        ("192.168.0.1", "a4:2b:b0:11:22:33"),
        ("192.168.0.23", "da:a1:19:3c:00:23"),
    ]


def test_arp_linux_ip_neigh():
    entries = parse_arp(LINUX_NEIGH)
    assert {e.ip for e in entries} == {"192.168.0.1", "192.168.0.30"}


WINDOWS_ROUTE = """
===========================================================================
Rotas ativas:
Destino de rede        Máscara           Ender. gateway     Interface  Custo
          0.0.0.0          0.0.0.0      192.168.0.1     192.168.0.10     35
          0.0.0.0          0.0.0.0      10.0.0.1        10.0.0.50        50
===========================================================================
"""


def test_default_gateway_prefers_primary_interface():
    assert parse_default_gateway(WINDOWS_ROUTE, "10.0.0.50") == "10.0.0.1"
    assert parse_default_gateway(WINDOWS_ROUTE, "192.168.0.10") == "192.168.0.1"


def test_default_gateway_lowest_metric_and_linux():
    assert parse_default_gateway(WINDOWS_ROUTE) == "192.168.0.1"
    assert parse_default_gateway("default via 192.168.1.1 dev wlan0 proto dhcp") == "192.168.1.1"
    assert parse_default_gateway("") is None


def test_dns_servers_json_list_object_and_garbage():
    many = (
        '[{"InterfaceAlias":"Wi-Fi","ServerAddresses":["192.168.0.1","8.8.8.8"]},'
        '{"InterfaceAlias":"Ethernet","ServerAddresses":[]}]'
    )
    assert parse_dns_servers(many) == {"Wi-Fi": ["192.168.0.1", "8.8.8.8"], "Ethernet": []}
    one = '{"InterfaceAlias":"Wi-Fi","ServerAddresses":"1.1.1.1"}'
    assert parse_dns_servers(one) == {"Wi-Fi": ["1.1.1.1"]}
    assert parse_dns_servers("não é json") == {}


def test_resolv_conf():
    text = "# comentário\nnameserver 127.0.0.53\noptions edns0\nnameserver 1.1.1.1\n"
    assert parse_resolv_conf(text) == ["127.0.0.53", "1.1.1.1"]


WINDOWS_PING = """
Disparando 192.168.0.1 com 32 bytes de dados:
Resposta de 192.168.0.1: bytes=32 tempo=3ms TTL=64
Resposta de 192.168.0.1: bytes=32 tempo<1ms TTL=64
Esgotado o tempo limite do pedido.
Resposta de 192.168.0.10: Host de destino inacessível.

Estatísticas do Ping para 192.168.0.1:
    Pacotes: Enviados = 4, Recebidos = 3, Perdidos = 1 (25% de perda),
"""


def test_ping_stream_windows_counts_unreachable_as_lost():
    parser = PingStreamParser()
    replies = [r for line in WINDOWS_PING.splitlines() if (r := parser.feed(line))]
    assert [(r.seq, r.ok) for r in replies] == [(1, True), (2, True), (3, False), (4, False)]
    assert replies[0].rtt_ms == 3 and replies[0].ttl == 64
    assert replies[1].rtt_ms == 0.5


LINUX_PING = """PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.4 ms
no answer yet for icmp_seq=2
64 bytes from 1.1.1.1: icmp_seq=3 ttl=57 time=11,9 ms

--- 1.1.1.1 ping statistics ---
3 packets transmitted, 2 received, 33% packet loss
"""


def test_ping_stream_linux():
    parser = PingStreamParser()
    replies = [r for line in LINUX_PING.splitlines() if (r := parser.feed(line))]
    assert [(r.ok, r.rtt_ms) for r in replies] == [(True, 12.4), (False, None), (True, 11.9)]


def test_ping_reply_ignores_lines_without_ttl():
    assert parse_ping_reply("Esgotado o tempo limite do pedido.") is None


WINDOWS_TRACERT = """
Rastreando a rota para 1.1.1.1 com no máximo 20 saltos

  1    <1 ms    <1 ms    <1 ms  192.168.0.1
  2     6 ms     5 ms     7 ms  100.64.0.1
  3     *        *        *     Esgotado o tempo limite do pedido.
  4    12 ms    11 ms    13 ms  1.1.1.1

Rastreamento concluído.
"""


def test_traceroute_windows():
    hops = [h for line in WINDOWS_TRACERT.splitlines() if (h := parse_trace_line(line))]
    assert [(h.hop, h.ip, h.rtt_ms, h.lost) for h in hops] == [
        (1, "192.168.0.1", 0.5, 0),
        (2, "100.64.0.1", 6.0, 0),
        (3, None, None, 3),
        (4, "1.1.1.1", 12.0, 0),
    ]


def test_traceroute_linux():
    line = " 2  100.64.0.1  6.512 ms  5.900 ms  6.020 ms"
    hop = parse_trace_line(line)
    assert hop is not None and hop.ip == "100.64.0.1" and hop.rtt_ms == 6.1
    assert parse_trace_line("traceroute to 1.1.1.1 (1.1.1.1), 20 hops max") is None
