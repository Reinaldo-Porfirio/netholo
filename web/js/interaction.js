import * as THREE from './three.js';
import { COLOR } from './theme.js';

const RAY_LENGTH = 1.5;
const CLICK_TOLERANCE_PX = 6;

function isShown(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** Câmera "orbital" para o modo PC: arrastar gira, rodinha aproxima. */
class DesktopOrbit {
  constructor(camera, dom, target) {
    this.camera = camera;
    this.target = target;
    this.radius = 1.35;
    this.theta = 0.45; // começa um pouco de lado: a profundidade da cena fica visível
    this.phi = 1.1;
    this.enabled = true;
    this.dragging = null;
    this.spherical = new THREE.Spherical();

    dom.addEventListener('pointerdown', (e) => { this.dragging = { x: e.clientX, y: e.clientY }; });
    window.addEventListener('pointerup', () => { this.dragging = null; });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging || !this.enabled) return;
      this.theta -= (e.clientX - this.dragging.x) * 0.005;
      this.phi = THREE.MathUtils.clamp(this.phi - (e.clientY - this.dragging.y) * 0.005, 0.35, 1.55);
      this.dragging = { x: e.clientX, y: e.clientY };
    });
    dom.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.radius = THREE.MathUtils.clamp(this.radius * (1 + e.deltaY * 0.001), 0.45, 2.6);
    }, { passive: false });
  }

  update() {
    if (!this.enabled) return;
    this.spherical.set(this.radius, this.phi, this.theta);
    this.camera.position.setFromSpherical(this.spherical).add(this.target);
    this.camera.lookAt(this.target);
  }
}

/**
 * Apontar e clicar nos hologramas, com o controle do Quest (ou a mão, com pinça) e com
 * o mouse no PC. Um "raio" sai do controle; o primeiro objeto interativo que ele acerta
 * recebe onPointerHover/onPointerLeave/onPointerSelect.
 *
 * Grip (botão lateral) segura a cena inteira: soltando, ela fica onde você deixou.
 */
export class Interaction {
  constructor({ renderer, camera, scene, dom, grabTarget, orbitTarget }) {
    this.renderer = renderer;
    this.camera = camera;
    this.scene = scene;
    this.grabTarget = grabTarget;
    this.hitObjects = new Set();
    this.raycaster = new THREE.Raycaster();
    this.raycaster.camera = camera; // necessário para acertar Sprites (rótulos clicáveis)
    this.tempMatrix = new THREE.Matrix4();
    this.orbit = new DesktopOrbit(camera, dom, orbitTarget);
    this.mouse = { ndc: new THREE.Vector2(), inside: false, target: null, hit: null, down: null };
    this.controllers = [0, 1].map((i) => this.#setupController(i));
    this.dom = dom;

    dom.addEventListener('pointermove', (e) => {
      this.mouse.inside = true;
      this.mouse.ndc.set((e.clientX / dom.clientWidth) * 2 - 1, -(e.clientY / dom.clientHeight) * 2 + 1);
    });
    dom.addEventListener('pointerleave', () => {
      this.mouse.inside = false;
      this.#setHover(this.mouse, null);
    });
    dom.addEventListener('pointerdown', (e) => { this.mouse.down = { x: e.clientX, y: e.clientY }; });
    dom.addEventListener('pointerup', (e) => {
      const down = this.mouse.down;
      this.mouse.down = null;
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_TOLERANCE_PX) return;
      this.mouse.ndc.set((e.clientX / dom.clientWidth) * 2 - 1, -(e.clientY / dom.clientHeight) * 2 + 1);
      this.raycaster.setFromCamera(this.mouse.ndc, this.camera);
      const hit = this.#intersect();
      hit?.object.userData.interactive?.onPointerSelect?.(hit);
    });
  }

  register(object) {
    this.hitObjects.add(object);
  }

  unregister(object) {
    this.hitObjects.delete(object);
    for (const state of [this.mouse, ...this.controllers]) {
      if (state.hit?.object === object) this.#setHover(state, null);
    }
  }

  #setupController(index) {
    const controller = this.renderer.xr.getController(index);
    const ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: COLOR.holoLight, transparent: true, opacity: 0.8 }),
    );
    ray.scale.z = RAY_LENGTH;
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.006, 8, 6),
      new THREE.MeshBasicMaterial({ color: COLOR.amber }),
    );
    dot.visible = false;
    controller.add(ray, dot);
    controller.visible = false;
    this.scene.add(controller);

    const state = { controller, ray, dot, target: null, hit: null, grabbing: false };
    controller.addEventListener('connected', (event) => {
      controller.visible = event.data.targetRayMode !== 'gaze';
    });
    controller.addEventListener('disconnected', () => {
      controller.visible = false;
      this.#setHover(state, null);
      this.#release(state);
    });
    controller.addEventListener('select', () => {
      state.target?.onPointerSelect?.(state.hit);
    });
    controller.addEventListener('squeezestart', () => {
      if (this.controllers.some((c) => c.grabbing)) return;
      state.grabbing = true;
      controller.attach(this.grabTarget); // a cena passa a seguir o controle
    });
    controller.addEventListener('squeezeend', () => this.#release(state));
    return state;
  }

  #release(state) {
    if (!state.grabbing) return;
    state.grabbing = false;
    this.scene.attach(this.grabTarget); // solta mantendo a posição no mundo
  }

  #intersect() {
    const objects = [...this.hitObjects].filter(isShown);
    return this.raycaster.intersectObjects(objects, false)[0] ?? null;
  }

  #setHover(state, hit) {
    const target = hit?.object.userData.interactive ?? null;
    if (state.target && state.target !== target) state.target.onPointerLeave?.();
    state.target = target;
    state.hit = hit;
    return target ? Boolean(target.onPointerHover?.(hit)) : false;
  }

  update() {
    const presenting = this.renderer.xr.isPresenting;
    this.orbit.enabled = !presenting;
    this.orbit.update();

    if (presenting) {
      for (const state of this.controllers) {
        if (!state.controller.visible) continue;
        this.tempMatrix.identity().extractRotation(state.controller.matrixWorld);
        this.raycaster.ray.origin.setFromMatrixPosition(state.controller.matrixWorld);
        this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);
        const hit = state.grabbing ? null : this.#intersect();
        const active = this.#setHover(state, hit);
        state.ray.scale.z = hit ? hit.distance : RAY_LENGTH;
        state.ray.material.color.setHex(active ? COLOR.amber : COLOR.holoLight);
        state.dot.visible = Boolean(hit);
        if (hit) state.dot.position.set(0, 0, -hit.distance);
      }
    } else if (this.mouse.inside && !this.mouse.down) {
      this.raycaster.setFromCamera(this.mouse.ndc, this.camera);
      const active = this.#setHover(this.mouse, this.#intersect());
      this.dom.style.cursor = active ? 'pointer' : 'grab';
    }
  }
}
