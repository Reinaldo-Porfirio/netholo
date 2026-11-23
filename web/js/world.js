import * as THREE from './three.js';
import { COLOR, CSS, formatBytesPerSecond, latencyColor } from './theme.js';
import { HoloNode, guessDeviceKind } from './hologram.js';
import { Link, PacketSystem, Tweens, spawnBubble, spawnWave } from './effects.js';
import { Panel } from './panel.js';
import { TextSprite } from './text.js';

// Layout da cena em metros, relativo ao centro (roteador). +z aponta para o usuário.
const POS = {
  router: new THREE.Vector3(0, 0, 0),
  pc: new THREE.Vector3(0, -0.04, 0.3),
  internet: new THREE.Vector3(0, 0.5, -0.18),
  dns: new THREE.Vector3(-0.25, 0.3, -0.14),
};
const RING = { radius: 0.42, step: 0.33, perRing: 15, ringGap: 0.13 };
const HOP_CURVE = new THREE.QuadraticBezierCurve3(
  new THREE.Vector3(0.13, 0.03, -0.02),
  new THREE.Vector3(0.46, 0.26, 0.02),
  new THREE.Vector3(0.15, 0.46, -0.16),
);
const SPHERE_RADIUS = 0.122;
const MAX_ENDPOINTS = 40;
const UP = new THREE.Vector3(0, 1, 0);

const toCss = (hex) => `#${hex.toString(16).padStart(6, '0')}`;
const formatMs = (ms) => (ms < 1 ? '<1 ms' : `${Math.round(ms)} ms`);

const HOP_COLOR = { private: COLOR.holoLight, cgnat: COLOR.violet, public: COLOR.holo };

