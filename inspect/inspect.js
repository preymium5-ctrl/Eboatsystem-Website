// ESMI Inspect: the E-Boat as a real-time 3D model (exported from the Blender scene
// that renders the engineering frames). Drag to orbit, scroll/pinch or the +/− buttons
// to zoom, pick a camera view, and pull the boat apart with the slider (it scrubs the
// same assembly animation, backwards).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { setupInventory, widenZ } from './inspect-inventory.js';

const MODEL = './assets/inspect/esmi-eboat.glb';
const $ = s => document.querySelector(s);
const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
root.classList.add('ins-booted');
const canvas = $('.ins-canvas'), status = $('.ins-status'), statusText = $('.ins-status-text');
const explode = $('.ins-explode'), slider = $('.ins-explode input');

// Blender is Z-up with the camera side at -Y; glTF/three is Y-up: (x, y, z) → (x, z, -y).
const bl = (x, y, z) => new THREE.Vector3(x, z, -y);
const FLOOR = -1.07;

/* ------------------------------------------------------------ renderer ------ */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;              // same view transform family as the Blender renders
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.75;

const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 200);
const key = new THREE.DirectionalLight(0xfff8f0, 2.4);
key.position.copy(bl(6.5, -7, 7));
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
Object.assign(key.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 });
scene.add(key);
scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9a98, 0.55));
const rim = new THREE.DirectionalLight(0xeef3ff, 0.9);
rim.position.copy(bl(-7, 6, 5));
scene.add(rim);

// Soft contact shadow on an invisible studio floor.
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.22 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = FLOOR;
ground.receiveShadow = true;
scene.add(ground);

const controls = new OrbitControls(camera, canvas);
Object.assign(controls, {
  enableDamping: true, dampingFactor: 0.08, rotateSpeed: 0.7, zoomSpeed: 0.9, panSpeed: 0.8,
  screenSpacePanning: true, zoomToCursor: true,
  minDistance: 1.1, maxDistance: 26, maxPolarAngle: Math.PI * 0.49,
});

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < 760 ? 44 : 32;                     // phones: wider lens so the boat fits the narrow screen
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

/* ------------------------------------------------------------ views --------- */
const VIEWS = {
  bow:   { target: bl(2.3, -1.25, -0.35), position: bl(5.9, -4.3, 0.35) },
  helm:  { target: bl(1.45, 0.7, 0.8),    position: bl(3.8, -1.9, 1.95) },
  seats: { target: bl(-0.35, 0, 0.45),    position: bl(1.7, -3.5, 2.4) },
  solar: { target: bl(-0.3, 0, 2.3),      position: bl(2.7, -5.4, 6.6) },
  drive: { target: bl(-1.9, 0, -0.55),    position: bl(-5.8, -0.9, -0.15), explode: 0.45 },
};
let overview = null;
function fitOverview(object, margin = 0.92) {
  const box = new THREE.Box3();
  (Array.isArray(object) ? object : [object]).forEach(o => box.expandByObject(o));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const az = THREE.MathUtils.degToRad(-57), el = THREE.MathUtils.degToRad(18);
  const dir = bl(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)).normalize();
  const fov = THREE.MathUtils.degToRad(camera.fov), fitH = sphere.radius / Math.sin(fov / 2);
  const fitW = sphere.radius / Math.sin(Math.atan(Math.tan(fov / 2) * camera.aspect));
  const distance = Math.max(fitH, fitW) * margin;
  const target = sphere.center.clone().add(new THREE.Vector3(0, -sphere.radius * 0.06, 0));
  overview = { target, position: target.clone().addScaledVector(dir, distance) };
  controls.maxDistance = distance * 2.2;
  controls.minDistance = Math.min(1.1, distance * 0.3);
  VIEWS.overview = overview;
}

// Smooth camera moves (controls are paused while a move runs).
let flight = null;
function fly(to, duration = 1.15) {
  if (reduced.matches) duration = 0.01;
  flight = { from: { p: camera.position.clone(), t: controls.target.clone() }, to, start: performance.now(), duration: duration * 1000 };
  controls.enabled = false;
  if (typeof to.explode === 'number') setExplode(to.explode, true);
}
const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
function stepFlight(now) {
  if (!flight) return;
  const k = Math.min(1, (now - flight.start) / flight.duration), e = easeInOut(k);
  camera.position.lerpVectors(flight.from.p, flight.to.position, e);
  controls.target.lerpVectors(flight.from.t, flight.to.target, e);
  if (k >= 1) { flight = null; controls.enabled = true; }
}

