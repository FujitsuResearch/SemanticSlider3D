# Semantic Slider 3D — Playground UI

A React-based frontend for the Semantic Slider 3D playground. It talks to two
backends: a **SAM3D** Flask server (image upload, SAM2 segmentation, TRELLIS
image-to-3D, session persistence) on port **5001**, and a **Trellis** server
(text-to-3D generation, semantic slider building, anchor variants) on port
**5002** over both REST and Socket.IO.

## Setup

### Backends

1. Activate the appropriate conda environment that has torch installed:
  ```bash
   conda activate <your-env>   # e.g. sam3d or trellis
  ```
2. Install `flask-cors` (required for the React dev server):
  ```bash
   pip install flask-cors
  ```
3. Run the SAM3D Flask backend (port 5001) and the Trellis backend (port 5002).

### Frontend (React)

1. Install dependencies:
  ```bash
   cd /path/to/SemanticSlider3D/playground_ui
   npm install
  ```
2. Start the development server:
  ```bash
   npm start
  ```
   The React app starts on port 3000 and proxies API requests to the backends
   (see `src/setupProxy.js`).

## Production Build

```bash
npm run build
```

The build output lands in `build/` and can be served by Flask or any static
file server.

## Architecture

- **Frontend**: React 18 + Three.js (`three`, `@react-three/fiber`) for 3D
rendering. 3D scene logic is isolated in a vanilla JS class
(`Viewer3DCore`) to keep Three.js state out of React.
- **SAM3D backend** (port 5001): image upload, SAM2 segmentation, TRELLIS
image-to-3D, session start/resume, behavior logging, combine/delete objects.
- **Trellis backend** (port 5002): text-to-3D, slider creation, anchor-point
variant generation, multi-view rendering, anchor rotation persistence.
Uses both REST and Socket.IO (for long-running progress streaming).
- **API proxy**: the React dev server proxies the paths listed in
`src/setupProxy.js` — `/trellis/`* and `/socket.io/*` go to port 5002;
everything else (`/upload`, `/segment`, `/to_3d`, `/start_session`,
`/log_behavior`, etc.) goes to port 5001.

## Features

- Image upload and SAM2 interactive segmentation (left-click positive,
right-click negative).
- Gallery of segmented objects with combine / delete / visibility toggle.
- Image-to-3D generation with TRELLIS.
- Text-to-3D generation with TRELLIS.
- 3D scene editing with translate / rotate / scale gizmos.
- **Semantic sliders**: per-object attribute sliders that smoothly swap in
GLB variants generated along a learned semantic direction, with
anchor-point snapping, per-anchor Y-rotation, variant forking, and
concurrent slider-build jobs.
- Per-object brightness, scene lighting, and background controls.
- Session persistence and resume, including slider positions and transforms.
- Behavior logging to the backend for every user action.

## Project Structure

```
playground_ui/
├── public/
│   └── index.html              # HTML shell (mounts React at #root)
├── build/                      # Production build output (generated)
├── docs/                       # Screenshots and walkthroughs
├── src/
│   ├── components/
│   │   ├── Header.js               # Top toolbar + scene settings dropdown + help modal
│   │   ├── ImagePanel.js           # Floating image panel with SAM2 point markers
│   │   ├── Sidebar.js              # Right sidebar gallery of segmented / generated objects
│   │   ├── TransformPanel.js       # Translate / rotate / scale inputs and gizmo mode buttons
│   │   ├── ContextMenu.js          # Right-click menu on gallery items ("To 3D", "Hide/Show 3D")
│   │   ├── LoginModal.js           # User-ID login, session list, new/resume session
│   │   ├── Viewer3D.js             # Thin React wrapper around Viewer3DCore
│   │   ├── SceneSettingsPanel.js   # Background/lighting/exposure/grid controls
│   │   ├── SliderPanel.js          # Semantic-slider builder and anchor UI
│   │   ├── StatusBanner.js         # Top-of-screen "working…" banner
│   │   └── TextTo3DModal.js        # Prompt + seed modal for text-to-3D
│   ├── hooks/                  # (reserved — currently empty)
│   ├── lib/
│   │   └── Viewer3DCore.js         # Vanilla-JS Three.js scene: GLB loading, gizmos, picking
│   ├── styles/
│   │   └── App.css                 # All application styles
│   ├── utils/
│   │   └── behaviorLogger.js       # POSTs behavior events to /log_behavior
│   ├── App.js                  # Root component: state, backend calls, Socket.IO wiring
│   ├── index.js                # React entry point
│   └── setupProxy.js           # Dev-server proxy rules for the two backends
├── package.json
├── package-lock.json
└── README.md
```

