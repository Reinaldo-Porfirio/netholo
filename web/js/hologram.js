import * as THREE from './three.js';
import { COLOR } from './theme.js';
import { TextSprite } from './text.js';

// "Visual de holograma": preenchimento bem transparente + arestas brilhantes.
function shell(geometry, materials, { fill = 0.16, edges = 0.95 } = {}) {
  const group = new THREE.Group();
  const fillMaterial = new THREE.MeshBasicMaterial({
    color: COLOR.holo, transparent: true, opacity: fill, depthWrite: false, side: THREE.DoubleSide,
  });
  const lineMaterial = new THREE.LineBasicMaterial({ color: COLOR.holo, transparent: true, opacity: edges });
  materials.push(fillMaterial, lineMaterial);
  group.add(new THREE.Mesh(geometry, fillMaterial));
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), lineMaterial));
  return group;
}

function wire(geometry, materials, opacity = 0.75) {
  const material = new THREE.LineBasicMaterial({ color: COLOR.holo, transparent: true, opacity });
  materials.push(material);
  return new THREE.LineSegments(new THREE.WireframeGeometry(geometry), material);
}

const SHAPES = {
  internet(materials) {
    const group = new THREE.Group();
    group.add(wire(new THREE.IcosahedronGeometry(0.12, 2), materials, 0.55));
    group.add(shell(new THREE.SphereGeometry(0.105, 24, 16), materials, { fill: 0.06, edges: 0 }));
    return group;
  },
  router(materials) {
    const group = shell(new THREE.BoxGeometry(0.12, 0.028, 0.08), materials);
    for (const x of [-0.04, 0.04]) {
      const antenna = shell(new THREE.CylinderGeometry(0.003, 0.003, 0.06, 6), materials);
      antenna.position.set(x, 0.044, -0.03);
      group.add(antenna);
    }
    return group;
  },
  pc(materials) {
    const group = shell(new THREE.BoxGeometry(0.12, 0.075, 0.008), materials);
    const stand = shell(new THREE.BoxGeometry(0.012, 0.03, 0.012), materials);
    stand.position.y = -0.052;
    const base = shell(new THREE.BoxGeometry(0.05, 0.004, 0.03), materials);
    base.position.y = -0.068;
    group.add(stand, base);
    return group;
  },
  dns(materials) {
    return shell(new THREE.DodecahedronGeometry(0.03), materials);
  },
  phone(materials) {
    return shell(new THREE.BoxGeometry(0.03, 0.056, 0.006), materials);
  },
  tv(materials) {
    return shell(new THREE.BoxGeometry(0.09, 0.054, 0.006), materials);
  },
  laptop(materials) {
    const group = shell(new THREE.BoxGeometry(0.07, 0.004, 0.048), materials);
    const screen = shell(new THREE.BoxGeometry(0.07, 0.044, 0.003), materials);
    screen.position.set(0, 0.022, -0.024);
    screen.rotation.x = -0.25;
    group.add(screen);
    return group;
  },
  printer(materials) {
    return shell(new THREE.BoxGeometry(0.06, 0.032, 0.045), materials);
  },
  iot(materials) {
    return shell(new THREE.OctahedronGeometry(0.02), materials);
  },
  device(materials) {
    return shell(new THREE.OctahedronGeometry(0.026), materials);
  },
  hop(materials) {
    return shell(new THREE.IcosahedronGeometry(0.016, 0), materials);
  },
  process(materials) {
    return shell(new THREE.SphereGeometry(0.014, 12, 8), materials, { fill: 0.3 });
  },
  endpoint(materials) {
    return shell(new THREE.SphereGeometry(0.008, 8, 6), materials, { fill: 0.6, edges: 0.4 });
  },
};

const RADIUS = {
  internet: 0.13, router: 0.07, pc: 0.075, dns: 0.04, phone: 0.04, tv: 0.055, laptop: 0.05,
  printer: 0.045, iot: 0.035, device: 0.035, hop: 0.03, process: 0.025, endpoint: 0.018,
};

const easeOutBack = (t) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;

/**
 * Um nó da rede em holograma: corpo 3D + rótulo + esfera invisível para o raio acertar.
 * Estados visuais: normal (verde-água), apontado (mais claro) e selecionado (âmbar).
 */
