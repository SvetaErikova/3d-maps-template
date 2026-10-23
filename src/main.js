import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { POINT_IDS, createPointMarker, formatPoint, resolvePointPosition } from './points.js';
import './style.css';

const container = document.querySelector('#viewer');
const status = document.querySelector('#status');
const statusText = document.querySelector('#status-text');
const resetButton = document.querySelector('#reset');
const readout = document.querySelector('#point-readout');
const popup = document.querySelector('.popup');
const popupTitle = popup.querySelector('.popup--content_title');
const popupDescription = popup.querySelector('.popup--content_description');
const popupClose = popup.querySelector('.popup--close');
const pointButtons = Object.fromEntries(
  [...document.querySelectorAll('[data-point]')].map((button) => [Number(button.dataset.point), button]),
);
const POINT_DESCRIPTION = [
  {
    id: 1,
    title: 'Ресторан Tугай',
    description: 'Ресторан отеля Ак Барс Гольф Резорт отличается уютным средиземноморским интерьером.',
  },
  {
    id: 2,
    title: 'Терраса',
    description: ' Здесь каждый найдет для себя совершенное блюдо, ради которого захочется возвращаться вновь.',
  },
  {
    id: 3,
    title: 'Ресторан Tugay',
    description: 'Restaurant of Ak Bars Golf Resort is distinguished by a cozy Mediterranean interior.',
  },
];

function showError(message, error) {
  status.hidden = false;
  status.classList.add('error');
  statusText.textContent = message;
  if (error) console.error(error);
}

