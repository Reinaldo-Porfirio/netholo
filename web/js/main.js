import * as THREE from './three.js';
import { AgentClient } from './client.js';
import { App } from './app.js';
import { Interaction } from './interaction.js';
import { LevelMenu } from './levels.js';
import { TerminalPanel } from './panel.js';
import { TextSprite } from './text.js';
import { COLOR, CSS } from './theme.js';
import { NetWorld } from './world.js';

const DESKTOP_BACKGROUND = new THREE.Color(0x07110f);
const DESKTOP_ROOT = new THREE.Vector3(0, 1.0, 0);
const PANEL_TOP = 0.36;

const $ = (id) => document.getElementById(id);

function showFatal(message) {
  const box = $('fatal');
  box.textContent = message;
  box.hidden = false;
}

/** O token vem na URL (?t=...). Guardamos na aba e tiramos da barra de endereço. */
function readToken() {
  const params = new URLSearchParams(location.search);
  let token = params.get('t');
  try {
    if (token) sessionStorage.setItem('netholo-token', token);
    else token = sessionStorage.getItem('netholo-token');
  } catch {
    // sessionStorage pode estar bloqueado (aba privada): segue só com a URL
  }
  if (params.has('t')) history.replaceState(null, '', location.pathname);
  return token;
}

function createRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  document.body.appendChild(renderer.domElement);
  return renderer;
}

/** Botão de entrar no modo imersivo: AR (passthrough) no Quest; VR se só existir VR. */
async function setupXrButton(renderer) {
  const button = $('enter-xr');
  if (!navigator.xr) return;
  const mode = (await navigator.xr.isSessionSupported('immersive-ar')) ? 'immersive-ar'
    : (await navigator.xr.isSessionSupported('immersive-vr')) ? 'immersive-vr' : null;
  if (!mode) return;
  button.dataset.label = mode === 'immersive-ar' ? 'Entrar em realidade mista' : 'Entrar em VR';
  button.textContent = button.dataset.label;
  button.hidden = false;
  button.addEventListener('click', async () => {
    if (renderer.xr.isPresenting) {
      await renderer.xr.getSession().end();
      return;
    }
    try {
      const session = await navigator.xr.requestSession(mode, {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hand-tracking'],
      });
      await renderer.xr.setSession(session);
    } catch (error) {
      showFatal(`Não foi possível abrir a sessão imersiva: ${error.message}`);
    }
  });
}

function main() {
  const token = readToken();
  let renderer;
  try {
    renderer = createRenderer();
  } catch {
    showFatal('Este navegador não conseguiu iniciar o WebGL.');
    return;
  }

  const scene = new THREE.Scene();
  scene.background = DESKTOP_BACKGROUND;
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 30);
  const grid = new THREE.GridHelper(4, 40, COLOR.holoDeep, 0x0f3a30);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

  const worldAnchor = new THREE.Group(); // é este grupo que o grip "segura"
  worldAnchor.position.copy(DESKTOP_ROOT);
  scene.add(worldAnchor);

  const interaction = new Interaction({
    renderer, camera, scene, dom: renderer.domElement, grabTarget: worldAnchor,
    orbitTarget: DESKTOP_ROOT.clone().add(new THREE.Vector3(0, 0.08, 0)),
  });
  const world = new NetWorld({ interaction });
  worldAnchor.add(world.root);

  const menu = new LevelMenu();
  const terminal = new TerminalPanel();
  menu.menu.position.set(-0.62, 0, 0.12);
  menu.menu.anchorTop = PANEL_TOP;
  menu.lesson.position.set(-0.62, 0, 0.12);
  terminal.position.set(0.68, 0, 0.1);
  terminal.anchorTop = PANEL_TOP;
  const panels = [menu.menu, menu.lesson, terminal];
  for (const panel of panels) {
    world.root.add(panel);
    interaction.register(panel);
  }

  const statusSprite = new TextSprite('conectando…', { height: 0.026, color: CSS.amber });
  statusSprite.position.set(0, 0.72, -0.18);
  world.root.add(statusSprite);

  if (!token) {
    showFatal('Abra a página pelo endereço que aparece no terminal do PC (ele termina com ?t=...).');
    return;
  }

  const client = new AgentClient(token);
  new App({ client, world, menu, terminal });

  const statusEl = $('status');
  const setStatus = (state) => {
    const demo = client.demo ? ' · demonstração' : '';
    const text = { online: `agente conectado${demo}`, connecting: 'conectando…', offline: 'sem conexão com o agente' }[state];
    statusEl.textContent = text;
    statusEl.dataset.state = state;
    statusSprite.setText(text, state === 'online' ? CSS.holoLight : state === 'offline' ? CSS.red : CSS.amber);
  };
  client.addEventListener('status', ({ detail }) => setStatus(detail));
  client.addEventListener('hello', () => setStatus('online'));
  client.connect();

  // Ao entrar no modo imersivo, a cena é colocada à sua frente, um pouco abaixo dos olhos.
  let needsPlacement = false;
  renderer.xr.addEventListener('sessionstart', () => {
    scene.background = null; // fundo transparente = passthrough (o quarto real)
    grid.visible = false;
    needsPlacement = true;
    $('hint').hidden = true;
    $('enter-xr').textContent = 'Sair';
  });
  renderer.xr.addEventListener('sessionend', () => {
    scene.background = DESKTOP_BACKGROUND;
    grid.visible = true;
    scene.attach(worldAnchor);
    worldAnchor.position.copy(DESKTOP_ROOT);
    worldAnchor.rotation.set(0, 0, 0);
    $('hint').hidden = false;
    $('enter-xr').textContent = $('enter-xr').dataset.label;
  });

  const head = new THREE.Vector3();
  const forward = new THREE.Vector3();
  function placeInFrontOfUser() {
    const xrCamera = renderer.xr.getCamera();
    head.setFromMatrixPosition(xrCamera.matrixWorld);
    if (head.y < 0.3) return; // a pose da cabeça ainda não chegou
    forward.set(0, 0, -1).applyQuaternion(xrCamera.quaternion).setY(0).normalize();
    worldAnchor.position.copy(head).addScaledVector(forward, 0.95);
    worldAnchor.position.y = head.y - 0.32;
    worldAnchor.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
    needsPlacement = false;
  }

  const clock = new THREE.Clock();
  const cameraPosition = new THREE.Vector3();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    if (renderer.xr.isPresenting) {
      if (needsPlacement) placeInFrontOfUser();
      cameraPosition.setFromMatrixPosition(renderer.xr.getCamera().matrixWorld);
    } else {
      cameraPosition.copy(camera.position);
    }
    interaction.update();
    world.update(dt, clock.elapsedTime, cameraPosition);
    menu.lesson.anchorTop = menu.menu.position.y - menu.menu.scale.y / 2 - 0.02;
    for (const panel of panels) panel.update(cameraPosition);
    renderer.render(scene, camera);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Fora de um contexto seguro (HTTPS ou localhost) o navegador nega o WebXR.
  setupXrButton(renderer).catch((error) => console.warn('WebXR indisponível:', error));
}

main();
