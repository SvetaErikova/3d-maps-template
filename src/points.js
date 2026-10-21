// Markers for the two point buttons.
// Replace null with { x, y, z } to pin a point. See POINTS.md.

import * as THREE from 'three';

export const POINT_IDS = [1, 2];

// Scene coordinates after the model is normalized: origin at the bounding-box
// center, longest side = 10, Y up. null = random surface point on first click.
export const POINT_POSITIONS = {
  1: { x: -3.098, y: -0.229, z: 1.047 },
  2: { x: 3.469, y: 0.162, z: -2.892 },
};

const POINT_COLORS = {
  1: '#2f7d72',
  2: '#c46a32',
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

export function resolvePointPosition(root, id, avoidPoint) {
  const configured = POINT_POSITIONS[id];
  if (isPosition(configured)) {
    return new THREE.Vector3(configured.x, configured.y, configured.z);
  }

  let point = sampleSurfacePoint(root);
  if (avoidPoint && point.distanceTo(avoidPoint) < 0.4) {
    point = sampleSurfacePoint(root);
  }
  return point;
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

export function createPointMarker(id, size) {
  const material = new THREE.SpriteMaterial({
    map: createMarkerTexture(id, POINT_COLORS[id]),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = `point-${id}`;
  sprite.scale.setScalar(size);
  sprite.renderOrder = 10;
  sprite.userData.baseScale = size;
  return sprite;
}