async function init() {
  // The model lives in public/ and is copied unchanged into the production build.
  const modelUrl = `${import.meta.env.BASE_URL}models/ak-bars-test.glb`;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', 'Building model. Drag to rotate, scroll to zoom. Press R to reset.');
  renderer.domElement.setAttribute('aria-describedby', 'instructions');
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#eef0f2');
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !reduceMotion;
  controls.dampingFactor = 0.075;
  controls.enableRotate = true;
  controls.enableZoom = true;
  controls.enablePan = false;
  controls.zoomToCursor = false;
  controls.mouseButtons.RIGHT = -1;
  // Stay above the ground grid. The user cannot pan this center; only point focus moves it.
  controls.maxPolarAngle = Math.PI / 2 - 0.02;

  // A bundled procedural environment lights glass and metal without an HDR download.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  room.dispose();
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x78878f, 2));
  const sunlight = new THREE.DirectionalLight(0xfff4e4, 3);
  sunlight.position.set(8, 15, 10);
  scene.add(sunlight);

  const orbitCenter = new THREE.Vector3(0, 0, 0);
  let radius = 1;
  let loaded = false;
  let floorY = 0;
  let centeredModel = null;
  let markerSize = 0.35;
  let activePointId = 0;
  let pickMode = false;
  let focusAnim = null;
  const markers = new Map();
  const pointPositions = new Map();
  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const pointerStart = { x: 0, y: 0, picking: false, button: 0, markerId: 0 };
  const focusOffset = new THREE.Vector3();
  const collisionRaycaster = new THREE.Raycaster();
  const collisionDirection = new THREE.Vector3();
  const collisionOrigin = new THREE.Vector3();
  const collisionToward = new THREE.Vector3();

  function constrainCamera() {
    if (!centeredModel) return;

    // Outside the bounding sphere the camera cannot be inside the mesh.
    const gap = Math.max(radius * 0.025, 0.05);
    const safeRadius = radius + gap;
    if (camera.position.lengthSq() > safeRadius * safeRadius) return;

    collisionDirection.copy(camera.position).sub(controls.target);
    const cameraDistance = collisionDirection.length();
    if (cameraDistance < 1e-5) return;
    collisionDirection.multiplyScalar(1 / cameraDistance);

    // Shoot inward from outside the building. The first hit is the shell along this view.
    const reach = Math.max(controls.target.length() + radius * 1.25, cameraDistance + radius);
    collisionOrigin.copy(controls.target).addScaledVector(collisionDirection, reach);
    collisionToward.copy(collisionDirection).negate();
    collisionRaycaster.far = reach;
    collisionRaycaster.set(collisionOrigin, collisionToward);
    const hits = collisionRaycaster.intersectObject(centeredModel, true);
    if (hits.length === 0) return;

    const surfaceDistance = reach - hits[0].distance;
    if (surfaceDistance <= 0) return;
    const limit = surfaceDistance + gap;
    if (cameraDistance >= limit) return;

    camera.position.copy(controls.target).addScaledVector(collisionDirection, limit);
  }

  function keepCameraAboveGrid() {
    if (camera.position.y >= floorY) return;

    const offset = focusOffset.copy(camera.position).sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    const cosLimit = THREE.MathUtils.clamp(
      (floorY - controls.target.y) / Math.max(spherical.radius, 1e-4),
      -1,
      1,
    );
    spherical.phi = Math.min(spherical.phi, Math.acos(cosLimit), controls.maxPolarAngle);
    camera.position.copy(controls.target).add(offset.setFromSpherical(spherical));
    camera.lookAt(controls.target);
  }

  function applyFloorLimit() {
    const nearest = Math.max(controls.minDistance, 0.001);
    const farthest = Math.max(controls.maxDistance, nearest);
    const phiForDistance = (distance) => Math.acos(THREE.MathUtils.clamp(floorY / distance, -1, 1));
    controls.maxPolarAngle = Math.min(Math.PI / 2 - 0.02, phiForDistance(nearest), phiForDistance(farthest));
  }

  function flushControls() {
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = damping;
  }

  function homePose() {
    // A bounding sphere fits any model orientation, including narrow mobile screens.
    const halfVerticalFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const halfHorizontalFov = Math.atan(Math.tan(halfVerticalFov) * camera.aspect);
    const distance = radius / Math.sin(Math.min(halfVerticalFov, halfHorizontalFov)) * 1.18;
    controls.maxDistance = Math.max(radius * 15, distance * 2);
    applyFloorLimit();
    return {
      target: orbitCenter.clone(),
      position: new THREE.Vector3(1, 0.65, 1).normalize().multiplyScalar(distance),
    };
  }

  function startCameraAnimation(endTarget, endSpherical) {
    flushControls();
    const startOffset = focusOffset.copy(camera.position).sub(controls.target);
    const startSpherical = new THREE.Spherical().setFromVector3(startOffset);
    if (startSpherical.radius < 1e-4) startSpherical.set(1, 1, 1);

    const deltaTheta = Math.atan2(
      Math.sin(endSpherical.theta - startSpherical.theta),
      Math.cos(endSpherical.theta - startSpherical.theta),
    );
    if (reduceMotion) {
      controls.target.copy(endTarget);
      camera.position.copy(endTarget).add(focusOffset.setFromSpherical(endSpherical));
      return;
    }
    focusAnim = {
      start: performance.now(),
      duration: 650 + (Math.abs(deltaTheta) / Math.PI) * 550,
      startTarget: controls.target.clone(),
      endTarget,
      startTheta: startSpherical.theta,
      startPhi: startSpherical.phi,
      startRadius: startSpherical.radius,
      endPhi: endSpherical.phi,
      endRadius: endSpherical.radius,
      deltaTheta,
    };
  }

  function resetView(immediate = false) {
    if (!loaded) return;
    focusAnim = null;
    activePointId = 0;
    updatePointButtons();
    closePopup();
    const { position } = homePose();
    if (immediate || reduceMotion) {
      flushControls();
      controls.target.copy(orbitCenter);
      camera.position.copy(position);
      camera.lookAt(orbitCenter);
      controls.saveState();
      controls.reset();
      return;
    }
    const endSpherical = new THREE.Spherical().setFromVector3(position);
    endSpherical.phi = THREE.MathUtils.clamp(endSpherical.phi, controls.minPolarAngle, controls.maxPolarAngle);
    endSpherical.radius = THREE.MathUtils.clamp(endSpherical.radius, controls.minDistance, controls.maxDistance);
    endSpherical.makeSafe();
    startCameraAnimation(orbitCenter.clone(), endSpherical);
  }

  function resize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  function setPickMode(enabled) {
    pickMode = enabled;
    controls.enableRotate = !enabled;
    document.body.classList.toggle('is-picking', enabled);
    if (enabled) renderer.domElement.classList.remove('is-point-hover');
    if (!enabled) return;
    readout.hidden = false;
    readout.textContent = 'Кликните по зданию — координата скопируется';
  }

  function showReadout(id, position) {
    readout.hidden = false;
    readout.textContent = `${id}: ${formatPoint(position)},`;
  }

  function rememberPoint(id) {
    const cached = pointPositions.get(id);
    if (cached) return cached;

    const otherId = POINT_IDS.find((pointId) => pointId !== id);
    const position = resolvePointPosition(centeredModel, id, pointPositions.get(otherId));
    pointPositions.set(id, position);
    console.info(`${id}: ${formatPoint(position)},`);
    return position;
  }

  function updatePointButtons() {
    for (const id of POINT_IDS) {
      pointButtons[id].setAttribute('aria-pressed', String(id === activePointId));
    }
  }

  function focusOn(position) {
    const startOffset = camera.position.clone().sub(controls.target);
    // Side of the building: horizontal direction from the model center through the point.
    // The camera swings around to that side instead of staying on the current facade.
    const horizontal = new THREE.Vector3(position.x, 0, position.z);
    if (horizontal.lengthSq() < 0.05) {
      horizontal.set(startOffset.x, 0, startOffset.z);
      if (horizontal.lengthSq() < 1e-6) horizontal.set(1, 0, 1);
    }
    horizontal.normalize();
    const viewDir = new THREE.Vector3(horizontal.x, 0.55, horizontal.z).normalize();
    const distance = THREE.MathUtils.clamp(radius * 1.15, controls.minDistance, controls.maxDistance);
    const endSpherical = new THREE.Spherical().setFromVector3(viewDir.multiplyScalar(distance));
    endSpherical.phi = THREE.MathUtils.clamp(endSpherical.phi, controls.minPolarAngle, controls.maxPolarAngle);
    endSpherical.radius = THREE.MathUtils.clamp(endSpherical.radius, controls.minDistance, controls.maxDistance);
    endSpherical.makeSafe();
    startCameraAnimation(position.clone(), endSpherical);
  }

  function placePointMarkers() {
    for (const id of POINT_IDS) {
      const position = rememberPoint(id);
      const marker = createPointMarker(id, markerSize);
      marker.position.copy(position);
      scene.add(marker);
      markers.set(id, marker);
    }
  }
  function openPopup(id) {
    const item = POINT_DESCRIPTION.find((entry) => entry.id === id);
    if (!item) return;
    popupTitle.textContent = item.title;
    popupDescription.textContent = item.description;
    popup.classList.add('is-open');
    popup.setAttribute('aria-hidden', 'false');
  }

  function closePopup() {
    popup.classList.remove('is-open');
    popup.setAttribute('aria-hidden', 'true');
  }

  function selectPoint(id) {
    const button = pointButtons[id];
    showPoint(id);
    openPopup(Number(button.getAttribute('data-point_description_id')));
  }

  function markerAt(event) {
    if (!loaded || markers.size === 0) return 0;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...markers.values()], false);
    return hits[0]?.object.userData.pointId || 0;
  }

  function showPoint(id) {
    if (!loaded || !centeredModel) return;
    const position = rememberPoint(id);
    let marker = markers.get(id);
    if (!marker) {
      marker = createPointMarker(id, markerSize);
      marker.position.copy(position);
      scene.add(marker);
      markers.set(id, marker);
    }
    activePointId = id;
    updatePointButtons();
    showReadout(id, position);
    focusOn(position);
  }

  function pickAt(event) {
    if (!centeredModel) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(centeredModel, true);
    if (hits.length === 0) {
      readout.hidden = false;
      readout.textContent = 'Мимо здания — кликните по модели';
      return;
    }

    const id = activePointId || POINT_IDS[0];
    const line = `${id}: ${formatPoint(hits[0].point)},`;
    console.info(line);
    readout.hidden = false;
    readout.textContent = line;
    setPickMode(false);
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    clipboard.writeText(line).then(() => {
      readout.textContent = `${line} скопировано`;
    }).catch(() => {});
  }

  resetButton.addEventListener('click', () => resetView());
  popupClose.addEventListener('click', () => resetView());
  for (const id of POINT_IDS) {
    pointButtons[id].addEventListener('click', () => selectPoint(id));
  }
  controls.addEventListener('start', () => {
    focusAnim = null;
  });
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'KeyR') resetView();
    if (event.code === 'KeyP' && !event.repeat) {
      if (!loaded) return;
      setPickMode(!pickMode);
    }
    if (event.key === 'Escape' && pickMode) {
      event.preventDefault();
      setPickMode(false);
    }
  });
  renderer.domElement.addEventListener('pointerdown', (event) => {
    renderer.domElement.focus();
    pointerStart.x = event.clientX;
    pointerStart.y = event.clientY;
    pointerStart.button = event.button;
    pointerStart.picking = pickMode;
    pointerStart.markerId = 0;
    if (pickMode || event.button !== 0 || !loaded) return;
    const id = markerAt(event);
    if (!id) return;
    pointerStart.markerId = id;
    renderer.domElement.setPointerCapture(event.pointerId);
    event.stopPropagation();
  }, true);
  renderer.domElement.addEventListener('pointermove', (event) => {
    const hovering = !pickMode && pointerStart.markerId === 0 && markerAt(event) !== 0;
    renderer.domElement.classList.toggle('is-point-hover', hovering || pointerStart.markerId !== 0);
  });
  renderer.domElement.addEventListener('pointerup', (event) => {
    const dx = event.clientX - pointerStart.x;
    const dy = event.clientY - pointerStart.y;
    const moved = dx * dx + dy * dy > 36;
    if (pointerStart.picking && pickMode && event.button === 0 && pointerStart.button === 0) {
      if (!moved) pickAt(event);
      return;
    }
    const markerId = pointerStart.markerId;
    pointerStart.markerId = 0;
    renderer.domElement.classList.toggle('is-point-hover', !pickMode && markerAt(event) !== 0);
    if (!markerId || event.button !== 0 || pointerStart.button !== 0 || moved) return;
    selectPoint(markerId);
  });
  renderer.domElement.addEventListener('pointercancel', () => {
    pointerStart.markerId = 0;
    pointerStart.picking = false;
    renderer.domElement.classList.remove('is-point-hover');
  });
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    renderer.setAnimationLoop(null);
    showError('The graphics context was lost. Reload the page to continue.');
  });
  renderer.setAnimationLoop(() => {
    if (focusAnim) {
      const elapsed = performance.now() - focusAnim.start;
      const t = Math.min(1, elapsed / focusAnim.duration);
      const k = 1 - Math.pow(1 - t, 3);
      const theta = focusAnim.startTheta + focusAnim.deltaTheta * k;
      const phi = THREE.MathUtils.clamp(
        THREE.MathUtils.lerp(focusAnim.startPhi, focusAnim.endPhi, k),
        controls.minPolarAngle,
        controls.maxPolarAngle,
      );
      const dist = THREE.MathUtils.lerp(focusAnim.startRadius, focusAnim.endRadius, k);
      controls.target.lerpVectors(focusAnim.startTarget, focusAnim.endTarget, k);
      camera.position.copy(controls.target).add(focusOffset.setFromSphericalCoords(dist, phi, theta));
      if (t === 1) focusAnim = null;
    }
    const now = performance.now();
    for (const [id, marker] of markers) {
      const active = id === activePointId;
      const pulse = active && !reduceMotion ? 1 + Math.sin(now / 260) * 0.05 : 1;
      marker.scale.setScalar(marker.userData.baseScale * (active ? 1.18 : 0.92) * pulse);
    }
    controls.update();
    constrainCamera();
    keepCameraAboveGrid();
    renderer.render(scene, camera);
  });

  try {
    const gltf = await new GLTFLoader().loadAsync(modelUrl, (event) => {
      if (event.lengthComputable) statusText.textContent = `Loading building… ${Math.round(event.loaded / event.total * 100)}%`;
    });
    const model = gltf.scene;
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const largestDimension = Math.max(size.x, size.y, size.z);
    if (bounds.isEmpty() || !Number.isFinite(largestDimension) || largestDimension <= 0) {
      throw new Error('The model has no valid visible bounds.');
    }

    // Normalize to a 10-unit scene without changing the uploaded file or materials.
    const center = bounds.getCenter(new THREE.Vector3());
    const scale = 10 / largestDimension;
    centeredModel = new THREE.Group();
    centeredModel.add(model);
    centeredModel.scale.setScalar(scale);
    centeredModel.position.copy(center).multiplyScalar(-scale);
    scene.add(centeredModel);
    centeredModel.updateWorldMatrix(true, true);
    radius = size.length() * scale / 2;
    markerSize = THREE.MathUtils.clamp(radius * 0.09, 0.28, 0.85);
    camera.near = radius / 1000;
    camera.far = radius * 500;
    camera.updateProjectionMatrix();
    controls.minDistance = radius * 0.15;

    const groundY = (bounds.min.y - center.y) * scale - 0.015;
    floorY = groundY + 0.02;
    const grid = new THREE.GridHelper(50, 50, 0xcbd2d6, 0xdce1e4);
    grid.position.y = groundY;
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    scene.add(grid);

    loaded = true;
    resetView(true);
    placePointMarkers();
    resetButton.disabled = false;
    for (const id of POINT_IDS) pointButtons[id].disabled = false;
    status.hidden = true;
  } catch (error) {
    showError('Could not load the building. Check public/models/ak-bars-test.glb, then reload the page.', error);
  }
}

init().catch((error) => {
  showError('Could not start the 3D viewer. Use a browser with WebGL 2 and hardware acceleration enabled.', error);
});