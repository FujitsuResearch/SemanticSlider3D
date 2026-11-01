/**
 * Viewer3DCore - Pure vanilla JavaScript 3D viewer
 * No React, no framework dependencies - just Three.js
 * 
 * This class handles all 3D rendering and interaction logic.
 * React (or any framework) should use this as a black box.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';

// Per-object brightness: additive boost per generation depth with decay.
// Each depth level adds BOOST * DECAY^(level-1), so deeper levels add less.
// Total = 1 + BOOST * (1 - DECAY^depth) / (1 - DECAY)
const BRIGHTNESS_BOOST_PER_DEPTH = 0.75;
const BRIGHTNESS_DECAY = 0.5;

/**
 * Traverse all meshes in a scene and multiply material base color
 * by the given brightness factor. This simulates per-object exposure.
 */
function applyMaterialBrightness(root, factor) {
  if (!root || factor === 1.0) return;
  root.traverse((node) => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach((mat) => {
      if (mat.color) {
        mat.color.multiplyScalar(factor);
      }
      mat.needsUpdate = true;
    });
  });
}

export default class Viewer3DCore {
  constructor(container) {
    this.container = container;
    this.objects = {};  // { id: THREE.Group }
    this._pendingLoads = new Set();  // Track in-flight GLB loads
    this._swapVersion = {};  // { id: number } - monotonic counter to discard stale loads
    this._gltfCache = {};  // { baseUrl: gltf } - in-memory GLTF cache for instant revisits
    this.selectedId = null;
    this.loader = new GLTFLoader();
    
    // Event callbacks
    this._onSelect = null;
    this._onTransformChange = null;
    this._onTransformDragEnd = null;
    this._onObjectsReady = null;
    
    this._init();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  _init() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    // Scene - match original light gray background
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf0f0f0);

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    this.camera.position.set(5, 5, 5);
    this.camera.lookAt(0, 0, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    
    // CRITICAL: Enable proper color rendering (fixes dull/dark colors on GLB models)
    // For Three.js r152+, use outputColorSpace; for older versions use outputEncoding
    if (this.renderer.outputColorSpace !== undefined) {
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    } else {
      this.renderer.outputEncoding = THREE.sRGBEncoding;
    }
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    
    this.container.appendChild(this.renderer.domElement);

    // Lights
    this._setupLights();

    // Grid
    this.scene.add(new THREE.GridHelper(20, 20, 0x888888, 0x444444));

    // Controls
    this._setupControls();

    // Raycaster for selection
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Event listeners
    this._setupEventListeners();

    // Start render loop
    this._animate();
  }

  _setupLights() {
    // Match the original index.html lighting for proper colors
    // Ambient light - provides base illumination
    this.ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
    this.scene.add(this.ambientLight);
    
    // Main directional light - key light
    this.mainLight = new THREE.DirectionalLight(0xffffff, 2.5);
    this.mainLight.position.set(5, 5, 10);
    this.mainLight.castShadow = true;
    this.scene.add(this.mainLight);
  }

  _setupControls() {
    // Orbit Controls
    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.1;
    this.orbitControls.screenSpacePanning = true;
    this.orbitControls.zoomSpeed = 0.8;

    // Mouse: left=rotate, middle/right=pan (standard mouse workflow unchanged)
    this.orbitControls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };

