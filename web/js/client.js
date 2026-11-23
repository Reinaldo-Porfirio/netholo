/**
 * Cliente do WebSocket do agente.
 *
 * `request(tipo, params, { onEvent })` devolve uma Promise que resolve com o resultado final;
 * no caminho, `onEvent` recebe os eventos em tempo real (cada resposta de ping, cada salto...).
 * Mensagens "terminal" e "push" viram eventos do próprio cliente (addEventListener).
 */
export class AgentClient extends EventTarget {
  constructor(token) {
    super();
    this.token = token;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.retries = 0;
    this.demo = false;
  }

  get online() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${location.host}/ws?token=${encodeURIComponent(this.token)}`;
    this.#emit('status', 'connecting');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retries = 0;
      this.#emit('status', 'online');
    });
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#handle(message);
    });
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('Conexão com o agente caiu.'));
      this.pending.clear();
      this.#emit('status', 'offline');
      // Reconecta com espera crescente (0,5 s, 1 s, 2 s... até 10 s).
      const delay = Math.min(10_000, 500 * 2 ** this.retries);
      this.retries += 1;
      setTimeout(() => this.connect(), delay);
    });
  }

  #handle(message) {
    const pending = this.pending.get(message.id);
    switch (message.type) {
      case 'hello':
        this.demo = Boolean(message.demo);
        this.#emit('hello', message);
        break;
      case 'push':
        this.#emit(`push:${message.topic}`, message.data);
        break;
      case 'terminal':
        this.#emit('terminal', message);
        break;
      case 'event':
        pending?.onEvent?.(message.event, message.data);
        break;
      case 'done':
        if (pending) {
          this.pending.delete(message.id);
          pending.resolve(message.data);
        }
        break;
      case 'error':
        if (pending) {
          this.pending.delete(message.id);
          pending.reject(new Error(message.message));
        } else {
          this.#emit('agent-error', message.message);
        }
        break;
      default:
        break;
    }
  }

  request(type, params = {}, { onEvent } = {}) {
    if (!this.online) return Promise.reject(new Error('Sem conexão com o agente.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent });
      this.ws.send(JSON.stringify({ id, type, params }));
    });
  }
}
