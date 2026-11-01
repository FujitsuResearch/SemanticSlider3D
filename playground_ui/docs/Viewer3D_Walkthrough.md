# Viewer3D - Hybrid Architecture Documentation

This document explains the hybrid architecture of the 3D viewer component, which combines the performance of vanilla JavaScript with the maintainability of React.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                             React App (App.js)                            │
│  ┌──────────┐ ┌──────────┐ ┌───────────────┐ ┌─────────────────────────┐ │
│  │  Header  │ │ Sidebar  │ │ TransformPanel│ │     Other UI...         │ │
│  └──────────┘ └──────────┘ └───────────────┘ └─────────────────────────┘ │
│                      ▲              ▲                                     │
│                      │              │                                     │
│               events/callbacks      │                                     │
│                      │              │                                     │
│  ┌───────────────────┴──────────────┴───────────────────────────────────┐│
│  │                  Viewer3D.js (Thin React Wrapper)                     ││
│  │   • Mounts Viewer3DCore on mount                                      ││
│  │   • Syncs React props → Core via useEffect                            ││
│  │   • Forwards Core events → React callbacks                            ││
│  │   • Contains NO Three.js code                                         ││
│  │                                                                        ││
│  │   ┌────────────────────────────────────────────────────────────────┐  ││
│  │   │              Viewer3DCore.js (Pure Vanilla JavaScript)          │  ││
│  │   │                                                                  │  ││
│  │   │   • THREE.Scene, Camera, Renderer                               │  ││
│  │   │   • OrbitControls (camera movement)                             │  ││
│  │   │   • TransformControls (object manipulation gizmo)               │  ││
│  │   │   • GLTFLoader (3D model loading)                               │  ││
│  │   │   • Raycaster (click selection)                                 │  ││
│  │   │   • Animation loop (60fps rendering)                            │  ││
│  │   │                                                                  │  ││
│  │   │   Zero React dependencies - pure Three.js                       │  ││
│  │   └────────────────────────────────────────────────────────────────┘  ││
│  └───────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
src/
├── components/
│   └── Viewer3D.js       # Thin React wrapper (~90 lines)
├── lib/
│   └── Viewer3DCore.js   # Pure vanilla JS class (~350 lines)
```

---

## Why This Architecture?

| Challenge | Solution |
|-----------|----------|
| React re-renders slow down 3D | Core uses no React state, runs independently |
| Three.js needs refs everywhere | Core manages all 3D objects internally |
| Complex 3D code in useEffects | Clean class-based API in Core |
| Hard to test 3D logic | Core can be tested without React |
| UI components need React | Keep UI in React, only isolate 3D |

---

## Part 1: Viewer3DCore.js (Vanilla JavaScript)

This is a pure JavaScript class with **zero framework dependencies**. It can work with React, Vue, Svelte, or plain HTML.

### Class Structure

```javascript
class Viewer3DCore {
  // Properties
  container       // DOM element
  scene           // THREE.Scene
  camera          // THREE.PerspectiveCamera
  renderer        // THREE.WebGLRenderer
  orbitControls   // OrbitControls
  transformControls // TransformControls
  objects         // { id: THREE.Group }
  selectedId      // number | null
  