## Component Reference

The sections below describe every React component, what it does, and — when
relevant — exactly which backend endpoints it calls and how.

### `App.js` — root component

Holds all application state (session, gallery, loaded 3D objects, sliders,
scene settings, etc.) and exposes callbacks to the children. **Most server
communication lives here**, not in the leaf components.

Server communication performed directly by `App.js`:


| Action                                           | Endpoint                            | Server         | Method                                                                                                                                                  | Notes                                                                                                            |
| ------------------------------------------------ | ----------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Initializes Socket.IO client                     | `io()` (proxied to `/socket.io/`*)  | Trellis (5002) | WebSocket                                                                                                                                               | Listens for `slider_progress`, `slider_complete`, `slider_error`, `anchor_point_complete`, `anchor_point_error`. |
| Upload image                                     | `POST /upload`                      | SAM3D (5001)   | `multipart/form-data` with `file` + `session_id`.                                                                                                       |                                                                                                                  |
| Run SAM2 segmentation                            | `POST /segment`                     | SAM3D          | JSON `{ points, labels, session_id }`; returns base64-encoded preview image.                                                                            |                                                                                                                  |
| Reset SAM2 points                                | `POST /reset`                       | SAM3D          | No body; reverts preview to the uploaded image.                                                                                                         |                                                                                                                  |
| Finalize a segmented object                      | `POST /finish_object`               | SAM3D          | JSON `{ points, labels, session_id }`; returns `object_index` + thumbnail.                                                                              |                                                                                                                  |
| Combine objects                                  | `POST /combine_objects`             | SAM3D          | JSON `{ indices, session_id }`.                                                                                                                         |                                                                                                                  |
| Delete an object                                 | `POST /delete_object`               | SAM3D          | JSON `{ object_index, session_id }`, fired per index.                                                                                                   |                                                                                                                  |
| Image-to-3D (TRELLIS)                            | `POST /to_3d`                       | SAM3D          | JSON `{ object_index, session_id }`; returns `glb_url`.                                                                                                 |                                                                                                                  |
| Text-to-3D (TRELLIS)                             | `POST /trellis/generate`            | Trellis        | JSON `{ prompt, seed, session_id, user_id }`; returns `glb_url` + `object_id`.                                                                          |                                                                                                                  |
| Trigger multi-view render                        | `POST /trellis/render_views`        | Trellis        | Fire-and-forget background render after any new GLB.                                                                                                    |                                                                                                                  |
| Fetch existing sliders                           | `POST /trellis/get_sliders`         | Trellis        | Called the first time an object is selected.                                                                                                            |                                                                                                                  |
| Resolve slider-variant GLB URL                   | `POST /resolve_variant`             | SAM3D          | Avoids 404 noise by asking the server which GLB file corresponds to a given `slider_index` / `slider_value` / `use_original` flag.                      |                                                                                                                  |
| Persist anchor Y-rotation                        | `POST /trellis/set_anchor_rotation` | Trellis        | JSON payload with `y_rotation`.                                                                                                                         |                                                                                                                  |
| Fork a slider variant as a new object            | `POST /trellis/fork_anchor`         | Trellis        | JSON payload; returns a new `object_id` + `glb_url`.                                                                                                    |                                                                                                                  |
| Debounced persistence of transforms & visibility | `POST /save_object_states`          | SAM3D          | Debounced 500 ms after any gizmo drag or visibility change. Serializes `{ visible, transform, sliderAnchors, brightnessDepth }` for each loaded object. |                                                                                                                  |


