import { Panel } from './panel.js';
import { CSS } from './theme.js';

/** A trilha: cada nível ensina um conceito e tem ações que rodam o comando real no PC. */
export const LEVELS = [
  {
    id: 1,
    name: 'Seu PC na rede',
    command: 'ipconfig /all',
    text: [
      'Todo aparelho na rede tem um endereço IP. A máscara diz quais IPs são vizinhos (mesma rede).',
      'O gateway é a porta de saída, normalmente o roteador. O DNS traduz nomes em IPs. O MAC é o "RG" da placa de rede.',
      'Clique nas etiquetas ao lado do PC para ver cada conceito.',
    ],
    actions: [{ id: 'local.info', label: 'Ler minha configuração', kind: 'primary' }],
  },
  {
    id: 2,
    name: 'A rede local (ARP)',
    command: 'arp -a',
    text: [
      'Para falar com um vizinho, o PC pergunta para todos: "quem tem este IP?" (ARP). O dono responde com o MAC.',
      'A varredura manda um ping para cada IP da sub-rede e anota quem respondeu. Aparelhos que bloqueiam ping podem não aparecer.',
    ],
    actions: [{ id: 'lan.scan', label: 'Varrer a rede', kind: 'primary' }],
  },
  {
    id: 3,
    name: 'Ping e latência',
    command: 'ping',
    text: [
      'O ping envia um pacote ICMP "echo request" e espera o "echo reply". O tempo de ida e volta é a latência.',
      'Verde: menos de 30 ms. Âmbar: menos de 120 ms. Vermelho: lento ou perdido. Aponte para qualquer aparelho e use o Ping.',
    ],
    actions: [
      { id: 'ping:gateway', label: 'Ping no roteador', kind: 'primary' },
      { id: 'ping:8.8.8.8', label: 'Ping 8.8.8.8' },
    ],
  },
  {
    id: 4,
    name: 'Caminho até a Internet',
    command: 'tracert',
    text: [
      'Seu pacote passa por vários roteadores (saltos). O traceroute manda pacotes com TTL crescente: cada roteador que descarta um deles se revela.',
      'Saltos com * não responderam. IPs privados e 100.64.x.x (CGNAT) ainda são a rede do provedor.',
    ],
    actions: [
      { id: 'trace:1.1.1.1', label: 'Rota até 1.1.1.1', kind: 'primary' },
      { id: 'trace:google.com', label: 'Rota até google.com' },
    ],
  },
  {
    id: 5,
    name: 'DNS',
    command: 'nslookup',
    text: [
      'Antes de conectar em github.com o PC precisa do IP. Ele pergunta ao servidor DNS (geralmente o roteador), que pergunta adiante se não souber.',
      'As respostas ficam em cache: repita a mesma consulta e veja o tempo cair.',
    ],
    actions: [
      { id: 'dns:github.com', label: 'github.com', kind: 'primary' },
      { id: 'dns:wikipedia.org', label: 'wikipedia.org' },
      { id: 'dns:youtube.com', label: 'youtube.com' },
      { id: 'dns:google.com', label: 'google.com' },
    ],
  },
  {
    id: 6,
    name: 'Portas e programas',
    command: 'netstat -ano',
    text: [
      'Cada conexão liga um programa do PC (porta local) a um destino (IP:porta). A porta indica o serviço: 443 é HTTPS, 53 é DNS.',
      'TCP abre conexão com confirmação; UDP só envia. As bolinhas mostram o volume total do PC (o Windows não informa por conexão sem captura).',
    ],
    actions: [{ id: 'conn:toggle', label: 'Mostrar conexões ao vivo', kind: 'primary' }],
  },
];

/** Explicações curtas que aparecem ao clicar em etiquetas e detalhes. */
export const CONCEPTS = {
  ip: ['Endereço IP', 'O "endereço da casa" do aparelho na rede. Na rede local ele é privado (192.168.x.x, 10.x.x.x), e quem dá esse IP é o DHCP do roteador.'],
  mask: ['Máscara de sub-rede', 'Diz quantos bits do IP são a rede. /24 (255.255.255.0) significa: os 3 primeiros números são a rede e o último é o aparelho, até 254 vizinhos.'],
  gateway: ['Gateway padrão', 'Para onde vai todo pacote que não é para um vizinho. Em casa é o roteador, que encaminha para a Internet.'],
  dns: ['Servidor DNS', 'A "lista telefônica" da Internet: transforma nomes (github.com) em IPs. Em casa costuma ser o roteador, que repassa ao provedor.'],
  mac: ['Endereço MAC', 'Identificador da placa de rede (camada 2). Os 3 primeiros bytes dizem o fabricante. Só vale dentro da rede local: não atravessa o roteador.'],
};

/** Menu de níveis + painel da lição atual (os botões da lição são ligados pelo App). */
export class LevelMenu {
  constructor() {
    this.current = 1;
    this.connectionsOn = false;
    this.menu = new Panel({ width: 0.3, onButton: (id) => this.select(Number(id.split(':')[1])) });
    this.lesson = new Panel({ width: 0.36 });
    this.#render();
  }

  get level() {
    return LEVELS.find((level) => level.id === this.current);
  }

  select(id) {
    if (!LEVELS.some((level) => level.id === id)) return;
    this.current = id;
    this.#render();
  }

  setConnectionsOn(on) {
    this.connectionsOn = on;
    this.#render();
  }

  #render() {
    this.menu.setContent({
      title: 'Trilha de redes',
      subtitle: 'gatilho: selecionar · grip: mover a cena',
      buttonLayout: 'column',
      buttons: LEVELS.map((level) => ({
        id: `level:${level.id}`,
        label: `${level.id} · ${level.name}`,
        kind: level.id === this.current ? 'active' : 'default',
      })),
    });

    const { level } = this;
    const actions = level.actions.map((action) => (
      action.id === 'conn:toggle' && this.connectionsOn
        ? { ...action, label: 'Esconder conexões', kind: 'danger' }
        : action
    ));
    this.lesson.setContent({
      title: `Nível ${level.id} · ${level.name}`,
      lines: [
        ...level.text.map((text) => ({ text })),
        { spacer: true },
        { text: `No terminal: ${level.command}`, mono: true, color: CSS.amber },
      ],
      buttons: actions,
    });
  }
}