  // Event callbacks
  _onSelect           // function(id)
  _onTransformChange  // function({position, rotation, scale})
}
```

### Public API

#### Object Management

| Method | Description |
|--------|-------------|
| `loadObject(id, url, visible)` | Load a GLB model, returns Promise |
| `removeObject(id)` | Remove an object from scene |
| `setVisibility(id, visible)` | Show/hide an object |
| `syncObjects(loadedObjects)` | Sync with React state (add/remove/update) |

#### Selection & Transform

| Method | Description |
|--------|-------------|
| `selectObject(id)` | Select object, attach gizmo |
| `setGizmoMode(mode)` | 'translate' \| 'rotate' \| 'scale' |
| `setTransform(type, value)` | Apply transform to selected object |
| `getTransform(id)` | Get current transform of an object |

#### Events

| Method | Description |
|--------|-------------|
| `onSelect(callback)` | Called when user clicks an object |
| `onTransformChange(callback)` | Called when transform gizmo is released |

#### Lifecycle

| Method | Description |
|--------|-------------|
| `constructor(container)` | Create viewer in DOM element |
| `dispose()` | Clean up all resources |

### Internal Methods

| Method | Purpose |
|--------|---------|
| `_init()` | Set up scene, camera, renderer, controls |
| `_setupLights()` | Add ambient, directional, hemisphere lights |
| `_setupControls()` | Create OrbitControls and TransformControls |
| `_setupEventListeners()` | Handle clicks and resize |
| `_handleClick(e)` | Raycast to detect clicked object |
| `_handleResize()` | Update camera aspect and renderer size |
| `_animate()` | The render loop (requestAnimationFrame) |
| `_reportTransform(obj)` | Send transform data to callback |

### Example: Using Core Without React

```javascript
// Pure JavaScript usage
const container = document.getElementById('viewer');
const viewer = new Viewer3DCore(container);

// Load objects
await viewer.loadObject(1, '/models/chair.glb');
await viewer.loadObject(2, '/models/table.glb');

// Listen for selection
viewer.onSelect((id) => {
  console.log('Selected:', id);
});

// Listen for transforms
viewer.onTransformChange((transform) => {
  console.log('Position:', transform.position);
});

// Change gizmo mode
viewer.setGizmoMode('rotate');

// Cleanup
viewer.dispose();
```

---

## Part 2: Viewer3D.js (React Wrapper)

This is a **thin wrapper** (~90 lines) that bridges React and the Core.

### What It Does

1. **Mount**: Creates `Viewer3DCore` when component mounts
2. **Sync Props → Core**: Uses `useEffect` to call Core methods when props change
3. **Sync Core → React**: Passes callbacks to Core that update React state
4. **Unmount**: Calls `dispose()` to clean up

### Code Walkthrough

```javascript
function Viewer3D({
  loadedObjects,        // What objects to show
  selectedObject,       // Currently selected ID
  setSelectedObject,    // Callback to update selection
  gizmoMode,           // 'translate' | 'rotate' | 'scale'
  onTransformChange,   // Callback for transform updates
  transformInputChange // Transform from panel inputs
}) {
  const containerRef = useRef(null);
  const coreRef = useRef(null);

  // ═══════════════════════════════════════════════════════════════
  // MOUNT - Create core once
  // ═══════════════════════════════════════════════════════════════
  useEffect(() => {
    coreRef.current = new Viewer3DCore(containerRef.current);
    coreRef.current.onSelect(setSelectedObject);
    coreRef.current.onTransformChange(onTransformChange);
    return () => coreRef.current?.dispose();
  }, []);

  // ═══════════════════════════════════════════════════════════════
  // SYNC - React props → Core (imperative calls)
  // ═══════════════════════════════════════════════════════════════
  useEffect(() => {
    coreRef.current?.syncObjects(loadedObjects);
  }, [loadedObjects]);

  useEffect(() => {
    coreRef.current?.selectObject(selectedObject);
  }, [selectedObject]);

  useEffect(() => {
    coreRef.current?.setGizmoMode(gizmoMode);
  }, [gizmoMode]);

  useEffect(() => {
    if (transformInputChange) {
      coreRef.current?.setTransform(
        transformInputChange.type, 
        transformInputChange.value
      );
    }
  }, [transformInputChange]);

  // ═══════════════════════════════════════════════════════════════
  // RENDER - Just a container
  // ═══════════════════════════════════════════════════════════════
  return <div ref={containerRef} className="viewer3d" />;
}