document.querySelectorAll('.ins-view').forEach(button => button.addEventListener('click', () => {
  const view = VIEWS[button.dataset.view];
  if (!view) return;
  document.querySelectorAll('.ins-view').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  if (button.dataset.view !== 'drive' && explodeTarget > 0.001 && button.dataset.view !== 'overview') setExplode(0, true);
  fly(view);
}));
function zoomBy(factor) {
  const offset = camera.position.clone().sub(controls.target);
  const distance = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance);
  fly({ target: controls.target.clone(), position: controls.target.clone().add(offset.setLength(distance)) }, 0.5);
}
$('[data-zoom="in"]').addEventListener('click', () => zoomBy(0.72));
$('[data-zoom="out"]').addEventListener('click', () => zoomBy(1.38));
$('.ins-reset').addEventListener('click', () => {
  document.querySelectorAll('.ins-view').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === 'overview')));
  setExplode(0, true);
  if (overview) fly(overview);
});
controls.addEventListener('start', () => {
  flight = null;
  document.querySelectorAll('.ins-view').forEach(b => b.setAttribute('aria-pressed', 'false'));
});

/* ------------------------------------------------------------ explode ------- */
let mixer = null, tAssembled = 0, tExploded = 0, explodeNow = 0, explodeTarget = 0;
function setExplode(value, animate = false) {
  explodeTarget = THREE.MathUtils.clamp(value, 0, 1);
  if (!animate || reduced.matches) explodeNow = explodeTarget;
  slider.value = String(explodeTarget);
}
slider.addEventListener('input', () => { explodeTarget = explodeNow = Number(slider.value); });
function applyExplode() {
  if (!mixer) return;
  // Stop just short of the clip's end: reaching it finishes the LoopOnce action, which then
  // pauses and ignores every later setTime, freezing the boat on frame 1 (fully apart).
  mixer.setTime(Math.min(tAssembled - 1e-4, tAssembled - explodeNow * (tAssembled - tExploded)));
}

/* ------------------------------------------------------------ part previews -- */
// Render one inventory group on its own, assembled, from a three-quarter angle, and return
// it as an image. It borrows a corner of the main canvas for one draw, copies the pixels
// out in the same task (before the browser shows the frame) and then redraws the scene.
const thumbCamera = new THREE.PerspectiveCamera(28, 1, 0.05, 200);
const thumbView = bl(1, -1.25, 0.8).normalize();
function renderPartPreview(model, nodes, width = 96, height = 72) {
  const ratio = renderer.getPixelRatio();
  const out = document.createElement('canvas');
  out.width = Math.round(width * ratio); out.height = Math.round(height * ratio);
  const visible = model.children.map(n => n.visible);
  const shown = new Set(nodes);
  model.children.forEach(n => { n.visible = shown.has(n); });
  if (mixer) mixer.setTime(tAssembled - 1e-4);
  const box = new THREE.Box3();
  nodes.forEach(n => box.expandByObject(n));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  thumbCamera.aspect = width / height;
  const fit = Math.min(Math.sin(THREE.MathUtils.degToRad(thumbCamera.fov / 2)), Math.sin(Math.atan(Math.tan(THREE.MathUtils.degToRad(thumbCamera.fov / 2)) * thumbCamera.aspect)));
  thumbCamera.position.copy(sphere.center).addScaledVector(thumbView, sphere.radius / fit * 1.04);
  thumbCamera.near = Math.max(0.01, sphere.radius * 0.05); thumbCamera.far = sphere.radius * 20 + 10;
  thumbCamera.lookAt(sphere.center);
  thumbCamera.clearViewOffset();
  thumbCamera.updateProjectionMatrix();
  thumbCamera.updateMatrixWorld();
  // Tighten the framing to the part's projected outline (the sphere is loose for flat or
  // long parts): crop the view window around the box corners with a small margin.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const corner = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(thumbCamera);
    x0 = Math.min(x0, corner.x); x1 = Math.max(x1, corner.x); y0 = Math.min(y0, corner.y); y1 = Math.max(y1, corner.y);
  }
  const span = Math.min(1, Math.max((x1 - x0) / 2, (y1 - y0) / 2) / 0.8);
  const vw = width * span, vh = height * span;
  thumbCamera.setViewOffset(width, height, (width - vw) / 2 + (x0 + x1) / 4 * width, (height - vh) / 2 - (y0 + y1) / 4 * height, vw, vh);
  const groundVisible = ground.visible; ground.visible = false;
  const clear = renderer.getClearAlpha();
  renderer.setScissorTest(true);
  renderer.setViewport(0, 0, width, height); renderer.setScissor(0, 0, width, height);
  renderer.setClearAlpha(0); renderer.clear();
  renderer.render(scene, thumbCamera);
  const source = renderer.domElement;
  out.getContext('2d').drawImage(source, 0, source.height - out.height, out.width, out.height, 0, 0, out.width, out.height);
  // Put everything back and redraw the real view in the same task.
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.setClearAlpha(clear);
  ground.visible = groundVisible;
  model.children.forEach((n, i) => { n.visible = visible[i]; });
  applyExplode();
  renderer.render(scene, camera);
  return out.toDataURL('image/png');
}