Socket.IO events emitted by `App.js`:

- `create_slider` — starts (or resumes) a slider build. Carries
`{ glb_filename, object, attribute, slider_index, num_samples, session_id, user_id, request_id }`. Progress streams back on
`slider_progress`; the final result arrives on `slider_complete`.
Up to `MAX_CONCURRENT_SLIDERS = 2` builds can run at once.
- `add_anchor_point` — adds a new snap point at a requested percentage on an
existing slider. Reply arrives on `anchor_point_complete` with the updated
anchor list.

On **session resume**, `App.js` reloads every previously saved GLB, then
once `Viewer3DCore` reports `onObjectsReady` it re-fetches each object's
sliders (`/trellis/get_sliders`), resolves the saved variant URL
(`/resolve_variant`), and triggers `swapModel` calls to restore every
object to the anchor position the user last left it at.

---

### `components/Header.js`

Top toolbar. Shows the current user ID, groups the "Image to 3D" actions
(Upload, Image-panel toggle, Undo, Reset, Finish) and the "Text to 3D"
action (Generate), and hosts two dropdowns on the right:

- A **Help modal** documenting mouse/trackpad/transform shortcuts.
- A **Scene Settings** dropdown that renders `SceneSettingsPanel` when open.
The click-outside handler (`mousedown` listener on `document`) closes the
panel when the user clicks elsewhere.

Also shows a `status-badge` element that pulses while `isLoading` is true.
Does not talk to any server directly — it just invokes the callbacks
passed down from `App.js`.

---

### `components/ImagePanel.js`

Floating panel that displays the uploaded source image and the SAM2 point
markers the user has placed. Converts every click to image-space
coordinates:

1. Reads the `<img>` bounding rect.
2. Computes the scale factor from displayed size to `naturalWidth/Height`.
3. Fires `onImageClick(trueX, trueY, isRightClick)` with the true pixel
  coordinates.

`isRightClick` is true for right-clicks; the parent interprets that as a
negative prompt point for SAM2. The panel also suppresses the browser's
context menu so right-clicks are usable. It does **not** talk to the
server itself — the actual `/segment` call is made by `App.js` in
`handleImageClick`.

---

### `components/Sidebar.js`

Right-hand collapsible gallery of objects. Renders:

- A selection toolbar that appears whenever one or more items are selected
(Combine, Uncombine, Delete). Combine is disabled when any selected item
is from `source: 'trellis'` (text-to-3D objects cannot be combined).
- A `GalleryItem` grid. Each item shows either the segmentation thumbnail
(base64 PNG for SAM2 objects) or a stacked-cubes placeholder (for
`trellis` / `commons` sources). Items gain a `has-3d` class when they
are present in the 3D scene, and a small icon when combined.

Fires click and right-click events back to `App.js`, which handles
multi-select (Shift/Ctrl/Meta) and opens the context menu. No direct
server calls.

---

### `components/TransformPanel.js` (memoized)

Shows the selected object's position, rotation (deg), and scale, plus the
three gizmo-mode buttons (Move / Rotate / Scale). Keeps **local** state
for every input so typing doesn't thrash the global state on every
keystroke:

- `onTransformInputChange(type, value)` fires on each input change →
`App.js` forwards it to `Viewer3DCore.setTransform()` so the 3D
gizmo follows the typed value live.
- `onTransformCommit()` fires on blur (only when the user actually edited
something) → `App.js` debounces a `POST /save_object_states`.

A `dirtyRef` flag avoids spurious commits when the panel re-syncs from a
gizmo drag in the scene. No direct server calls — commits flow through
`App.js`.

---

### `components/ContextMenu.js`

Right-click popover on a gallery item. Offers a single action depending on
state:

- If the object has no 3D yet: **"To 3D"** → triggers `handleConvertTo3D`
in `App.js` which calls `POST /to_3d`. Disabled when another 3D
generation is in flight.
- If the object already has 3D: **"Hide 3D"** / **"Show 3D"** →
toggles visibility through `handleToggleVisibility` (local state +
debounced `/save_object_states`).

Clamps its x position so the menu stays in the viewport. No direct server
calls.