function hash32(text) {
  let h = 0x811c9dc5; // FNV-1a: espalha os IPs de forma estável pela esfera
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function deviceLabel(device) {
  const lastOctet = device.ip.split('.').at(-1);
  const name = device.name?.split('.')[0] || device.vendor || (device.randomized ? 'Celular?' : 'Aparelho');
  return `${name} · .${lastOctet}`;
}

/**
 * Tudo o que existe na cena da rede: nós, linhas, pacotes e animações de cada nível.
 * Não sabe nada de WebSocket: o App chama estes métodos com os dados do agente.
 */
export class NetWorld {
  constructor({ interaction }) {
    this.root = new THREE.Group();
    this.interaction = interaction;
    this.tweens = new Tweens();
    this.packets = new PacketSystem();
    this.root.add(this.packets);
    this.nodes = new Set();
    this.links = new Set();
    this.byIp = new Map();
    this.devices = new Map();
    this.tags = [];
    this.trace = null;
    this.conn = { processes: new Map(), endpoints: new Map(), links: new Map() };
    this.selected = null;
    this.local = null;
    this.throughput = { rx_bps: 0, tx_bps: 0 };
    this.trafficBudget = 0;
    this.onAction = null;
    this.onSelect = null;

    this.internet = this.#addNode({ id: 'internet', kind: 'internet', label: 'Internet', position: POS.internet, spin: 0.12 });
    this.router = this.#addNode({ id: 'router', kind: 'router', label: 'Roteador', position: POS.router });
    this.pc = this.#addNode({ id: 'pc', kind: 'pc', label: 'Este PC', position: POS.pc });
    this.pcRouter = this.#addLink(this.pc, this.router, { lift: 0.05, opacity: 0.6 });
    this.routerInternet = this.#addLink(this.router, this.internet, { lift: 0.03, opacity: 0.5 });
    this.dnsNode = this.router;
    this.dnsInternet = this.routerInternet;

    this.rateLabel = new TextSprite('', { height: 0.02, color: CSS.muted, background: null });
    this.rateLabel.position.copy(POS.pc).add(new THREE.Vector3(0, -0.118, 0));
    this.root.add(this.rateLabel);

    this.detail = new Panel({ width: 0.3, onButton: (id) => this.onAction?.(id) });
    this.detail.visible = false;
    this.root.add(this.detail);
    interaction.register(this.detail);
  }

  // ---------- infraestrutura da cena ----------

  #addNode({ id, kind, label, position, color, spin }) {
    const node = new HoloNode({ id, kind, label, color, spin });
    node.position.copy(position);
    node.onSelect = (n) => this.select(n);
    this.root.add(node);
    this.nodes.add(node);
    this.interaction.register(node.hitMesh);
    return node;
  }

  #removeNode(node) {
    if (this.selected === node) this.deselect();
    this.interaction.unregister(node.hitMesh);
    for (const [ip, mapped] of this.byIp) if (mapped === node) this.byIp.delete(ip);
    this.root.remove(node);
    this.nodes.delete(node);
    node.dispose();
  }

  #addLink(a, b, options) {
    const link = new Link(a, b, options);
    this.root.add(link);
    this.links.add(link);
    return link;
  }

  #removeLink(link) {
    this.packets.dropLink(link);
    this.root.remove(link);
    this.links.delete(link);
    link.dispose();
  }

  #index(ip, node, { override = true } = {}) {
    if (ip && (override || !this.byIp.has(ip))) this.byIp.set(ip, node);
  }

  #above(node, dy = 0.03) {
    return node.position.clone().addScaledVector(UP, node.radius + dy);
  }

  bubble(node, text, color = CSS.amber, duration = 1.6) {
    spawnBubble(this.root, this.tweens, text, this.#above(node), { color, duration });
  }

  // ---------- seleção e painel de detalhes ----------

  select(node) {
    if (this.selected && this.selected !== node) this.selected.setSelected(false);
    this.selected = node;
    node.setSelected(true);
    for (const link of this.conn.links.values()) {
      if (link.a === node || link.b === node) link.highlight();
      else link.reset();
    }
    this.onSelect?.(node);
  }

  deselect() {
    this.selected?.setSelected(false);
    this.selected = null;
    this.detail.visible = false;
    for (const link of this.conn.links.values()) link.reset();
  }

  showDetail(node, content) {
    const side = node.position.x > 0.25 ? -1 : 1;
    this.detail.position.set(
      node.position.x + side * (node.radius + 0.18),
      0,
      node.position.z + 0.06,
    );
    this.detail.anchorTop = node.position.y + 0.12;
    this.detail.setContent({ ...content, closable: true, accent: CSS.amber });
    this.detail.visible = true;
  }

  // ---------- nível 1 ----------

  setLocalInfo(info) {
    this.local = info;
    this.pc.info = { ...this.pc.info, ...info };
    this.pc.setLabel(`Este PC · ${info.ip}`);
    this.#index(info.ip, this.pc);
    if (info.gateway) {
      this.router.info = { ...this.router.info, ip: info.gateway };
      this.router.setLabel(`Roteador · ${info.gateway}`);
      this.#index(info.gateway, this.router);
    }
    this.#ensureDnsNode(info);
  }

  #ensureDnsNode(info) {
    const server = info.dns?.[0];
    if (!server || server === info.gateway) {
      this.#index(server, this.router);
      return;
    }
    if (this.dnsNode === this.router) {
      this.dnsNode = this.#addNode({ id: 'dns', kind: 'dns', label: `DNS · ${server}`, position: POS.dns, spin: 0.4 });
      this.dnsNode.appear();
      const link = this.#addLink(this.router, this.dnsNode, { lift: 0.03, opacity: 0.45 });
      this.dnsNode.pathFromRouter = [[link, false]];
      this.dnsInternet = this.#addLink(this.dnsNode, this.internet, { lift: 0.02, opacity: 0.35, dashed: true });
    }
    this.dnsNode.info = { ip: server, servers: info.dns };
    this.dnsNode.setLabel(`DNS · ${server}`);
    this.#index(server, this.dnsNode);
  }

  showLocalTags(info) {
    for (const tag of this.tags) {
      this.interaction.unregister(tag);
      this.root.remove(tag);
      tag.dispose();
    }
    const entries = [
      ['ip', `IP ${info.ip}`],
      ['mask', `Máscara ${info.netmask} (/${info.prefix})`],
      ['gateway', `Gateway ${info.gateway ?? '—'}`],
      ['dns', `DNS ${info.dns?.join(', ') || '—'}`],
      ['mac', `MAC ${info.mac ?? '?'}`],
    ];
    this.tags = entries.map(([concept, text], i) => {
      const tag = new TextSprite(text, { height: 0.022 });
      tag.position.copy(POS.pc).add(new THREE.Vector3(0.25, 0.04 - i * 0.032, 0));
      const finalScale = tag.scale.clone();
      tag.scale.setScalar(0.0001);
      tag.userData.interactive = {
        onPointerHover: () => { tag.setText(text, CSS.amber); return true; },
        onPointerLeave: () => tag.setText(text, CSS.text),
        onPointerSelect: () => this.onAction?.(`explain:${concept}`),
      };
      this.tweens.add(0.35, (t) => tag.scale.set(finalScale.x * t, finalScale.y * t, 1), { delay: i * 0.15 });
      this.root.add(tag);
      this.interaction.register(tag);
      return tag;
    });
    this.packets.send(this.pcRouter, { color: COLOR.amber, duration: 0.6 }).then(() => {
      this.router.flash(COLOR.amber);
      this.bubble(this.router, 'gateway', CSS.amber);
    });
  }

  // ---------- nível 2 ----------

  beginSweep() {
    const center = POS.router.clone().setY(-0.03);
    for (let i = 0; i < 3; i += 1) {
      this.tweens.wait(i * 0.7).then(() => spawnWave(this.root, this.tweens, center, { radius: 0.75 }));
    }
  }

  #slotPosition(index) {
    const ring = Math.floor(index / RING.perRing);
    const k = index % RING.perRing;
    const offset = k === 0 ? 0 : (k % 2 ? (k + 1) / 2 : -k / 2); // 0, +1, -1, +2, -2...
    const angle = -Math.PI / 2 + offset * RING.step; // começa atrás do roteador
    const radius = RING.radius + ring * RING.ringGap;
    return new THREE.Vector3(Math.cos(angle) * radius, ring * 0.06, Math.sin(angle) * radius);
  }

  upsertDevice(device) {
    if (device.role === 'self') {
      this.pc.info = { ...this.pc.info, ...device };
      return this.pc;
    }
    if (device.role === 'gateway') {
      this.router.info = { ...this.router.info, ...device };
      this.#index(device.ip, this.router);
      return this.router;
    }
    let node = this.devices.get(device.ip);
    if (!node) {
      node = this.#addNode({
        id: `dev:${device.ip}`,
        kind: guessDeviceKind(device),
        label: deviceLabel(device),
        position: this.#slotPosition(this.devices.size),
      });
      node.appear();
      node.link = this.#addLink(this.router, node, { lift: 0.03, opacity: 0.3 });
      node.pathFromRouter = [[node.link, false]];
      this.devices.set(device.ip, node);
      this.#index(device.ip, node);
      // "Quem tem este IP?" sai do roteador e a resposta (com o MAC) volta.
      this.packets.send(node.link, { color: COLOR.holoLight, duration: 0.45 })
        .then(() => this.packets.send(node.link, { color: COLOR.amber, duration: 0.45, reverse: true }));
    }
    node.info = { ...node.info, ...device };
    node.setLabel(deviceLabel(node.info));
    return node;
  }

  // ---------- nível 3 ----------

  pathTo(node) {
    if (node === this.pc) return [];
    const base = [[this.pcRouter, false]];
    if (node === this.router) return base;
    if (node.pathFromRouter) return [...base, ...node.pathFromRouter];
    return [...base, [this.routerInternet, false]];
  }

  static reversePath(path) {
    return path.slice().reverse().map(([link, reverse]) => [link, !reverse]);
  }

  nodeForTarget(target) {
    return this.byIp.get(target) ?? this.internet;
  }

  async animatePing(node, reply) {
    const path = this.pathTo(node);
    await this.packets.travel(path, { color: COLOR.amber, duration: 0.2 });
    if (!reply.ok) {
      node.flash(COLOR.red, 0.7);
      this.bubble(node, 'perdido', CSS.red);
      return;
    }
    const color = latencyColor(reply.rtt_ms);
    node.flash(color, 0.5);
    this.bubble(node, formatMs(reply.rtt_ms), toCss(color));
    await this.packets.travel(NetWorld.reversePath(path), { color, duration: 0.2 });
    this.pc.flash(color, 0.3);
  }

  // ---------- nível 4 ----------

  clearTrace() {
    if (!this.trace) return;
    for (const link of this.trace.links) this.#removeLink(link);
    for (const node of this.trace.hops) this.#removeNode(node);
    this.trace = null;
  }

  startTrace({ target, address }) {
    this.clearTrace();
    this.trace = { target, address, chain: [this.router], hops: [], links: [] };
    this.bubble(this.pc, `rota até ${target}`, CSS.text, 2);
  }

  #layoutHops() {
    const slots = Math.max(this.trace.hops.length, 6) + 1;
    this.trace.hops.forEach((node, i) => {
      node.targetPos = HOP_CURVE.getPoint((i + 1) / slots);
    });
  }

  addHop(hop) {
    const { trace } = this;
    if (!trace) return;
    if (trace.chain.length === 1 && hop.ip && hop.ip === this.local?.gateway) {
      this.router.flash(COLOR.amber, 0.6);
      this.bubble(this.router, `salto 1 · ${formatMs(hop.rtt_ms ?? 0)}`);
      return;
    }
    const previous = trace.chain.at(-1);
    const color = HOP_COLOR[hop.scope] ?? COLOR.gray;
    const shown = hop.ip ?? '*';
    const time = hop.rtt_ms != null ? ` · ${formatMs(hop.rtt_ms)}` : '';
    const node = this.#addNode({
      id: `hop:${hop.hop}`,
      kind: 'hop',
      label: `${hop.hop} · ${shown}${time}`,
      position: previous.position,
      color,
    });
    node.info = { ...hop };
    node.appear();
    trace.hops.push(node);
    this.#layoutHops();
    const link = this.#addLink(previous, node, { lift: 0.02, opacity: 0.55, color });
    trace.links.push(link);
    node.pathFromRouter = [...(previous.pathFromRouter ?? []), [link, false]];
    trace.chain.push(node);
    this.#index(hop.ip, node, { override: false });
    this.packets.send(link, { color: COLOR.amber, duration: 0.35 }).then(() => node.flash(COLOR.amber, 0.4));
  }

  finishTrace(result) {
    const { trace } = this;
    if (!trace) return;
    const last = trace.chain.at(-1);
    if (last !== this.router) {
      trace.links.push(this.#addLink(last, this.internet, { lift: 0.02, opacity: 0.4, dashed: true }));
    }
    this.internet.flash(result.reached ? COLOR.holo : COLOR.red, 0.8);
    this.bubble(this.internet, result.reached ? `${result.hops} saltos` : 'destino não respondeu',
      result.reached ? CSS.holoLight : CSS.red, 2.2);
  }

  // ---------- nível 5 ----------

  async animateDns(result) {
    const ms = formatMs(result.ms);
    this.bubble(this.pc, `IP de ${result.name}?`, CSS.text, 1.4);
    if (result.cached) {
      this.pc.flash(COLOR.violet, 0.8);
      await this.tweens.wait(0.6);
      this.bubble(this.pc, `cache do PC · ${ms}`, toCss(COLOR.violet), 2);
    } else {
      const dns = this.dnsNode;
      const path = this.pathTo(dns);
      await this.packets.travel(path, { color: COLOR.violet, duration: 0.3 });
      dns.flash(COLOR.violet, 0.6);
      if (result.ms > 8) {
        this.bubble(dns, 'não sei... vou perguntar', toCss(COLOR.violet), 1.4);
        await this.packets.send(this.dnsInternet, { color: COLOR.violet, duration: 0.4 });
        this.internet.flash(COLOR.violet, 0.5);
        await this.packets.send(this.dnsInternet, { color: COLOR.holoLight, duration: 0.4, reverse: true });
      }
      await this.packets.travel(NetWorld.reversePath(path), { color: COLOR.holoLight, duration: 0.3 });
    }
    this.pc.flash(COLOR.holoLight, 0.5);
    this.bubble(this.pc, `${result.addresses[0] ?? '?'} · ${ms}`, CSS.holoLight, 2.6);
  }

  // ---------- nível 6 ----------

  #processSlot(index, total) {
    const t = total === 1 ? 0.5 : index / (total - 1);
    const angle = Math.PI * (0.12 + 0.76 * t);
    // Arco acima do PC (as etiquetas do nível 1 ficam abaixo dele, à direita).
    return new THREE.Vector3(
      POS.pc.x + Math.cos(angle) * 0.24,
      POS.pc.y + 0.15 + Math.sin(angle) * 0.06,
      POS.pc.z + 0.03,
    );
  }

  #spherePoint(ip) {
    const h = hash32(ip);
    const lon = ((h & 0xffff) / 0xffff - 0.5) * 2.6; // ±75°, virado para o usuário
    const lat = (((h >>> 16) & 0xffff) / 0xffff - 0.5) * 1.6;
    const dir = new THREE.Vector3(Math.sin(lon) * Math.cos(lat), Math.sin(lat), Math.cos(lon) * Math.cos(lat));
    return POS.internet.clone().addScaledVector(dir, SPHERE_RADIUS);
  }

  #endpointFor(connection) {
    if (connection.scope !== 'public' && connection.scope !== 'cgnat') {
      return this.byIp.get(connection.rip) ?? this.router;
    }
    let node = this.conn.endpoints.get(connection.rip);
    if (!node) {
      if (this.conn.endpoints.size >= MAX_ENDPOINTS) return this.internet;
      node = this.#addNode({ id: `ep:${connection.rip}`, kind: 'endpoint', label: '', position: this.#spherePoint(connection.rip) });
      node.pathFromRouter = [[this.routerInternet, false]];
      node.appear();
      this.conn.endpoints.set(connection.rip, node);
      this.#index(connection.rip, node, { override: false });
    }
    return node;
  }

  setConnections(data) {
    const { processes, endpoints, links } = this.conn;
    const keepProcesses = new Set();
    const keepLinks = new Set();

    data.processes.forEach((process, index) => {
      let node = processes.get(process.name);
      if (!node) {
        node = this.#addNode({
          id: `proc:${process.name}`, kind: 'process', label: '', position: POS.pc, color: COLOR.holoLight,
        });
        node.appear();
        node.pcLink = this.#addLink(this.pc, node, { lift: 0.01, opacity: 0.25 });
        processes.set(process.name, node);
      }
      node.targetPos = this.#processSlot(index, data.processes.length);
      node.info = process;
      node.setLabel(`${process.name} · ${process.count}`);
      keepProcesses.add(process.name);

      for (const connection of process.connections) {
        const target = this.#endpointFor(connection);
        const key = `${process.name}|${connection.rip}|${connection.rport}`;
        let link = links.get(key);
        if (!link) {
          link = this.#addLink(node, target, { lift: 0.1, opacity: 0.28, color: COLOR.holoLight });
          if (this.selected === node || this.selected === target) link.highlight();
          links.set(key, link);
        }
        link.info = { process: process.name, ...connection };
        if (target.kind === 'endpoint') target.info = { ...connection, process: process.name };
        keepLinks.add(key);
      }
    });

    for (const [key, link] of links) {
      if (!keepLinks.has(key)) {
        this.#removeLink(link);
        links.delete(key);
      }
    }
    const usedEndpoints = new Set([...links.values()].map((link) => link.b));
    for (const [ip, node] of endpoints) {
      if (!usedEndpoints.has(node)) {
        this.#removeNode(node);
        endpoints.delete(ip);
      }
    }
    for (const [name, node] of processes) {
      if (!keepProcesses.has(name)) {
        this.#removeLink(node.pcLink);
        this.#removeNode(node);
        processes.delete(name);
      }
    }
  }

  clearConnections() {
    this.setConnections({ processes: [] });
  }

  connectionsOf(node) {
    return [...this.conn.links.values()].filter((link) => link.a === node || link.b === node).map((l) => l.info);
  }

  // ---------- tráfego ----------

  setThroughput(data) {
    this.throughput = data;
    this.rateLabel.setText(`↓ ${formatBytesPerSecond(data.rx_bps)}   ↑ ${formatBytesPerSecond(data.tx_bps)}`);
  }

  #ambientTraffic(dt) {
    const { rx_bps: rx, tx_bps: tx } = this.throughput;
    const total = rx + tx;
    if (total <= 0) return;
    // Mais bytes por segundo = mais bolinhas (entre 0,4 e 14 por segundo).
    this.trafficBudget += dt * THREE.MathUtils.clamp(total / 50_000, 0.4, 14);
    const connectionLinks = [...this.conn.links.values()];
    while (this.trafficBudget >= 1) {
      this.trafficBudget -= 1;
      const download = Math.random() < rx / total;
      const color = download ? COLOR.amber : COLOR.holoLight;
      if (connectionLinks.length) {
        const link = connectionLinks[Math.floor(Math.random() * connectionLinks.length)];
        this.packets.send(link, { color, duration: 0.9, reverse: download, size: 0.005 });
      } else {
        const path = [[this.pcRouter, false], [this.routerInternet, false]];
        this.packets.travel(download ? NetWorld.reversePath(path) : path, { color, duration: 0.5, size: 0.005 });
      }
    }
  }

  // ---------- quadro a quadro ----------

  update(dt, time, cameraPosition) {
    this.tweens.update(dt);
    this.packets.update(dt);
    const follow = 1 - Math.exp(-dt * 6);
    for (const node of this.nodes) {
      if (node.targetPos) node.position.lerp(node.targetPos, follow);
      node.update(dt, time);
    }
    for (const link of this.links) link.refresh();
    if (this.selected && !this.detail.visible) this.deselect();
    this.detail.update(cameraPosition);
    this.#ambientTraffic(dt);
  }
}