/* ------------------------------------------------------------ customizer ---- */
// inspect.html?part=<id> (from the part cards on the homepage): show that part alone, framed
// on its own, with its colours in the panel. The inventory module handles which part is on
// show; this frames the camera and retitles the page.
const PART = new URLSearchParams(location.search).get('part');
let focusNodes = null;
if (PART) root.classList.add('ins-part-mode');
function focusPart(model, nodes, info, animate) {
  focusNodes = nodes;
  if (mixer) mixer.setTime(tAssembled - 1e-4);
  setExplode(0);
  model.updateMatrixWorld(true);
  fitOverview(nodes, 1.15);                       // a little looser: the part sits beside the panel
  applyExplode();
  $('.ins-eyebrow').textContent = `CUSTOMIZE · ${String(info.number).padStart(2, '0')} / ${info.total}`;
  $('#ins-title').innerHTML = `<span class="ins-serif">${info.name}.</span><span class="ins-sans">Made yours.</span>`;
  $('.ins-hint').textContent = `${info.note}. Drag to rotate, scroll or pinch to zoom.`;
  document.title = `Customize the ${info.name.toLowerCase()} | ESMI E-Boat`;
  if (animate || !flight) fly(overview, animate ? 1.1 : 1.6);
  else flight.to = overview;
}

/* ------------------------------------------------------------ boat width ---- */
// After the inventory switches between the standard and the wide (×2 beam) boat: refit the
// overview to the assembled boat and move the close-up views across with the parts.
const BASE_VIEWS = Object.fromEntries(Object.entries(VIEWS).map(([k, v]) => [k, { ...v, target: v.target.clone(), position: v.position.clone() }]));
function relayout(model, wide, animate) {
  if (mixer) mixer.setTime(tAssembled - 1e-4);
  model.updateMatrixWorld(true);
  fitOverview(focusNodes || model, focusNodes ? 1.15 : 0.92);
  applyExplode();
  for (const [k, base] of Object.entries(BASE_VIEWS)) {
    const dz = wide ? widenZ(base.target.z) - base.target.z : 0;
    VIEWS[k] = { ...base, target: base.target.clone().setZ(base.target.z + dz), position: base.position.clone().setZ(base.position.z + dz) };
  }
  if (!animate) { if (flight) flight.to = overview; return; }
  document.querySelectorAll('.ins-view').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === 'overview')));
  fly(overview, 1.1);
}

