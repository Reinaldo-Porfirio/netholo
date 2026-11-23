import { CONCEPTS } from './levels.js';
import { CSS } from './theme.js';

const SCOPE_TEXT = {
  private: 'IP privado: ainda dentro de uma rede local (sua ou do provedor).',
  cgnat: 'CGNAT (100.64.0.0/10): o provedor divide um IP público entre vários clientes.',
  public: 'IP público: roteador já na Internet.',
  unknown: 'Não respondeu: muitos roteadores ignoram esse tipo de pacote.',
};

/**
 * Liga os botões (ações) aos pedidos ao agente e às animações da cena.
 * Ações são textos "nome:argumento", ex.: "ping:192.168.0.1", "dns:github.com".
 */
export class App {
  constructor({ client, world, menu, terminal }) {
    this.client = client;
    this.world = world;
    this.menu = menu;
    this.terminal = terminal;
    this.local = null;
    this.running = new Set();
    this.connectionsOn = false;

    world.onAction = (id) => this.run(id);
    world.onSelect = (node) => this.#showDetail(node);
    menu.lesson.onButton = (id) => this.run(id);

    client.addEventListener('terminal', ({ detail }) => {
      if (detail.command) this.terminal.begin(detail.command);
      else this.terminal.print(detail.line ?? '');
    });
    client.addEventListener('push:throughput', ({ detail }) => world.setThroughput(detail));
    client.addEventListener('push:connections', ({ detail }) => {
      if (this.connectionsOn) world.setConnections(detail);
    });
    client.addEventListener('agent-error', ({ detail }) => this.#notify(detail, true));
    client.addEventListener('status', ({ detail }) => {
      if (detail === 'online') this.run('local.info', { quiet: true });
      if (detail === 'offline' && this.connectionsOn) this.#setConnections(false);
    });
  }

  #notify(text, isError = false) {
    this.terminal.print(text, isError ? CSS.red : CSS.amber);
    this.world.bubble(this.world.pc, text, isError ? CSS.red : CSS.amber, 2.4);
  }

