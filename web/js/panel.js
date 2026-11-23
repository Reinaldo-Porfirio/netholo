import * as THREE from './three.js';
import { CSS, FONT, MONO } from './theme.js';

const PX_PER_METER = 2000;
const PAD = 26;
const BUTTON_H = 54;
const GAP = 12;

const STYLE = {
  title: { size: 32, weight: 650, color: CSS.text, gap: 8 },
  subtitle: { size: 23, weight: 500, color: CSS.muted, gap: 6 },
  body: { size: 24, weight: 400, color: CSS.text, gap: 4 },
  mono: { size: 21, weight: 400, color: CSS.holoLight, gap: 2 },
};

const BUTTON_STYLE = {
  default: { fill: CSS.button, stroke: CSS.holo, text: CSS.text },
  primary: { fill: 'rgba(250, 199, 117, 0.16)', stroke: CSS.amber, text: CSS.amber },
  active: { fill: 'rgba(93, 202, 165, 0.45)', stroke: CSS.holoLight, text: '#ffffff' },
  danger: { fill: CSS.danger, stroke: CSS.red, text: CSS.red },
};

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function truncate(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 0 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) end -= 1;
  return `${text.slice(0, end)}…`;
}

/**
 * Painel 2D flutuando no espaço: um plano com textura desenhada num <canvas>.
 * Os botões são áreas do canvas; o raio do controle acerta o plano e a coordenada UV
 * do ponto atingido diz qual botão foi apontado.
 *
 * Conteúdo: { title, subtitle, lines: [{ text, color, mono, wrap }], buttons: [...],
 *             buttonLayout: 'row' | 'column', closable }
 */
export class Panel extends THREE.Mesh {
  constructor({ width = 0.36, onButton = null, billboard = true } = {}) {
    const canvas = document.createElement('canvas');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const material = new THREE.MeshBasicMaterial({
      map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    super(new THREE.PlaneGeometry(1, 1), material);
    this.canvas = canvas;
    this.texture = texture;
    this.widthMeters = width;
    this.onButton = onButton;
    this.billboard = billboard;
    this.content = { title: '' };
    this.buttonRects = [];
    this.hoverId = null;
    this.anchorTop = null;
    this.dirty = true;
    this.renderOrder = 20;
    this.userData.interactive = this;
  }

  setContent(content) {
    this.content = content;
    this.dirty = true;
  }

  update(cameraPosition) {
    if (!this.visible) return;
    if (this.dirty) this.#redraw();
    // Painéis mudam de altura conforme o conteúdo; ancorar pelo topo evita que "pulem".
    if (this.anchorTop != null) this.position.y = this.anchorTop - this.scale.y / 2;
    if (this.billboard && cameraPosition) this.lookAt(cameraPosition);
  }

  #layout(ctx, width) {
    const { title, subtitle, lines = [], buttons = [], buttonLayout = 'row', closable } = this.content;
    const inner = width - PAD * 2;
    const ops = [];
    let y = PAD;

    const addText = (text, style, { color, mono = false, wrap = true, maxWidth = inner } = {}) => {
      ctx.font = `${style.weight} ${style.size}px ${mono ? MONO : FONT}`;
      const rows = wrap ? wrapText(ctx, text, maxWidth) : [truncate(ctx, text, maxWidth)];
      for (const row of rows) {
        ops.push({ kind: 'text', text: row, x: PAD, y, style, color: color ?? style.color, mono });
        y += style.size + style.gap + 4;
      }
    };

    if (title) addText(title, STYLE.title, { maxWidth: closable ? inner - 60 : inner });
    if (subtitle) addText(subtitle, STYLE.subtitle);
    if (title || subtitle) y += 6;
    for (const line of lines) {
      if (line.spacer) { y += 10; continue; }
      addText(line.text, line.mono ? STYLE.mono : STYLE.body, line);
    }

    const rects = [];
    if (buttons.length) {
      y += 10;
      ctx.font = `600 23px ${FONT}`;
      let x = PAD;
      for (const button of buttons) {
        const w = buttonLayout === 'column' ? inner : Math.min(inner, ctx.measureText(button.label).width + 40);
        if (x + w > width - PAD + 0.5) { x = PAD; y += BUTTON_H + GAP; }
        rects.push({ ...button, x, y, w, h: BUTTON_H });
        if (buttonLayout === 'column') { y += BUTTON_H + GAP; } else { x += w + GAP; }
      }
      if (buttonLayout !== 'column') y += BUTTON_H + GAP;
      y -= GAP;
    }
    if (closable) rects.push({ id: '__close', label: '×', x: width - PAD - 48, y: PAD - 6, w: 48, h: 48, close: true });
    return { ops, rects, height: Math.ceil(y + PAD) };
  }

  #redraw() {
    this.dirty = false;
    const width = Math.round(this.widthMeters * PX_PER_METER);
    const ctx = this.canvas.getContext('2d');
    const { ops, rects, height } = this.#layout(ctx, width);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.texture.dispose(); // tamanho novo: a textura é recriada na GPU
    }

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = CSS.panel;
    ctx.strokeStyle = this.content.accent ?? CSS.holo;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(1.5, 1.5, width - 3, height - 3, 18);
    ctx.fill();
    ctx.stroke();