export default React.memo(Viewer3D);
```

### Key Design Points

1. **Empty dependency array on mount**: The Core is created once and never recreated
2. **`React.memo`**: Prevents re-renders unless props actually change
3. **Refs for Core**: `coreRef` holds the Core instance without triggering re-renders
4. **One-way prop sync**: Each `useEffect` only calls one Core method

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              App.js State                                │
│                                                                          │
│  loadedObjects ────────────────┐                                        │
│  selectedObject ───────────────┼──► useEffect calls ──► coreRef.current │
│  gizmoMode ────────────────────┤                             │          │
│  transformInputChange ─────────┘                             │          │
│                                                              │          │
│                                                              ▼          │
│                                                    ┌─────────────────┐  │
│                                                    │  Viewer3DCore   │  │
│                                                    │  (runs at 60fps)│  │
│                                                    └────────┬────────┘  │
│                                                              │          │
│  setSelectedObject ◄───────────────────── onSelect callback ─┤          │
│  onTransformChange ◄────────────── onTransformChange callback┘          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key insight**: React only updates when:
- Objects are added/removed (loadedObjects changes)
- User clicks an object (onSelect callback)
- User finishes dragging gizmo (onTransformChange callback)

React does **NOT** update during:
- Camera rotation/pan/zoom (OrbitControls)
- Object dragging (TransformControls)
- Every frame render (animation loop)

---

## Performance Comparison

| Scenario | Old React Approach | Hybrid Approach |
|----------|-------------------|-----------------|
| Camera drag | React state updates | No React involvement |
| Object drag | State updates per frame | No React until drag ends |
| Prop changes | Full component re-render | Single Core method call |
| Animation loop | React reconciliation | Pure requestAnimationFrame |

---

## Adding New Features

### Adding a Feature to Core (e.g., grid toggle)

```javascript
// In Viewer3DCore.js
class Viewer3DCore {
  constructor(container) {
    // ...
    this.gridHelper = new THREE.GridHelper(20, 20);
    this.scene.add(this.gridHelper);
  }

  setGridVisible(visible) {
    this.gridHelper.visible = visible;
  }
}
```

### Exposing to React

```javascript
// In Viewer3D.js - add prop and useEffect
function Viewer3D({ /* existing props */, showGrid }) {
  // ...
  useEffect(() => {
    coreRef.current?.setGridVisible(showGrid);
  }, [showGrid]);
}
```

---

## Testing

### Testing Core (No React needed)

```javascript
// viewer3d-core.test.js
import Viewer3DCore from './Viewer3DCore';

describe('Viewer3DCore', () => {
  let container;
  let viewer;

  beforeEach(() => {
    container = document.createElement('div');
    container.style.width = '800px';
    container.style.height = '600px';
    document.body.appendChild(container);
    viewer = new Viewer3DCore(container);
  });

  afterEach(() => {
    viewer.dispose();
    document.body.removeChild(container);
  });

  test('loads object', async () => {
    await viewer.loadObject(1, '/test.glb');
    expect(viewer.objects[1]).toBeDefined();
  });

  test('selects object', async () => {
    await viewer.loadObject(1, '/test.glb');
    viewer.selectObject(1);
    expect(viewer.selectedId).toBe(1);
  });
});
```

### Testing Wrapper (React Testing Library)

```javascript
// Viewer3D.test.js
import { render } from '@testing-library/react';
import Viewer3D from './Viewer3D';

// Mock the Core
jest.mock('../lib/Viewer3DCore');

test('syncs loadedObjects to core', () => {
  const { rerender } = render(
    <Viewer3D loadedObjects={{}} />
  );
  rerender(
    <Viewer3D loadedObjects={{ 1: { glbUrl: '/a.glb' } }} />
  );
  expect(Viewer3DCore.mock.instances[0].syncObjects).toHaveBeenCalledWith({
    1: { glbUrl: '/a.glb' }
  });
});
```

---

## Summary

| Layer | Responsibility | Technology |
|-------|---------------|------------|
| **App.js** | State management, UI layout | React |
| **UI Components** | Buttons, panels, inputs | React |
| **Viewer3D.js** | Bridge between React and 3D | React (thin) |
| **Viewer3DCore.js** | All 3D rendering and interaction | Vanilla JS + Three.js |

This architecture gives you:
- ⚡ **Vanilla JS performance** for 3D manipulation
- 🧩 **React's component model** for UI
- 📁 **Clean separation** of concerns
- 🧪 **Easy testing** of each layer
- 🔧 **Simple maintenance** and extension