export class HoloNode extends THREE.Group {
  constructor({ id, kind, label = '', color = COLOR.holo, spin = 0, labelHeight = 0.026 }) {
    super();
    this.nodeId = id;
    this.kind = kind;
    this.info = {};
    this.materials = [];
    this.baseColor = color;
    this.spin = spin;
    this.hovered = false;
    this.selected = false;
    this.flashColor = null;
    this.flashLeft = 0;
    this.appearT = 1;
    this.appearDelay = 0;
    this.phase = Math.random() * Math.PI * 2;
    this.onSelect = null;

    this.body = (SHAPES[kind] ?? SHAPES.device)(this.materials);
    this.add(this.body);

    const radius = RADIUS[kind] ?? 0.035;
    this.radius = radius;
    this.label = new TextSprite(label, { height: labelHeight });
    this.label.position.y = -radius - 0.012;
    this.label.visible = Boolean(label);
    this.add(this.label);

    this.hitMesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 10, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.hitMesh.userData.interactive = this;
    this.add(this.hitMesh);
    this.#applyColor();
  }

  setLabel(text, color) {
    this.label.setText(text, color);
    this.label.visible = Boolean(text);
  }

  setBaseColor(color) {
    this.baseColor = color;
    this.#applyColor();
  }

  setSelected(value) {
    this.selected = value;
    this.#applyColor();
  }

  /** Pisca numa cor por um instante (ex.: quando um pacote chega). */
  flash(color, seconds = 0.5) {
    this.flashColor = color;
    this.flashLeft = seconds;
    this.#applyColor();
  }

  /** Animação de "surgir" (escala de 0 a 1 com um leve exagero). */
  appear(delay = 0) {
    this.appearT = 0;
    this.appearDelay = delay;
    this.scale.setScalar(0.001);
  }

  #applyColor() {
    let color = this.baseColor;
    if (this.hovered) color = COLOR.holoLight;
    if (this.selected) color = COLOR.amber;
    if (this.flashLeft > 0 && this.flashColor != null) color = this.flashColor;
    for (const material of this.materials) material.color.setHex(color);
  }

  update(dt, time) {
    if (this.appearT < 1) {
      if (this.appearDelay > 0) {
        this.appearDelay -= dt;
      } else {
        this.appearT = Math.min(1, this.appearT + dt / 0.5);
        this.scale.setScalar(Math.max(0.001, easeOutBack(this.appearT)));
      }
    }
    if (this.spin) this.body.rotation.y += this.spin * dt;
    this.body.position.y = Math.sin(time * 1.6 + this.phase) * 0.003; // "flutuar" de leve
    if (this.flashLeft > 0) {
      this.flashLeft -= dt;
      if (this.flashLeft <= 0) this.#applyColor();
    }
  }

  onPointerHover() {
    if (!this.hovered) {
      this.hovered = true;
      this.#applyColor();
    }
    return true;
  }

  onPointerLeave() {
    this.hovered = false;
    this.#applyColor();
  }

  onPointerSelect() {
    this.onSelect?.(this);
  }

  dispose() {
    this.traverse((object) => {
      object.geometry?.dispose();
      object.material?.dispose?.();
    });
    this.label.dispose();
  }
}

/** Palpite do tipo de aparelho pelo fabricante/nome (só para escolher o ícone). */
export function guessDeviceKind(device) {
  const text = `${device.vendor ?? ''} ${device.name ?? ''}`.toLowerCase();
  if (device.randomized) return 'phone';
  if (/(tv|roku|chromecast|fire ?stick|lg electronics|tcl|hisense)/.test(text)) return 'tv';
  if (/(phone|iphone|android|galaxy|xiaomi|motorola|redmi|celular)/.test(text)) return 'phone';
  if (/(printer|impressora|epson|canon|brother|hewlett)/.test(text)) return 'printer';
  if (/(espressif|tuya|shelly|sonoff|lampada|lâmpada|smart plug|echo|nest)/.test(text)) return 'iot';
  if (/(notebook|laptop|dell|lenovo|asus|acer|intel|desktop|pc)/.test(text)) return 'laptop';
  return 'device';
}
