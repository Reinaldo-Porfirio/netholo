import * as THREE from './three.js';
import { COLOR, CSS } from './theme.js';
import { TextSprite } from './text.js';

const SEGMENTS = 24;
const ORIGIN = new THREE.Vector3();
const UNIT = new THREE.Quaternion();

/** Animações simples por tempo (sem biblioteca): cada uma chama onUpdate(progresso 0→1). */
export class Tweens {
  constructor() {
    this.items = [];
  }

  add(duration, onUpdate, { delay = 0, ease = (t) => t } = {}) {
    return new Promise((resolve) => {
      this.items.push({ elapsed: -delay, duration: Math.max(duration, 1e-3), onUpdate, ease, resolve });
    });
  }

  wait(seconds) {
    return this.add(seconds, () => {});
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const item = this.items[i];
      item.elapsed += dt;
      if (item.elapsed < 0) continue;
      const progress = Math.min(1, item.elapsed / item.duration);
      item.onUpdate(item.ease(progress));
      if (progress >= 1) {
        this.items.splice(i, 1);
        item.resolve();
      }
    }
  }
}

export const easeOut = (t) => 1 - (1 - t) ** 3;

/** Linha curva entre dois nós (conexão). A curva sobe um pouco no meio, como um arco. */
export class Link extends THREE.Line {
  constructor(a, b, { color = COLOR.holo, opacity = 0.4, lift = 0.06, dashed = false } = {}) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3));
    const material = dashed
      ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.014, gapSize: 0.01 })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    super(geometry, material);
    this.a = a;
    this.b = b;
    this.lift = lift;
    this.dashed = dashed;
    this.baseColor = color;
    this.baseOpacity = opacity;
    this.curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3());
    this.frustumCulled = false;
    this.refresh(true);
  }

  refresh(force = false) {
    const { v0, v1, v2 } = this.curve;
    if (!force && v0.equals(this.a.position) && v2.equals(this.b.position)) return;
    v0.copy(this.a.position);
    v2.copy(this.b.position);
    v1.lerpVectors(v0, v2, 0.5);
    v1.y += this.lift * Math.max(0.3, v0.distanceTo(v2));
    const positions = this.geometry.attributes.position;
    const point = new THREE.Vector3();
    for (let i = 0; i <= SEGMENTS; i += 1) {
      this.curve.getPoint(i / SEGMENTS, point);
      positions.setXYZ(i, point.x, point.y, point.z);
    }
    positions.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    if (this.dashed) this.computeLineDistances();
  }

  pointAt(t, target) {
    return this.curve.getPoint(t, target);
  }

  highlight(color = COLOR.amber, opacity = 0.9) {
    this.material.color.setHex(color);
    this.material.opacity = opacity;
  }

  reset() {
    this.highlight(this.baseColor, this.baseOpacity);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Pacotes = bolinhas andando pelas linhas. Usa um InstancedMesh: centenas de bolinhas
 * desenhadas numa única chamada à placa de vídeo, o que importa muito no Quest.
 */
export class PacketSystem extends THREE.InstancedMesh {
  constructor(capacity = 360) {
    super(
      new THREE.SphereGeometry(1, 10, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false }),
      capacity,
    );
    this.frustumCulled = false;
    this.renderOrder = 5;
    this.live = [];
    this.free = [];
    this.matrix4 = new THREE.Matrix4();
    this.point = new THREE.Vector3();
    this.size = new THREE.Vector3();
    this.tmpColor = new THREE.Color();
    const white = new THREE.Color(0xffffff);
    for (let i = capacity - 1; i >= 0; i -= 1) {
      this.free.push(i);
      this.setColorAt(i, white);
      this.#hide(i);
    }
  }

  #hide(index) {
    this.matrix4.makeScale(0, 0, 0);
    this.setMatrixAt(index, this.matrix4);
  }

  /** Manda uma bolinha pela linha. A Promise resolve quando ela chega no destino. */
  send(link, { color = COLOR.amber, duration = 0.8, reverse = false, size = 0.0065 } = {}) {
    const index = this.free.pop();
    if (index === undefined) return Promise.resolve(false); // limite atingido: ignora
    this.setColorAt(index, this.tmpColor.setHex(color));
    this.instanceColor.needsUpdate = true;
    return new Promise((resolve) => {
      this.live.push({ index, link, t: 0, duration, reverse, size, resolve });
    });
  }

  /** Percorre vários trechos em sequência: [[link, reverse], ...]. */
  async travel(path, options) {
    for (const [link, reverse] of path) {
      if (!(await this.send(link, { ...options, reverse }))) return false;
    }
    return true;
  }

  dropLink(link) {
    for (const packet of this.live) if (packet.link === link) packet.t = 2;
  }

  get busy() {
    return this.live.length;
  }

  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const packet = this.live[i];
      packet.t += dt / packet.duration;
      if (packet.t >= 1) {
        this.#hide(packet.index);
        this.free.push(packet.index);
        this.live[i] = this.live[this.live.length - 1];
        this.live.pop();
        packet.resolve(packet.t < 2);
        continue;
      }
      packet.link.pointAt(packet.reverse ? 1 - packet.t : packet.t, this.point);
      this.size.setScalar(packet.size);
      this.matrix4.compose(this.point, UNIT, this.size);
      this.setMatrixAt(packet.index, this.matrix4);
    }
    this.instanceMatrix.needsUpdate = true;
  }
}

/** Onda circular saindo de um ponto (o "broadcast" da varredura ARP). */
export function spawnWave(parent, tweens, position, { color = COLOR.holo, radius = 0.7, duration = 1.6 } = {}) {
  const material = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 64), material);
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(position ?? ORIGIN);
  parent.add(ring);
  return tweens
    .add(duration, (t) => {
      ring.scale.setScalar(0.02 + t * radius);
      material.opacity = 0.6 * (1 - t);
    }, { ease: easeOut })
    .then(() => {
      parent.remove(ring);
      ring.geometry.dispose();
      material.dispose();
    });
}

/** Balão de texto que sobe e some (ex.: "12 ms", "perdido"). */
export function spawnBubble(parent, tweens, text, position, { color = CSS.amber, duration = 1.6, height = 0.024 } = {}) {
  const sprite = new TextSprite(text, { height, color });
  sprite.position.copy(position);
  parent.add(sprite);
  const startY = position.y;
  return tweens
    .add(duration, (t) => {
      sprite.position.y = startY + t * 0.06;
      sprite.setOpacity(t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3);
    })
    .then(() => {
      parent.remove(sprite);
      sprite.dispose();
    });
}