---

### `components/LoginModal.js`

Initial modal: the user types a user ID and either checks previous
sessions or starts a new one.

Server communication (all on port 5001, SAM3D):

- `GET /get_user_sessions/<userId>` — on "Check Sessions", fetches the
list of existing sessions so the user can pick one to resume.
- `POST /resume_session` — body `{ user_id, session_id }`. On success,
calls `onSessionStart(session_id, user_id, gallery_items, image_filename, object_states)` so `App.js` can restore the full scene.
- `POST /start_session` — body `{ user_id }`. Starts a fresh session and
passes `session_id` + `user_id` back up through `onSessionStart`.

The last-used user ID is cached in `localStorage['lastUserId']`. Input is
validated to `[A-Za-z0-9_-]+` before anything is sent.

---

### `components/Viewer3D.js`

**Thin** React wrapper around the vanilla-JS `Viewer3DCore`. On mount it
creates one `Viewer3DCore` instance, wires up its four event callbacks
(`onSelect`, `onTransformChange`, `onTransformDragEnd`, `onObjectsReady`),
and from then on only pushes prop changes imperatively:

- `loadedObjects` → `core.syncObjects(...)` (adds / removes GLBs).
- `selectedObject` → `core.selectObject(...)`.
- `gizmoMode` → `core.setGizmoMode(...)`.
- `transformInputChange` → `core.setTransform(type, value)`.
- `swapModelRequest` → `core.swapModel(id, url, yRotation, scaleMode, originYRotation, brightnessDepth, manualBrightness)` — used whenever
a semantic slider moves to a new anchor.
- Scene settings (`backgroundColor`, `ambientIntensity`,
`mainLightIntensity`, `exposure`, `showGrid`) → matching setters on
the core.

Exposes `getAllTransforms()` and `setObjectBrightness(id, factor)` to the
parent via `useImperativeHandle`. The component renders nothing but a
container `<div>`; no direct server communication.

> Note: GLBs are fetched by `Viewer3DCore` using the browser's built-in
> loaders against the URLs returned by `/to_3d`, `/trellis/generate`,
> `/resolve_variant`, etc. Those URLs are served by the backends and go
> through the dev-server proxy like any other request.

---

### `components/SceneSettingsPanel.js`

Dropdown-panel that renders inside `Header`. Controls:

- Background color (preset swatches, color picker, hex input).
- Ambient light intensity (0–5 slider).
- Directional ("Directional Light" = main light) intensity (0–5 slider).
- Exposure / brightness (0.1–10 slider).
- Show-grid checkbox.

Every change fires `onSettingsChange(newSettings)` upward, where `App.js`
updates `sceneSettings` state (which then flows into `Viewer3D` via
props).

Server communication: imports `logBehavior` from
`utils/behaviorLogger.js` and calls `logBehavior('change_scene_setting', { settingName, value })` on every mouse-up / blur, which POSTs to
`/log_behavior` on the SAM3D backend. No other backend calls.

---

### `components/SliderPanel.js`

Draggable floating panel that appears whenever a loaded 3D object is
selected. Lets the user build and operate **semantic sliders** on that
object. Internally composed of several subcomponents (`AnchorSlider`,
`AddAnchorRow`, `RotationInput`) plus the main form.

Top form:

- Two text inputs — `object` (e.g. "face") and `attribute` (e.g. "smile").
- `Samples` numeric input (1–20) controlling the number of generated
samples per slider.
- `Brightness` slider for the current object / mode.
- **Create Slider** button → `onCreateSlider(objectId, object, attribute, numSamples)`. Returns one of `'exists'` / `'creating'` / `'resuming'` /
`'busy'` so the panel can show a duplicate hint or clear inputs.

Scale-mode toggle (H / W / 1:1) and Origin toggle (Orig / Recon) live in
the header. "Orig" means "show the original GLB at slider value 0";
"Recon" uses the reconstruction generated during slider building. The
toggle is auto-disabled when only one option is available.

While a slider is being built, the 5-step progress strip (`STEPS`) shows
which step is active, plus a spinner and the live status message
streamed via Socket.IO.