    // Touch: one-finger rotate, two-finger dolly+pan
    this.orbitControls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };

    // Disable built-in scroll-to-zoom — we handle wheel events manually
    // to distinguish pinch (zoom) from two-finger scroll (pan) vs shift+scroll (rotate)
    this.orbitControls.enableZoom = false;

    // Transform Controls
    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.size = 0.8;
    this.scene.add(this.transformControls);

    // Disable orbit while dragging transform gizmo
    this.transformControls.addEventListener('dragging-changed', (e) => {
      this.orbitControls.enabled = !e.value;

      // Report transform on drag end
      if (!e.value && this.transformControls.object) {
        this._reportTransform(this.transformControls.object);
        if (this._onTransformDragEnd) {
          this._onTransformDragEnd();
        }
      }
    });
  }

  _setupEventListeners() {
    // Track pointer for click vs drag detection
    let startX, startY;

    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
    });

    this.renderer.domElement.addEventListener('click', (e) => {
      // Ignore if dragged
      if (Math.abs(e.clientX - startX) > 5 || Math.abs(e.clientY - startY) > 5) return;

      this._handleClick(e);
    });

    // Shift+left-drag = pan (for users who prefer click-drag)
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.shiftKey && e.button === 0) {
        this.orbitControls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      }
    });
    window.addEventListener('pointerup', () => {
      this.orbitControls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    });

    // ─── Wheel handling (mouse + trackpad) ───────────────────────────
    // Mouse scroll wheel: deltaMode=1 (lines) or deltaMode=0 with no deltaX
    //   → always zoom
    // Trackpad pinch: ctrlKey=true (browser-synthesized)
    //   → zoom
    // Trackpad two-finger scroll: deltaMode=0, often has deltaX
    //   → pan (no modifier), rotate (shift held)
    this.renderer.domElement.addEventListener('wheel', (e) => {
      e.preventDefault();

      // Detect mouse wheel: deltaMode=1 (line-based), or no horizontal delta
      // and deltaY is a round multiple (mouse wheels produce ±100/±120 on most OS)
      const isMouseWheel = e.deltaMode === 1 ||
        (e.deltaMode === 0 && e.deltaX === 0 && Math.abs(e.deltaY) >= 20 && e.deltaY % 1 === 0 && !e.ctrlKey);

      if (e.ctrlKey || isMouseWheel) {
        // ── Pinch or mouse scroll wheel → zoom ──
        // Use smaller multiplier for mouse wheel (large discrete steps)
        const speed = isMouseWheel ? 0.001 : 0.01;
        const zoomDelta = e.deltaY * speed;
        this.camera.position.sub(this.orbitControls.target)
          .multiplyScalar(1 + zoomDelta)
          .add(this.orbitControls.target);
        this.orbitControls.update();

      } else if (e.shiftKey) {
        // ── Shift + two-finger scroll → rotate ──
        const rotateFactor = 0.003;
        const azimuth = -e.deltaX * rotateFactor;
        const polar = -e.deltaY * rotateFactor;

        const offset = this.camera.position.clone().sub(this.orbitControls.target);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        spherical.theta += azimuth;
        spherical.phi += polar;
        spherical.phi = Math.max(0.01, Math.min(Math.PI - 0.01, spherical.phi));
        offset.setFromSpherical(spherical);
        this.camera.position.copy(this.orbitControls.target).add(offset);
        this.camera.lookAt(this.orbitControls.target);
        this.orbitControls.update();

      } else {
        // ── Two-finger scroll → pan ──
        const panFactor = 0.003 * this.camera.position.distanceTo(this.orbitControls.target);
        const right = new THREE.Vector3();
        const up = new THREE.Vector3();
        this.camera.getWorldDirection(up);
        right.crossVectors(this.camera.up, up.negate()).normalize();
        up.copy(this.camera.up).normalize();

        const panOffset = right.multiplyScalar(e.deltaX * panFactor)
          .add(up.multiplyScalar(-e.deltaY * panFactor));
        this.camera.position.add(panOffset);
        this.orbitControls.target.add(panOffset);
        this.orbitControls.update();
      }
    }, { passive: false });

    // Resize handler
    this._boundResize = this._handleResize.bind(this);
    window.addEventListener('resize', this._boundResize);
  }

  _handleClick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Collect meshes from visible objects only
    const meshes = [];
    Object.entries(this.objects).forEach(([id, group]) => {
      if (!group.visible) return;
      group.traverse((child) => {
        if (child.isMesh) {
          child.userData.objectId = String(id);
          meshes.push(child);
        }
      });
    });

    const intersects = this.raycaster.intersectObjects(meshes);

    if (intersects.length > 0) {
      const id = intersects[0].object.userData.objectId;
      this.selectObject(id);
      if (this._onSelect) this._onSelect(id);
    } else {
      this.selectObject(null);
      if (this._onSelect) this._onSelect(null);
    }
  }

  _handleResize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  _animate() {
    this._animationId = requestAnimationFrame(() => this._animate());
    this.orbitControls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Find a non-overlapping position for a new object on the XZ plane.
   * Uses a spiral scan outward from the origin, checking against existing footprints.
   */
  _findPlacement(width, depth, gap) {
    if (Object.keys(this.objects).length === 0) {
      return { x: 0, z: 0 };
    }

    // Collect footprints of existing objects: { cx, cz, hw, hd }
    const footprints = [];
    for (const obj of Object.values(this.objects)) {
      const box = new THREE.Box3().setFromObject(obj);
      footprints.push({
        cx: obj.position.x,
        cz: obj.position.z,
        hw: (box.max.x - box.min.x) / 2,
        hd: (box.max.z - box.min.z) / 2,
      });
    }

    const myHW = width / 2;
    const myHD = depth / 2;

    const overlaps = (x, z) => {
      for (const fp of footprints) {
        if (Math.abs(x - fp.cx) < myHW + fp.hw + gap &&
            Math.abs(z - fp.cz) < myHD + fp.hd + gap) {
          return true;
        }
      }
      return false;
    };

    // Spiral outward in steps, testing candidate positions
    const step = Math.max(width, depth, 1) * 0.5 + gap;
    for (let ring = 1; ring < 20; ring++) {
      const dist = ring * step;
      // Test positions around a square ring
      for (let i = -ring; i <= ring; i++) {
        const candidates = [
          { x: i * step, z: -dist },
          { x: i * step, z: dist },
          { x: -dist, z: i * step },
          { x: dist, z: i * step },
        ];
        for (const c of candidates) {
          if (!overlaps(c.x, c.z)) return c;
        }
      }
    }

    // Fallback — far away
    return { x: Object.keys(this.objects).length * 5, z: 0 };
  }

  _reportTransform(obj) {
    if (!this._onTransformChange) return;
    
    this._onTransformChange({
      position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
      rotation: {
        x: THREE.MathUtils.radToDeg(obj.rotation.x),
        y: THREE.MathUtils.radToDeg(obj.rotation.y),
        z: THREE.MathUtils.radToDeg(obj.rotation.z)
      },
      scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API - Object Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Load a 3D object from a GLB URL
   * @param {string|number} id - Unique object identifier
   * @param {string} url - URL to the GLB file
   * @param {boolean} visible - Initial visibility
   * @returns {Promise} Resolves when loaded
   */
  loadObject(id, url, visible = true, brightnessDepth = 0) {
    const strId = String(id);
    return new Promise((resolve, reject) => {
      if (this.objects[strId] || this._pendingLoads.has(strId)) {
        resolve(this.objects[strId]);
        return;
      }

      this._pendingLoads.add(strId);
      this.loader.load(url, (gltf) => {
        this._pendingLoads.delete(strId);

        // Another load may have completed first - skip duplicate
        if (this.objects[strId]) {
          resolve(this.objects[strId]);
          return;
        }

        const group = new THREE.Group();
        const model = gltf.scene.clone();
        group.add(model);

        // Normalize all objects to a consistent height on load
        const TARGET_HEIGHT = 2;
        const box = new THREE.Box3().setFromObject(model);
        const rawHeight = box.max.y - box.min.y;
        if (rawHeight > 0) {
          const s = TARGET_HEIGHT / rawHeight;
          model.scale.set(s, s, s);
        }

        // Apply per-object brightness boost for forked (reconstructed) objects
        if (brightnessDepth > 0) {
          applyMaterialBrightness(model, 1.0 + BRIGHTNESS_BOOST_PER_DEPTH * (1 - Math.pow(BRIGHTNESS_DECAY, brightnessDepth)) / (1 - BRIGHTNESS_DECAY));
        }

        // Record dimensions after normalization (slider scaling works relative to these)
        const normBox = new THREE.Box3().setFromObject(model);
        model.position.y = -normBox.min.y;
        group.userData.originalHeight = normBox.max.y - normBox.min.y;
        group.userData.originalWidth = normBox.max.x - normBox.min.x;
        group.userData.originalDepth = normBox.max.z - normBox.min.z;

        // Place object without overlapping existing objects
        const myW = normBox.max.x - normBox.min.x;
        const myD = normBox.max.z - normBox.min.z;
        const GAP = 1; // minimum gap between objects
        const placed = this._findPlacement(myW, myD, GAP);
        group.position.x = placed.x;
        group.position.z = placed.z;

        group.visible = visible;
        group.userData.id = strId;

        this.scene.add(group);
        this.objects[strId] = group;

        resolve(group);
      }, undefined, (error) => {
        this._pendingLoads.delete(strId);
        reject(error);
      });
    });
  }

  /**
   * Remove an object from the scene
   * @param {number} id - Object identifier
   */
  removeObject(id) {
    const strId = String(id);
    const obj = this.objects[strId];
    if (obj) {
      if (this.selectedId === strId) {
        this.selectObject(null);
      }
      this.scene.remove(obj);
      delete this.objects[strId];
    }
  }

  /**
   * Set object visibility
   * @param {number} id - Object identifier
   * @param {boolean} visible - Visibility state
   */
  setVisibility(id, visible) {
    const strId = String(id);
    if (this.objects[strId]) {
      this.objects[strId].visible = visible;
      // Detach gizmo if hiding the currently selected object
      if (!visible && this.selectedId === strId) {
        this.transformControls.detach();
      }
    }
  }

  /**
   * Sync objects with a state object
   * Loads new objects, removes deleted ones, updates visibility
   * @param {Object} loadedObjects - { id: { glbUrl, visible } }
   */
  syncObjects(loadedObjects) {
    const currentIds = new Set(Object.keys(loadedObjects).map(String));
    const existingIds = new Set(Object.keys(this.objects));

    // Remove deleted objects
    existingIds.forEach((id) => {
      if (!currentIds.has(id)) {
        this.removeObject(id);
      }
    });

    // Load new objects, update existing
    const loadPromises = [];
    Object.entries(loadedObjects).forEach(([id, data]) => {
      const strId = String(id);
      if (!this.objects[strId] && data.glbUrl) {
        const p = this.loadObject(strId, data.glbUrl, data.visible !== false, data.brightnessDepth || 0).then(() => {
          // Apply saved transform after the model has loaded
          if (data.transform) {
            this.applyTransform(strId, data.transform);
          }
        });
        loadPromises.push(p);
      } else if (this.objects[strId]) {
        this.setVisibility(strId, data.visible !== false);
      }
    });

    // Fire callback when all new loads complete
    if (loadPromises.length > 0 && this._onObjectsReady) {
      Promise.all(loadPromises).then(() => this._onObjectsReady());
    }
  }

  /**
   * Swap the 3D model inside an existing group, preserving its transform.
   * @param {string|number} id - Object identifier
   * @param {string} url - URL to the new GLB file
   * @returns {Promise} Resolves when the new model is loaded
   */
  /**
   * @param {'height'|'width'|'original'} scaleMode
   * @param {number} originYRotationDeg - Y-rotation of the origin anchor (sv=0), used to compute reference width
   */
  _applyGltfToGroup(gltf, group, yRotationDeg, scaleMode, originYRotationDeg, brightnessDepth, manualBrightness) {
    // Dispose and remove old children
    while (group.children.length > 0) {
      const child = group.children[0];
      child.traverse((node) => {
        if (node.isMesh) {
          if (node.geometry) node.geometry.dispose();
          if (node.material) {
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            materials.forEach((mat) => {
              Object.values(mat).forEach((val) => {
                if (val && typeof val.dispose === 'function') val.dispose();
              });
              mat.dispose();
            });
          }
        }
      });
      group.remove(child);
    }

    // Add new model, scale based on scaleMode, ground-level it
    const model = gltf.scene.clone();
    // Deep-clone materials so brightness adjustments don't mutate the cached GLTF
    model.traverse((node) => {
      if (node.isMesh) {
        node.material = Array.isArray(node.material)
          ? node.material.map(m => m.clone())
          : node.material.clone();
      }
    });
    const box = new THREE.Box3().setFromObject(model);
    if (scaleMode === 'height') {
      const newHeight = box.max.y - box.min.y;
      const origHeight = group.userData.originalHeight;
      if (origHeight && newHeight > 0) {
        const s = origHeight / newHeight;
        model.scale.set(s, s, s);
      }
    } else if (scaleMode === 'width') {
      // Effective X-width after Y-rotation: |W*cos(r)| + |D*sin(r)|
      const origW = group.userData.originalWidth;
      const origD = group.userData.originalDepth;
      const origRad = THREE.MathUtils.degToRad(originYRotationDeg);
      const effectiveOrigWidth = Math.abs(origW * Math.cos(origRad)) + Math.abs(origD * Math.sin(origRad));

      const newW = box.max.x - box.min.x;
      const newD = box.max.z - box.min.z;
      const newRad = THREE.MathUtils.degToRad(yRotationDeg);
      const effectiveNewWidth = Math.abs(newW * Math.cos(newRad)) + Math.abs(newD * Math.sin(newRad));

      if (effectiveOrigWidth && effectiveNewWidth > 0) {
        const s = effectiveOrigWidth / effectiveNewWidth;
        model.scale.set(s, s, s);
      }
    }
    // scaleMode === 'original': no scaling
    // Apply per-variant Y-rotation correction (on the child model, not the group)
    model.rotation.y = THREE.MathUtils.degToRad(yRotationDeg);

    // Apply per-variant brightness boost for reconstructed variants
    if (brightnessDepth > 0) {
      applyMaterialBrightness(model, 1.0 + BRIGHTNESS_BOOST_PER_DEPTH * (1 - Math.pow(BRIGHTNESS_DECAY, brightnessDepth)) / (1 - BRIGHTNESS_DECAY));
    }
    // Save depth-boosted colors as _origColor BEFORE manual brightness,
    // so setObjectBrightness has a clean baseline to work from.
    model.traverse((node) => {
      if (!node.isMesh) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((mat) => {
        if (!mat.color) return;
        if (!mat.userData) mat.userData = {};
        mat.userData._origColor = mat.color.clone();
      });
    });
    // Apply per-anchor manual brightness
    if (manualBrightness !== 1.0) {
      applyMaterialBrightness(model, manualBrightness);
    }
    // Store for setObjectBrightness interactive use
    group.userData.manualBrightness = manualBrightness;

    // Recompute bounding box after rotation and re-center on all axes
    // so the model stays grounded (Y) and centered (X-Z) within the group.
    const scaledBox = new THREE.Box3().setFromObject(model);
    model.position.x = -(scaledBox.min.x + scaledBox.max.x) / 2;
    model.position.z = -(scaledBox.min.z + scaledBox.max.z) / 2;
    // Recompute after X-Z shift so Y grounding is accurate
    const groundBox = new THREE.Box3().setFromObject(model);
    model.position.y = -groundBox.min.y;
    group.add(model);
  }

  swapModel(id, url, yRotationDeg = 0, scaleMode = 'height', originYRotationDeg = 0, brightnessDepth = 0, manualBrightness = 1.0) {
    const strId = String(id);
    const group = this.objects[strId];
    if (!group) return Promise.reject(new Error(`Object ${strId} not found`));

    // Bump version so any in-flight loads for this object are discarded
    const version = (this._swapVersion[strId] || 0) + 1;
    this._swapVersion[strId] = version;

    // Check in-memory GLTF cache (keyed by base URL without cache-buster)
    const cached = this._gltfCache[url];
    if (cached) {
      this._applyGltfToGroup(cached, group, yRotationDeg, scaleMode, originYRotationDeg, brightnessDepth, manualBrightness);
      return Promise.resolve(group);
    }

    // Bust Three.js internal cache to ensure fresh network loads
    const bustUrl = url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
    return new Promise((resolve, reject) => {
      this.loader.load(bustUrl, (gltf) => {
        // Stale load — a newer swap was requested while this was in flight
        if (this._swapVersion[strId] !== version) {
          // Still cache it — the user may come back to this anchor
          this._gltfCache[url] = gltf;
          resolve(group);
          return;
        }

        // Cache the loaded GLTF for instant revisits
        this._gltfCache[url] = gltf;

        this._applyGltfToGroup(gltf, group, yRotationDeg, scaleMode, originYRotationDeg, brightnessDepth, manualBrightness);
        resolve(group);
      }, undefined, (error) => {
        reject(error);
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API - Selection & Transform
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Select an object (attach transform gizmo)
   * @param {number|null} id - Object ID or null to deselect
   */
  selectObject(id) {
    const strId = id !== null && id !== undefined ? String(id) : null;
    this.selectedId = strId;

    if (strId !== null && this.objects[strId]) {
      this.transformControls.attach(this.objects[strId]);
      this._reportTransform(this.objects[strId]);
    } else {
      this.transformControls.detach();
    }
  }

  /**
   * Set the transform gizmo mode
   * @param {'translate'|'rotate'|'scale'} mode
   */
  setGizmoMode(mode) {
    this.transformControls.setMode(mode);
  }

  /**
   * Apply a transform to the selected object
   * @param {'position'|'rotation'|'scale'} type
   * @param {{x: number, y: number, z: number}} value
   */
  setTransform(type, value) {
    if (this.selectedId === null || !this.objects[String(this.selectedId)]) return;

    const obj = this.objects[String(this.selectedId)];
    
    if (type === 'position') {
      obj.position.set(value.x, value.y, value.z);
    } else if (type === 'rotation') {
      obj.rotation.set(
        THREE.MathUtils.degToRad(value.x),
        THREE.MathUtils.degToRad(value.y),
        THREE.MathUtils.degToRad(value.z)
      );
    } else if (type === 'scale') {
      obj.scale.set(value.x, value.y, value.z);
    }
  }

  /**
   * Get the transform of an object
   * @param {number} id - Object ID
   * @returns {Object|null} { position, rotation, scale } or null
   */
  getTransform(id) {
    const obj = this.objects[String(id)];
    if (!obj) return null;

    return {
      position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
      rotation: {
        x: THREE.MathUtils.radToDeg(obj.rotation.x),
        y: THREE.MathUtils.radToDeg(obj.rotation.y),
        z: THREE.MathUtils.radToDeg(obj.rotation.z)
      },
      scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z }
    };
  }

  /**
   * Get transforms for all loaded objects
   * @returns {Object} { id: { position, rotation, scale } }
   */
  getAllTransforms() {
    const result = {};
    for (const [id, obj] of Object.entries(this.objects)) {
      result[id] = {
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotation: {
          x: THREE.MathUtils.radToDeg(obj.rotation.x),
          y: THREE.MathUtils.radToDeg(obj.rotation.y),
          z: THREE.MathUtils.radToDeg(obj.rotation.z)
        },
        scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z }
      };
    }
    return result;
  }

  /**
   * Get the stored target luminance for an object (used for forking).
   */
  /**
   * Set per-object manual brightness multiplier.
   * Re-loads the current model's materials with the combined depth + manual factor.
   * @param {string|number} id - Object ID
   * @param {number} factor - Brightness multiplier (1.0 = no change)
   */
  setObjectBrightness(id, factor) {
    const strId = String(id);
    const group = this.objects[strId];
    if (!group) return;
    group.userData.manualBrightness = factor;
    // Re-apply brightness to the current model's materials by reloading colors
    // from the original. Since we can't easily undo multiplyScalar, store
    // original colors on first call, then re-apply from scratch.
    const model = group.children[0];
    if (!model) return;
    model.traverse((node) => {
      if (!node.isMesh) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((mat) => {
        if (!mat.color) return;
        // Save original color on first call
        if (!mat.userData) mat.userData = {};
        if (!mat.userData._origColor) {
          mat.userData._origColor = mat.color.clone();
        }
        // Reset to original, then apply depth boost + manual factor
        mat.color.copy(mat.userData._origColor);
        if (factor !== 1.0) {
          mat.color.multiplyScalar(factor);
        }
        mat.needsUpdate = true;
      });
    });
  }

  /**
   * Apply a full transform (position, rotation, scale) to an object by ID
   * @param {string|number} id
   * @param {Object} transform - { position: {x,y,z}, rotation: {x,y,z} (deg), scale: {x,y,z} }
   */
  applyTransform(id, transform) {
    const obj = this.objects[String(id)];
    if (!obj || !transform) return;
    if (transform.position) {
      obj.position.set(transform.position.x, transform.position.y, transform.position.z);
    }
    if (transform.rotation) {
      obj.rotation.set(
        THREE.MathUtils.degToRad(transform.rotation.x),
        THREE.MathUtils.degToRad(transform.rotation.y),
        THREE.MathUtils.degToRad(transform.rotation.z)
      );
    }
    if (transform.scale) {
      obj.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API - Scene Settings (Background, Lighting, Grid)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set the background color
   * @param {string|number} color - Hex color string '#f0f0f0' or number 0xf0f0f0
   */
  setBackgroundColor(color) {
    this.scene.background = new THREE.Color(color);
  }

  /**
   * Get the current background color
   * @returns {string} Hex color string
   */
  getBackgroundColor() {
    return '#' + this.scene.background.getHexString();
  }

  /**
   * Set ambient light intensity
   * @param {number} intensity - Light intensity (0 to 5)
   */
  setAmbientIntensity(intensity) {
    this.ambientLight.intensity = intensity;
  }

  /**
   * Set main directional light intensity
   * @param {number} intensity - Light intensity (0 to 5)
   */
  setMainLightIntensity(intensity) {
    this.mainLight.intensity = intensity;
  }

  /**
   * Set tone mapping exposure (brightness)
   * @param {number} exposure - Exposure value (0.1 to 5)
   */
  setExposure(exposure) {
    this.renderer.toneMappingExposure = exposure;
  }

  /**
   * Set grid visibility
   * @param {boolean} visible
   */
  setGridVisible(visible) {
    if (!this.gridHelper) {
      // Find the grid in scene children
      this.gridHelper = this.scene.children.find(c => c instanceof THREE.GridHelper);
    }
    if (this.gridHelper) {
      this.gridHelper.visible = visible;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API - Event Callbacks
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set callback for object selection
   * @param {function(number|null)} callback - Called with object ID or null
   */
  onSelect(callback) {
    this._onSelect = callback;
  }

  /**
   * Set callback for transform changes
   * @param {function({position, rotation, scale})} callback
   */
  onTransformChange(callback) {
    this._onTransformChange = callback;
  }

  onTransformDragEnd(callback) {
    this._onTransformDragEnd = callback;
  }

  /**
   * Set callback for when all objects from a syncObjects call finish loading
   * @param {function()} callback
   */
  onObjectsReady(callback) {
    this._onObjectsReady = callback;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Dispose of all resources
   * Call this when the viewer is no longer needed
   */
  dispose() {
    // Stop animation loop
    if (this._animationId) {
      cancelAnimationFrame(this._animationId);
    }

    // Remove event listeners
    window.removeEventListener('resize', this._boundResize);

    // Dispose Three.js resources
    this.transformControls.dispose();
    this.orbitControls.dispose();
    this.renderer.dispose();

    // Remove canvas
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }

    // Clear references
    this.objects = {};
    this._pendingLoads.clear();
    this.scene = null;
    this.camera = null;
    this.renderer = null;
  }
}