/* ------------------------------------------------------------ load ---------- */
const loader = new GLTFLoader();
loader.load(MODEL, gltf => {
  const model = gltf.scene;
  model.traverse(node => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach(m => { if (m.map) m.map.anisotropy = renderer.capabilities.getMaxAnisotropy(); });
  });
  scene.add(model);
  if (gltf.animations.length) {
    mixer = new THREE.AnimationMixer(model);
    let tMin = Infinity, tMax = 0;
    gltf.animations.forEach(clip => {
      clip.tracks.forEach(track => { tMin = Math.min(tMin, track.times[0]); tMax = Math.max(tMax, track.times[track.times.length - 1]); });
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
    });
    // Frame 1 of the assembly is fully apart, the last frame fully assembled.
    tExploded = Number.isFinite(tMin) ? tMin : 0;
    tAssembled = tMax;
    applyExplode();
    explode.hidden = false;
  }
  fitOverview(model);
  camera.position.copy(overview.position);
  controls.target.copy(overview.target);
  // Arrive with a short dolly-in.
  camera.position.addScaledVector(camera.position.clone().sub(controls.target).normalize(), 1.6);
  fly(overview, 1.6);
  setupInventory(model, {
    reduced: reduced.matches, clips: gltf.animations, Box3: THREE.Box3,
    preview: nodes => renderPartPreview(model, nodes),
    onLayout: (wide, animate) => relayout(model, wide, animate),
    part: PART,
    onFocus: (nodes, info, animate) => focusPart(model, nodes, info, animate),
  });
  status.classList.add('is-done');
  root.classList.add('ins-ready');
}, event => {
  if (event.total) statusText.textContent = `Loading the model ${Math.round(event.loaded / event.total * 100)}%`;
}, error => {
  console.warn('[inspect] model failed to load', error);
  showFallback('The 3D model could not load. Showing a still of the boat.');
});

function showFallback(message) {
  $('.ins-fallback').hidden = false;
  canvas.hidden = true;
  statusText.textContent = message;
  document.querySelectorAll('.ins-views, .ins-tools, .ins-inventory').forEach(el => { el.hidden = true; });
}

/* ------------------------------------------------------------ inventory room -- */
// While the inventory is open, slide (and on small screens shrink) the rendered view so the
// boat sits in the space beside it: left of the panel on desktop, above the sheet on phones.
const inventory = $('.ins-inventory');
const shift = { x: 0, y: 0, z: 1, tx: 0, ty: 0, tz: 1 };
function updateShiftTarget() {
  shift.tx = shift.ty = 0; shift.tz = 1;
  if (!inventory || inventory.hidden || inventory.dataset.open !== 'true') return;
  const r = inventory.getBoundingClientRect();
  if (innerWidth <= 760) {
    shift.tz = THREE.MathUtils.clamp((r.top - 70) / (innerHeight * .5), .5, 1);
    shift.ty = innerHeight / 2 - (70 + r.top) / 2;
  } else {
    shift.tz = THREE.MathUtils.clamp(r.left / innerWidth + .12, .82, 1);
    shift.tx = (innerWidth / 2 - r.left / 2) * .8;
  }
}
if (inventory) new MutationObserver(updateShiftTarget).observe(inventory, { attributes: true, attributeFilter: ['data-open', 'hidden'] });
addEventListener('resize', updateShiftTarget);
function applyShift(dt) {
  const k = reduced.matches ? 1 : 1 - Math.exp(-dt / 0.18);
  shift.x += (shift.tx - shift.x) * k; shift.y += (shift.ty - shift.y) * k; shift.z += (shift.tz - shift.z) * k;
  const resting = !shift.tx && !shift.ty && shift.tz === 1;
  if (resting && Math.abs(shift.x) < 0.5 && Math.abs(shift.y) < 0.5 && Math.abs(shift.z - 1) < 0.002) {
    if (camera.view?.enabled) camera.clearViewOffset();
    return;
  }
  // A view window larger than the full image (z < 1) zooms out; its offset, in full-image
  // pixels, moves the boat by shift.x / shift.y screen pixels.
  const w = innerWidth, h = innerHeight, vw = w / shift.z, vh = h / shift.z;
  camera.setViewOffset(w, h, (w - vw) / 2 + shift.x / shift.z, (h - vh) / 2 + shift.y / shift.z, vw, vh);
}

/* ------------------------------------------------------------ loop ---------- */
const clock = new THREE.Clock();
function frame(now) {
  const dt = Math.min(0.05, clock.getDelta());
  stepFlight(now);
  if (Math.abs(explodeTarget - explodeNow) > 1e-4) explodeNow += (explodeTarget - explodeNow) * (1 - Math.exp(-dt / 0.28));
  applyExplode();
  controls.update();
  applyShift(dt);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);
document.addEventListener('visibilitychange', () => renderer.setAnimationLoop(document.hidden ? null : frame));
