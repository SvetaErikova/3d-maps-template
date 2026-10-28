// Markers for the point buttons.
// Replace null with { x, y, z } to pin a point. See POINTS.md.

import * as THREE from 'three';

export const POINT_POSITIONS = {
  1: { x: -11.731, y: -0.032, z: -2.335 },
  2: { x: -9.783, y: -0.617, z: -0.009 },
  3: { x: -11.504, y: -0.375, z: 2.375 },
  // Здание 2. zoom — во сколько раз ближе камера. 2 = в два раза ближе.
  4: { x: 5.3, y: -1.6, z: -1.5, zoom: 6 },
  5: { x: 6.335, y: -0.620, z: 2.910, zoom: 0},
  6: { x: 3.963, y: -0.599, z: 3.198 , zoom: 4},
};

const POINT_COLORS = {
  1: '#2f7d72',
  2: '#c46a32',
  3: '#3a6f9a',
};
function isPosition(value) {
  return !!value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.z);
}

function collectMeshes(root) {
  const meshes = [];
  root.traverse((child) => {
    if (!child.isMesh || !child.visible) return;
    const position = child.geometry?.getAttribute('position');
    if (!position || position.count < 3) return;
    const index = child.geometry.getIndex();
    const triangles = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    if (triangles > 0) meshes.push({ mesh: child, triangles });
  });
  return meshes;
}

function sampleSurfacePoint(root) {
  root.updateWorldMatrix(true, true);
  const meshes = collectMeshes(root);
  if (meshes.length === 0) return new THREE.Vector3();

  const total = meshes.reduce((sum, item) => sum + item.triangles, 0);
  let pick = Math.floor(Math.random() * total);
  let chosen = meshes[0];
  for (const item of meshes) {
    if (pick < item.triangles) {
      chosen = item;
      break;
    }
    pick -= item.triangles;
  }

  const geometry = chosen.mesh.geometry;
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  const base = pick * 3;
  const i0 = index ? index.getX(base) : base;
  const i1 = index ? index.getX(base + 1) : base + 1;
  const i2 = index ? index.getX(base + 2) : base + 2;
  const a = new THREE.Vector3().fromBufferAttribute(position, i0);
  const b = new THREE.Vector3().fromBufferAttribute(position, i1);
  const c = new THREE.Vector3().fromBufferAttribute(position, i2);
  let u = Math.random();
  let v = Math.random();
  if (u + v > 1) {
    u = 1 - u;
    v = 1 - v;
  }

  const point = a.multiplyScalar(1 - u - v).addScaledVector(b, u).addScaledVector(c, v);
  chosen.mesh.localToWorld(point);
  return point;
}

export function formatPoint(position) {
  const axis = (value) => value.toFixed(3);
  return `{ x: ${axis(position.x)}, y: ${axis(position.y)}, z: ${axis(position.z)} }`;
}

export function pointZoom(id) {
  const zoom = POINT_POSITIONS[id]?.zoom;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

export function resolvePointPosition(root, id) {
  const configured = POINT_POSITIONS[id];
  if (isPosition(configured)) {
    return new THREE.Vector3(configured.x, configured.y, configured.z);
  }

  return sampleSurfacePoint(root);
}

function createMarkerTexture(id, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  context.beginPath();
  context.arc(64, 64, 46, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
  context.lineWidth = 10;
  context.strokeStyle = '#ffffff';
  context.stroke();
  context.fillStyle = '#ffffff';
  context.font = '700 58px Inter, system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(String(id), 64, 66);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createPointMarker(id, size, color, label = id) {
  const material = new THREE.SpriteMaterial({
    map: createMarkerTexture(label, color || POINT_COLORS[id] || '#2f7d72'),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = `point-${id}`;
  sprite.scale.setScalar(size);
  sprite.renderOrder = 10;
  sprite.userData.pointId = id;
  sprite.userData.baseScale = size;
  return sprite;
}
