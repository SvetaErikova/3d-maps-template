import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createPointMarker, formatPoint, pointZoom, resolvePointPosition } from './points.js';
import { createModelLoader } from './libs.js';
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
const buildingButtons = [...document.querySelectorAll('[data-building]')];
const PINS_PER_MODEL = 3;
const PIN_COLORS = ['#2f7d72', '#c46a32', '#3a6f9a'];
const PIN_COPY = [
	{
		title: 'Ресторан Tугай',
		description: 'Ресторан отеля Ак Барс Гольф Резорт отличается уютным средиземноморским интерьером.',
	},
	{
		title: 'Терраса',
		description: ' Здесь каждый найдет для себя совершенное блюдо, ради которого захочется возвращаться вновь.',
	},
	{
		title: 'Ресторан Tugay',
		description: 'Restaurant of Ak Bars Golf Resort is distinguished by a cozy Mediterranean interior.',
	},
];

const MODELS = [
	{ url: `${import.meta.env.BASE_URL}models/ak-bars-test.glb`, x: -10, z: 0, rotation: 0, size: 5 },
	{ url: `${import.meta.env.BASE_URL}models/millenium-panorama-compressed.glb`, x: 6, z: 3, rotation: -45, size: 10 },
];
const POINT_DESCRIPTION = MODELS.flatMap((_, modelIndex) => PIN_COPY.map((copy, pinIndex) => ({
	id: modelIndex * PINS_PER_MODEL + pinIndex + 1,
	title: `Здание ${modelIndex + 1} · ${copy.title}`,
	description: copy.description,
})));

const INITIAL_CAMERA = {
	position: { x: 1, y: 0.5, z: 1 },
	target: { x: 1, y: 0, z: 0 },
	distance: null,
};

function showError(message, error) {
	status.hidden = false;
	status.classList.add('error');
	statusText.textContent = message;
	if (error) console.error(error);
}