  async #ensureLocal() {
    if (!this.local) await this.#localInfo({ quiet: true });
    return this.local;
  }

  async run(actionId, { quiet = false } = {}) {
    const separator = actionId.indexOf(':');
    const name = separator === -1 ? actionId : actionId.slice(0, separator);
    const arg = separator === -1 ? '' : actionId.slice(separator + 1);
    if (name === 'explain') return this.#explain(arg);
    if (this.running.has(name)) {
      this.#notify('Essa ação já está rodando.');
      return undefined;
    }
    this.running.add(name);
    try {
      switch (name) {
        case 'local.info': return await this.#localInfo({ quiet });
        case 'lan.scan': return await this.#scan();
        case 'ping': return await this.#ping(arg);
        case 'trace': return await this.#trace(arg);
        case 'dns': return await this.#dns(arg);
        case 'conn': return await this.#setConnections(!this.connectionsOn);
        default: return undefined;
      }
    } catch (error) {
      this.#notify(error.message, true);
      return undefined;
    } finally {
      this.running.delete(name);
    }
  }

  async #localInfo({ quiet }) {
    const info = await this.client.request('local.info');
    this.local = info;
    this.world.setLocalInfo(info);
    if (!quiet) this.world.showLocalTags(info);
    return info;
  }

  async #scan() {
    await this.#ensureLocal();
    this.world.beginSweep();
    const result = await this.client.request('lan.scan', {}, {
      onEvent: (event, data) => {
        if (event === 'lan.device') this.world.upsertDevice(data);
      },
    });
    this.world.bubble(this.world.router, `${result.count} aparelhos`, CSS.holoLight, 2.5);
  }

  async #ping(arg) {
    const target = arg === 'gateway' ? (await this.#ensureLocal()).gateway : arg;
    if (!target) throw new Error('Gateway não encontrado.');
    const node = this.world.nodeForTarget(target);
    const result = await this.client.request('ping', { target }, {
      onEvent: (event, reply) => {
        if (event === 'ping.reply') this.world.animatePing(node, reply);
      },
    });
    const summary = result.received
      ? `${result.received}/${result.sent} respostas · média ${result.avg_ms} ms`
      : 'sem resposta';
    this.terminal.print(summary, result.received ? CSS.holoLight : CSS.red);
  }

  async #trace(target) {
    await this.#ensureLocal();
    const result = await this.client.request('traceroute', { target }, {
      onEvent: (event, data) => {
        if (event === 'trace.start') this.world.startTrace(data);
        else if (event === 'trace.hop') this.world.addHop(data);
      },
    });
    this.world.finishTrace(result);
  }

  async #dns(name) {
    await this.#ensureLocal();
    const result = await this.client.request('dns', { name });
    await this.world.animateDns(result);
  }

  async #setConnections(on) {
    if (this.client.online) await this.client.request('connections.watch', { on });
    this.connectionsOn = on;
    this.menu.setConnectionsOn(on);
    if (!on) this.world.clearConnections();
  }

  #explain(concept) {
    const entry = CONCEPTS[concept];
    if (!entry) return;
    const [title, text] = entry;
    this.world.select(this.world.pc);
    this.world.showDetail(this.world.pc, { title, lines: [{ text }] });
  }

  // ---------- painel de detalhes de cada tipo de nó ----------

  #showDetail(node) {
    const info = node.info ?? {};
    const row = (label, value) => ({ text: `${label}: ${value ?? '—'}` });
    const content = { title: node.label.text || node.kind, lines: [], buttons: [] };

    switch (node.kind) {
      case 'pc':
        content.title = `Este PC · ${info.hostname ?? ''}`;
        content.lines = [
          row('IP', info.ip), row('Máscara', info.netmask && `${info.netmask} (/${info.prefix})`),
          row('Gateway', info.gateway), row('DNS', info.dns?.join(', ')), row('MAC', info.mac),
          row('Placa', info.interface && `${info.interface}${info.speed_mbps ? ` · ${info.speed_mbps} Mb/s` : ''}`),
        ];
        content.buttons = [{ id: 'local.info', label: 'Ler configuração', kind: 'primary' }];
        break;
      case 'router':
        content.title = 'Roteador (gateway)';
        content.lines = [
          row('IP', info.ip), row('MAC', info.mac), row('Fabricante', info.vendor),
          { text: 'É a porta de saída da rede para a Internet. Também distribui IPs (DHCP) e costuma responder o DNS.', color: CSS.muted },
        ];
        content.buttons = [{ id: `ping:${info.ip ?? 'gateway'}`, label: 'Ping', kind: 'primary' }];
        break;
      case 'internet':
        content.title = 'Internet';
        content.lines = [{
          text: 'Milhões de redes ligadas por roteadores. Seu roteador faz NAT: todos os aparelhos da casa saem para cá com o mesmo IP público.',
        }];
        content.buttons = [
          { id: 'ping:8.8.8.8', label: 'Ping 8.8.8.8', kind: 'primary' },
          { id: 'trace:8.8.8.8', label: 'Rota até 8.8.8.8' },
        ];
        break;
      case 'dns':
        content.title = 'Servidor DNS';
        content.lines = [row('Servidores', info.servers?.join(', ')), { text: CONCEPTS.dns[1], color: CSS.muted }];
        content.buttons = [{ id: `ping:${info.ip}`, label: 'Ping', kind: 'primary' }];
        break;
      case 'hop':
        content.title = `Salto ${info.hop}`;
        content.lines = [
          row('IP', info.ip ?? '* (sem resposta)'),
          row('Latência', info.rtt_ms != null ? `${info.rtt_ms} ms` : null),
          { text: SCOPE_TEXT[info.scope] ?? SCOPE_TEXT.unknown, color: CSS.muted },
        ];
        if (info.ip) content.buttons = [{ id: `ping:${info.ip}`, label: 'Ping', kind: 'primary' }];
        break;
      case 'process': {
        content.title = `${info.name} · ${info.count} conexões`;
        content.lines = this.world.connectionsOf(node).slice(0, 6).map((c) => ({
          text: `${c.proto} ${c.rport} ${c.service ?? ''} → ${c.host ?? c.rip}`,
          mono: true,
          wrap: false,
        }));
        content.lines.push({ text: 'Linhas em âmbar: as conexões deste programa.', color: CSS.muted });
        break;
      }
      case 'endpoint':
        content.title = info.host ?? info.rip;
        content.lines = [
          row('Destino', `${info.rip}:${info.rport}`), row('Serviço', info.service),
          row('Programa', info.process), row('Protocolo', `${info.proto}${info.status ? ` · ${info.status}` : ''}`),
        ];
        content.buttons = [
          { id: `ping:${info.rip}`, label: 'Ping', kind: 'primary' },
          { id: `trace:${info.rip}`, label: 'Rota' },
        ];
        break;
      default: // aparelhos da rede local
        content.title = info.name ?? info.vendor ?? 'Aparelho da rede';
        content.lines = [
          row('IP', info.ip),
          row('MAC', info.mac && `${info.mac}${info.randomized ? ' (aleatório)' : ''}`),
          row('Fabricante', info.vendor ?? (info.randomized ? 'oculto pelo MAC aleatório' : 'desconhecido')),
          row('Respondeu ping', info.rtt_ms != null ? `sim · ${info.rtt_ms} ms` : 'não'),
        ];
        content.buttons = [{ id: `ping:${info.ip}`, label: 'Ping', kind: 'primary' }];
    }
    this.world.showDetail(node, content);
  }
}