    ctx.textBaseline = 'top';
    for (const op of ops) {
      ctx.font = `${op.style.weight} ${op.style.size}px ${op.mono ? MONO : FONT}`;
      ctx.fillStyle = op.color;
      ctx.fillText(op.text, op.x, op.y);
    }

    for (const rect of rects) {
      const style = BUTTON_STYLE[rect.kind ?? 'default'];
      const hovered = rect.id === this.hoverId && !rect.disabled;
      ctx.globalAlpha = rect.disabled ? 0.4 : 1;
      if (!rect.close) {
        ctx.fillStyle = hovered ? CSS.buttonHover : style.fill;
        ctx.strokeStyle = hovered ? CSS.amber : style.stroke;
        ctx.lineWidth = hovered ? 3 : 2;
        ctx.beginPath();
        ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 12);
        ctx.fill();
        ctx.stroke();
      }
      ctx.font = `600 ${rect.close ? 40 : 23}px ${FONT}`;
      ctx.fillStyle = hovered ? CSS.amber : (rect.close ? CSS.muted : style.text);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(rect.label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.globalAlpha = 1;
    }

    this.buttonRects = rects;
    this.texture.needsUpdate = true;
    this.scale.set(this.widthMeters, (this.widthMeters * height) / width, 1);
  }

  buttonAt(uv) {
    if (!uv) return null;
    const x = uv.x * this.canvas.width;
    const y = (1 - uv.y) * this.canvas.height;
    const rect = this.buttonRects.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    return rect && !rect.disabled ? rect.id : null;
  }

  // Interface usada pela classe Interaction (raio do controle ou mouse).
  onPointerHover(hit) {
    const id = this.buttonAt(hit?.uv);
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.dirty = true;
    }
    return Boolean(id);
  }

  onPointerLeave() {
    this.onPointerHover(null);
  }

  onPointerSelect(hit) {
    const id = this.buttonAt(hit?.uv);
    if (id === '__close') this.visible = false;
    else if (id && this.onButton) this.onButton(id, this);
  }
}

/** Terminal espelho: mostra o comando real que o PC está rodando e a saída dele. */
export class TerminalPanel extends Panel {
  constructor(options = {}) {
    super({ width: 0.46, ...options });
    this.maxLines = 14;
    this.command = null;
    this.lines = [];
    this.#render();
  }

  begin(command) {
    this.command = command;
    this.lines = [];
    this.#render();
  }

  print(text, color) {
    if (text === '' && (this.lines.length === 0 || this.lines.at(-1).text === '')) return;
    this.lines.push({ text, color });
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    this.#render();
  }

  #render() {
    const body = this.lines.length
      ? this.lines.map((l) => ({ text: l.text || ' ', mono: true, wrap: false, color: l.color }))
      : [{ text: 'Escolha uma ação: o comando real aparece aqui.', color: CSS.muted }];
    this.setContent({
      title: 'Terminal espelho',
      subtitle: this.command ? `> ${this.command}` : 'o que o PC está executando',
      lines: body,
    });
  }
}