For every completed slider the panel renders an `AnchorSlider`:

- The underlying `<input type="range">` operates on LPIPS distance
(0–1). On every change the handler snaps to the **nearest** anchor
(not linear), calls `setCurrentAnchorIndex(nearestIdx)`, marks the
slider active, and fires `onAnchorChange(objectId, slider, nearestIdx)`.
- A tooltip displays the current slider value mapped to −100 … 100 %
(with the origin `sv=0` clearly marked).
- When a slider is active, two extra rows appear:
  - `RotationInput` for per-anchor Y-rotation (commits on blur / Enter
  through `onRotationChange`).
  - A **Fork** button (`onForkAnchor`) that asks the backend to fork the
  current variant as a brand-new object in the gallery.
  - `AddAnchorRow` for adding new snap points at a user-supplied
  percentage (`onAddAnchorPoint`). Disabled while an add for the
  same object is in flight, or when all GPU pools are busy.

The panel itself does not call `fetch`/Socket.IO directly — all server
work is routed through the callbacks (`onCreateSlider`,
`onAnchorChange`, `onAddAnchorPoint`, `onRotationChange`,
`onForkAnchor`) which are implemented in `App.js` and documented above.
It does keep a per-object anchor-position map in a ref
(`anchorIndexByObjectRef`) and seeds it from `savedSliderAnchors` on
first visit so a resumed session shows each slider at the correct snap.

---

### `components/StatusBanner.js`

Tiny presentational component: renders a spinner + message at the top of
the screen when `message` is truthy. Used for "Generating 3D model…" and
"Rendering multi-views…" notices. No state, no server calls.

---

### `components/TextTo3DModal.js`

Modal for text-to-3D generation. A textarea (prompt) + numeric seed input

- submit/cancel buttons. Calls `onGenerate(prompt, seed)` on submit.
The actual `POST /trellis/generate` call is in `App.js`'s
`handleTextTo3DGenerate`. While loading, the modal disables its form and
shows a spinner with the shared `statusMessage` string. No direct server
communication.

---

## Supporting Files

### `lib/Viewer3DCore.js`

Vanilla-JS Three.js class that owns the WebGL scene, camera, lights,
`OrbitControls`, `TransformControls` (gizmo), GLTF loading, object
picking, per-object brightness math, and model swapping for slider
variants. Exposes `syncObjects`, `selectObject`, `setGizmoMode`,
`setTransform`, `swapModel`, `getAllTransforms`, `setObjectBrightness`,
`setBackgroundColor`, `setAmbientIntensity`, `setMainLightIntensity`,
`setExposure`, `setGridVisible`, and the four `on`* event-callback
registrars. Keeps an in-memory GLTF cache and a per-id swap-version
counter so stale async loads are discarded.

### `utils/behaviorLogger.js`

`initLogger(sessionId, userId)` captures the active session context.
`logBehavior(action, data)` fire-and-forgets a
`POST /log_behavior` with `{ timestamp, sessionId, userId, action, data }`. Used throughout the app to record segmentation clicks, slider moves,
object selection, etc. Failures are logged to the console and swallowed.

### `setupProxy.js`

Dev-server proxy configuration (Create React App's `setupProxy.js`
convention). Routes:

- `/trellis/*` → `http://localhost:5002` (Trellis REST).
- `/socket.io/*` → `http://localhost:5002` with `ws: true` (Trellis
Socket.IO upgrade).
- Everything else in the whitelist (`/upload`, `/uploads`, `/downloads`,
`/segment`, `/finish_object`, `/to_3d`, `/combine_objects`,
`/uncombine_object`, `/delete_object`, `/reset`, `/start_session`,
`/resume_session`, `/get_user_sessions`, `/log_behavior`,
`/resolve_variant`, `/serve_variant`, `/save_object_states`) →
`http://localhost:5001` (SAM3D).

### `index.js` / `public/index.html`

Standard CRA bootstrap: `index.html` provides a `<div id="root">`, and
`index.js` renders `<App />` under `React.StrictMode` with the global
stylesheet `styles/App.css`.