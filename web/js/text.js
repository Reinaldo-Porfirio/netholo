import * as THREE from './three.js';
import { CSS, FONT } from './theme.js';

const PX_HEIGHT = 64;

/**
 * Rótulo de texto que sempre fica de frente para quem olha (Sprite).
 * O texto é desenhado num <canvas> e enviado como textura para a placa de vídeo.
 */
export class TextSprite extends THREE.Sprite {
  constructor(text, { height = 0.03, color = CSS.text, background = 'rgba(4, 34, 29, 0.72)', weight = 600 } = {}) {
    const canvas = document.createElement('canvas');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    super(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
    this.canvas = canvas;
    this.texture = texture;
    this.worldHeight = height;
    this.background = background;
    this.weight = weight;
    this.renderOrder = 10;
    this.setText(text, color);
  }

  setText(text, color = this.color) {
    if (text === this.text && color === this.color) return;
    this.text = text;
    this.color = color;
    const ctx = this.canvas.getContext('2d');
    const font = `${this.weight} ${PX_HEIGHT * 0.56}px ${FONT}`;
    ctx.font = font;
    const width = Math.ceil(ctx.measureText(text).width + PX_HEIGHT * 0.6);
    if (width !== this.canvas.width || this.canvas.height !== PX_HEIGHT) {
      this.canvas.width = width;
      this.canvas.height = PX_HEIGHT;
      // Mudou o tamanho do canvas: a textura antiga precisa ser recriada na GPU.
      this.texture.dispose();
    }
    ctx.clearRect(0, 0, width, PX_HEIGHT);
    if (this.background) {
      ctx.fillStyle = this.background;
      ctx.beginPath();
      ctx.roundRect(0, 4, width, PX_HEIGHT - 8, 14);
      ctx.fill();
    }
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, width / 2, PX_HEIGHT / 2 + 1);
    this.texture.needsUpdate = true;
    this.scale.set((this.worldHeight * width) / PX_HEIGHT, this.worldHeight, 1);
  }

  setOpacity(value) {
    this.material.opacity = value;
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
  }
}