async function init() {
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
	controls.maxPolarAngle = Math.PI / 2 - 0.02;

	// Процедурное окружение для стекла/металла
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

	let radius = 1;
	let loaded = false;
	let floorY = 0;
	let markerSize = 0.35;
	let activePointId = 0;
	let activeBuilding = -1;
	let pickMode = false;
	let focusAnim = null;
	let modelRoot = null;
	const buildingModels = [];
	const combinedBounds = new THREE.Box3();

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

	function hasModel() {
		return modelRoot !== null && buildingModels.length > 0;
	}

	function constrainCamera() {
		if (!hasModel()) return;

		const gap = Math.max(radius * 0.025, 0.05);
		const safeRadius = radius + gap;
		if (camera.position.lengthSq() > safeRadius * safeRadius) return;

		collisionDirection.copy(camera.position).sub(controls.target);
		const cameraDistance = collisionDirection.length();
		if (cameraDistance < 1e-5) return;
		collisionDirection.multiplyScalar(1 / cameraDistance);

		const reach = Math.max(controls.target.length() + radius * 1.25, cameraDistance + radius);
		collisionOrigin.copy(controls.target).addScaledVector(collisionDirection, reach);
		collisionToward.copy(collisionDirection).negate();
		collisionRaycaster.far = reach;
		collisionRaycaster.set(collisionOrigin, collisionToward);
		const hits = collisionRaycaster.intersectObjects(buildingModels, true);
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
		const halfVerticalFov = THREE.MathUtils.degToRad(camera.fov / 2);
		const halfHorizontalFov = Math.atan(Math.tan(halfVerticalFov) * camera.aspect);
		const fitDistance = radius / Math.sin(Math.min(halfVerticalFov, halfHorizontalFov)) * 1.18;
		controls.maxDistance = Math.max(radius * 15, fitDistance * 2);
		applyFloorLimit();

		const target = new THREE.Vector3(INITIAL_CAMERA.target.x, INITIAL_CAMERA.target.y, INITIAL_CAMERA.target.z);
		const position = new THREE.Vector3(INITIAL_CAMERA.position.x, INITIAL_CAMERA.position.y, INITIAL_CAMERA.position.z);
		const offset = position.sub(target);
		if (offset.lengthSq() < 1e-8) offset.set(1, 0.65, 1);
		const distance = INITIAL_CAMERA.distance ?? fitDistance;
		offset.normalize().multiplyScalar(distance);
		const savedDistance = Math.max(distance, 0.001);
		controls.minDistance = Math.min(controls.minDistance, savedDistance);
		controls.maxDistance = Math.max(controls.maxDistance, savedDistance);
		return { target, position: target.clone().add(offset) };
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
		activeBuilding = -1;
		updatePointButtons();
		updateBuildingButtons();
		closePopup();
		const pose = homePose();
		if (immediate || reduceMotion) {
			flushControls();
			controls.target.copy(pose.target);
			camera.position.copy(pose.position);
			camera.lookAt(pose.target);
			controls.saveState();
			controls.reset();
			return;
		}
		const endSpherical = new THREE.Spherical().setFromVector3(pose.position.clone().sub(pose.target));
		endSpherical.phi = THREE.MathUtils.clamp(endSpherical.phi, controls.minPolarAngle, controls.maxPolarAngle);
		endSpherical.radius = THREE.MathUtils.clamp(endSpherical.radius, controls.minDistance, controls.maxDistance);
		endSpherical.makeSafe();
		startCameraAnimation(pose.target, endSpherical);
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

	function pointIdFor(modelIndex, pinIndex) {
		return modelIndex * PINS_PER_MODEL + pinIndex + 1;
	}

	function modelIndexForPoint(id) {
		return Math.floor((id - 1) / PINS_PER_MODEL);
	}

	function rememberPoint(id) {
		return pointPositions.get(id) ?? new THREE.Vector3();
	}

	function updatePointButtons() {
		for (const [id, button] of Object.entries(pointButtons)) {
			button.setAttribute('aria-pressed', String(Number(id) === activePointId));
		}
	}

	function updateBuildingButtons() {
		for (const button of buildingButtons) {
			button.setAttribute('aria-pressed', String(Number(button.dataset.building) === activeBuilding));
		}
	}

	function focusOn(position, viewDistance = radius * 1.15, outward = null) {
		const startOffset = camera.position.clone().sub(controls.target);
		const viewDir = new THREE.Vector3();
		if (outward && outward.lengthSq() > 1e-4) {
			viewDir.copy(outward).normalize();
		} else {
			const horizontal = new THREE.Vector3(position.x, 0, position.z);
			if (horizontal.lengthSq() < 0.05) {
				horizontal.set(startOffset.x, 0, startOffset.z);
				if (horizontal.lengthSq() < 1e-6) horizontal.set(1, 0, 1);
			}
			horizontal.normalize();
			viewDir.set(horizontal.x, 0.55, horizontal.z).normalize();
		}
		const distance = THREE.MathUtils.clamp(viewDistance, controls.minDistance, controls.maxDistance);
		const endSpherical = new THREE.Spherical().setFromVector3(viewDir.multiplyScalar(distance));
		endSpherical.phi = THREE.MathUtils.clamp(endSpherical.phi, controls.minPolarAngle, controls.maxPolarAngle);
		endSpherical.radius = THREE.MathUtils.clamp(endSpherical.radius, controls.minDistance, controls.maxDistance);
		endSpherical.makeSafe();
		startCameraAnimation(position.clone(), endSpherical);
	}

	function approachDirection(position, model, viewDistance) {
		const { center, radius: modelRadius } = modelSpan(model);
		const preferred = position.clone().sub(center);
		if (preferred.lengthSq() < 1e-8) preferred.set(1, 0.25, 1);
		preferred.normalize();

		const candidates = [preferred.clone()];
		const lifted = preferred.clone();
		lifted.y = Math.max(lifted.y, 0.28);
		lifted.normalize();
		candidates.push(lifted);
		for (let step = 0; step < 16; step += 1) {
			const theta = (step / 16) * Math.PI * 2;
			const cos = Math.cos(theta);
			const sin = Math.sin(theta);
			candidates.push(new THREE.Vector3(cos, 0.16, sin).normalize());
			candidates.push(new THREE.Vector3(cos, 0.42, sin).normalize());
		}

		const margin = Math.max(0.35, modelRadius * 0.15);
		const previousFar = raycaster.far;
		let bestClear = null;
		let bestClearScore = -Infinity;
		let bestBlocked = null;
		let bestBlockedDistance = -Infinity;

		for (const dir of candidates) {
			const origin = position.clone().addScaledVector(dir, viewDistance);
			if (origin.y < floorY + 0.05) continue;
			const toPoint = position.clone().sub(origin);
			const travel = toPoint.length();
			if (travel < 1e-4) continue;
			toPoint.multiplyScalar(1 / travel);
			raycaster.far = travel;
			raycaster.set(origin, toPoint);
			const hits = raycaster.intersectObject(model, true);
			const blocked = hits.find((hit) => hit.distance < travel - margin);
			if (!blocked) {
				const score = dir.dot(preferred);
				if (score > bestClearScore) {
					bestClearScore = score;
					bestClear = dir;
				}
				continue;
			}
			if (blocked.distance > bestBlockedDistance) {
				bestBlockedDistance = blocked.distance;
				bestBlocked = dir;
			}
		}

		raycaster.far = previousFar;
		return bestClear ?? bestBlocked ?? lifted;
	}

	function modelSpan(model) {
		const box = new THREE.Box3().setFromObject(model);
		return {
			center: box.getCenter(new THREE.Vector3()),
			radius: Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.5),
		};
	}

	function placePointMarkers() {
		buildingModels.forEach((model, modelIndex) => {
			for (let pinIndex = 0; pinIndex < PINS_PER_MODEL; pinIndex += 1) {
				const id = pointIdFor(modelIndex, pinIndex);
				const position = resolvePointPosition(model, id);
				pointPositions.set(id, position);
				const marker = createPointMarker(id, markerSize, PIN_COLORS[pinIndex], pinIndex + 1);
				marker.position.copy(position);
				scene.add(marker);
				markers.set(id, marker);
			}
		});
	}

	function focusBuilding(index) {
		const model = buildingModels[index];
		if (!model) return;
		const { center, radius: modelRadius } = modelSpan(model);
		activeBuilding = index;
		activePointId = 0;
		updatePointButtons();
		updateBuildingButtons();
		closePopup();
		focusOn(center, modelRadius * 2.6);
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
		if (!button) return;
		activeBuilding = modelIndexForPoint(id);
		showPoint(id);
		updateBuildingButtons();
		openPopup(Number(button.getAttribute('data-point_description_id')));
	}

	function markerAt(event) {
		if (!loaded || markers.size === 0) return 0;
		const rect = renderer.domElement.getBoundingClientRect();
		pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(pointer, camera);
		const hits = raycaster.intersectObjects([...markers.values()], false);
		const hit = hits.find((item) => item.object.material.opacity > 0.35);
		return hit?.object.userData.pointId || 0;
	}

	function showPoint(id) {
		if (!hasModel()) return;
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
		const model = buildingModels[modelIndexForPoint(id)];
		const span = model ? modelSpan(model) : null;
		const requested = (span ? span.radius * 1.7 : radius * 0.7) / pointZoom(id);
		controls.minDistance = Math.min(controls.minDistance, Math.max(requested, radius * 0.02));
		const viewDistance = THREE.MathUtils.clamp(requested, controls.minDistance, controls.maxDistance);
		const outward = model ? approachDirection(position, model, viewDistance) : null;
		focusOn(position, viewDistance, outward);
	}

	function modelIndexFromObject(object) {
		let current = object;
		while (current) {
			const index = buildingModels.indexOf(current);
			if (index !== -1) return index;
			current = current.parent;
		}
		return -1;
	}

	function modelAt(event) {
		if (!hasModel()) return -1;
		const rect = renderer.domElement.getBoundingClientRect();
		pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(pointer, camera);
		const hits = raycaster.intersectObjects(buildingModels, true);
		if (hits.length === 0) return -1;
		return modelIndexFromObject(hits[0].object);
	}

	function pickAt(event) {
		if (!hasModel()) return;
		const rect = renderer.domElement.getBoundingClientRect();
		pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(pointer, camera);
		const hits = raycaster.intersectObjects(buildingModels, true);
		if (hits.length === 0) {
			readout.hidden = false;
			readout.textContent = 'Мимо здания — кликните по модели';
			return;
		}

		const id = activePointId || 1;
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
	for (const [id, button] of Object.entries(pointButtons)) {
		button.addEventListener('click', () => selectPoint(Number(id)));
	}
	for (const button of buildingButtons) {
		button.addEventListener('click', () => focusBuilding(Number(button.dataset.building)));
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
	function hoveringModel(event) {
		return !pickMode && pointerStart.markerId === 0 && (markerAt(event) !== 0 || modelAt(event) >= 0);
	}

	renderer.domElement.addEventListener('pointermove', (event) => {
		renderer.domElement.classList.toggle('is-point-hover', hoveringModel(event) || pointerStart.markerId !== 0);
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
		renderer.domElement.classList.toggle('is-point-hover', hoveringModel(event));
		if (markerId && event.button === 0 && pointerStart.button === 0 && !moved) {
			selectPoint(markerId);
			return;
		}
		if (!moved && event.button === 0 && pointerStart.button === 0 && !pickMode && loaded) {
			const modelIndex = modelAt(event);
			if (modelIndex >= 0) focusBuilding(modelIndex);
		}
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
		const fadeNear = Math.max(radius * 0.4, controls.minDistance * 5);
		const fadeFar = Math.max(fadeNear + 0.5, radius * 1.8);
		for (const marker of markers.values()) {
			const distance = camera.position.distanceTo(marker.position);
			marker.material.opacity = THREE.MathUtils.smoothstep(distance, fadeNear, fadeFar);
		}
		renderer.render(scene, camera);
	});

	const { loader, dracoLoader } = createModelLoader();

	try {
		const planTexturePromise = new THREE.TextureLoader()
			.loadAsync(`${import.meta.env.BASE_URL}bg.png`)
			.catch((error) => {
				console.error(error);
				return null;
			});
		let loadedBytes = 0;
		let totalBytes = 0;
		const gltfs = await Promise.all(
			MODELS.map((entry) =>
				loader.loadAsync(entry.url, (event) => {
					if (event.lengthComputable) {
						loadedBytes = Math.max(loadedBytes, event.loaded);
						totalBytes = Math.max(totalBytes, event.total);
						if (totalBytes > 0) {
							statusText.textContent = `Loading building… ${Math.round((loadedBytes / totalBytes) * 100)}%`;
						}
					}
				})
			)
		);

		const modelBoxes = [];
		combinedBounds.makeEmpty();
		for (const gltf of gltfs) {
			gltf.scene.updateMatrixWorld(true);
			const box = new THREE.Box3().setFromObject(gltf.scene);
			modelBoxes.push(box);
			combinedBounds.union(box);
		}

		const size = combinedBounds.getSize(new THREE.Vector3());
		const largestDimension = Math.max(size.x, size.y, size.z);
		if (combinedBounds.isEmpty() || !Number.isFinite(largestDimension) || largestDimension <= 0) {
			throw new Error('The model has no valid visible bounds.');
		}

		const center = combinedBounds.getCenter(new THREE.Vector3());
		const scale = 10 / largestDimension;

		modelRoot = new THREE.Group();
		modelRoot.scale.setScalar(scale);
		modelRoot.position.copy(center).multiplyScalar(-scale);

		gltfs.forEach((gltf, i) => {
			const model = gltf.scene;
			const spot = MODELS[i];
			const box = modelBoxes[i];
			const modelCenter = box.getCenter(new THREE.Vector3());
			const modelSize = box.getSize(new THREE.Vector3());
			const longest = Math.max(modelSize.x, modelSize.y, modelSize.z);
			const currentSize = longest * scale;
			const targetSize = Number.isFinite(spot.size) && spot.size > 0 ? spot.size : currentSize;
			const modelScale = currentSize > 0 ? targetSize / currentSize : 1;
			const pivot = new THREE.Group();
			pivot.position.set(
				spot.x / scale + center.x,
				box.min.y * (1 - modelScale),
				spot.z / scale + center.z,
			);
			pivot.rotation.y = THREE.MathUtils.degToRad(spot.rotation ?? 0);
			pivot.scale.setScalar(modelScale);
			model.position.x -= modelCenter.x;
			model.position.z -= modelCenter.z;
			pivot.add(model);
			modelRoot.add(pivot);
			buildingModels.push(model);
		});

		scene.add(modelRoot);
		modelRoot.updateWorldMatrix(true, true);


		radius = size.length() * scale / 2;
		markerSize = THREE.MathUtils.clamp(radius * 0.09, 0.28, 0.85);
		camera.near = radius / 1000;
		camera.far = radius * 500;
		camera.updateProjectionMatrix();
		controls.minDistance = radius * 0.15;

		const groundY = (combinedBounds.min.y - center.y) * scale - 0.015;
		floorY = groundY + 0.02;

		const planTexture = await planTexturePromise;
		if (planTexture) {
			planTexture.colorSpace = THREE.SRGBColorSpace;
			planTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
			// Короткая сторона 20 единиц: модели нормализованы к 10.
			const planSize = 20;
			const planAspect = planTexture.image.width / planTexture.image.height;
			const planGeometry = new THREE.PlaneGeometry(planSize * planAspect, planSize);
			const planMaterial = new THREE.MeshBasicMaterial({
				map: planTexture,
				toneMapped: false,
			});
			const planMesh = new THREE.Mesh(planGeometry, planMaterial);
			planMesh.rotation.x = -Math.PI / 2;
			planMesh.position.y = groundY;
			scene.add(planMesh);
		}

		loaded = true;
		resetView(true);
		placePointMarkers();
		resetButton.disabled = false;
		for (const button of Object.values(pointButtons)) button.disabled = false;
		for (const button of buildingButtons) button.disabled = false;
		status.hidden = true;
		dracoLoader.dispose();
	} catch (error) {
		dracoLoader?.dispose();
		showError('Could not load the building. Check public/models/, then reload the page.', error);
	}
}

init().catch((error) => {
	showError('Could not start the 3D viewer. Use a browser with WebGL 2 and hardware acceleration enabled.', error);
});