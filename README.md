# Ak Bars — Three.js building viewer

A small vanilla JavaScript + Vite project. The supplied building is included at
`public/models/ak-bars-test.glb`. No API keys, CDN assets, or backend are needed.

## Requirements

- Node.js 22.12+ (Node.js 24 LTS recommended), including npm: https://nodejs.org/
- A modern browser with WebGL 2 and hardware acceleration enabled.
- Internet access for the initial npm dependency installation.

## Run locally

Extract `ak-bars-viewer.zip`, open a terminal in its parent folder, then run:

```sh
cd ak-bars-viewer
npm ci
npm run dev
```

Open the Local URL printed in the terminal, normally http://127.0.0.1:5173/.
Keep the terminal running. Press Ctrl+C to stop it.

The same npm commands work in Windows PowerShell, macOS Terminal, and Linux.
Do not open `index.html` directly with a `file://` URL; use the local server.

## Controls

| Action | Mouse / keyboard | Touch |
| --- | --- | --- |
| Rotate | Left mouse drag | One-finger drag |
| Zoom | Mouse wheel or middle mouse drag | Pinch |
| Pan | Right mouse drag, Ctrl + left drag, or arrow keys after clicking the viewer | Two-finger drag |
| Reset camera | Reset view button or R | Reset view button |

The camera stays upright and above ground. The initial camera automatically fits
the model and screen aspect ratio. Reset view refits it to the current viewport.
The original model materials are preserved, including glass transmission.

## Build and preview production files

Stop the dev server first if desired, then run:

```sh
npm run build
npm run preview
```

Open the printed URL, normally http://127.0.0.1:4173/.
`dist/` contains the complete static production website, including the model.
Serve that directory with any static web server; no Node.js server is required
for the deployed website. The preview command is for local verification.

## Files

```text
ak-bars-viewer/
  index.html
  package.json
  package-lock.json
  vite.config.js
  .gitignore
  README.md
  POINTS.md
  src/
    main.js
    points.js
    style.css
  public/
    models/
      ak-bars-test.glb
```

## Customization

- Model: replace `public/models/ak-bars-test.glb`, keeping the same filename.
  The loader supports standard GLB files; compressed replacements may need
  additional Draco, Meshopt, or KTX2 decoders.
- Title: edit `index.html`.
- Page appearance: edit `src/style.css`.
- Background, lighting, camera limits: edit `src/main.js`.
- Default camera angle: edit `new THREE.Vector3(1, 0.65, 1)` in `resetView()`.
- Point buttons: edit `src/points.js`. `POINTS.md` explains how to replace the random points with exact coordinates.

Dependencies are pinned in `package.json` and `package-lock.json` for repeatable
installation. `node_modules/` and generated build files are excluded from the ZIP.

## References

- https://threejs.org/docs/pages/OrbitControls.html
- https://threejs.org/docs/pages/GLTFLoader.html
- https://vite.dev/guide/
