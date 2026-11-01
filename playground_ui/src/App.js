import React, { useState, useCallback, useRef, useEffect } from 'react';
import Header from './components/Header';
import ImagePanel from './components/ImagePanel';
import Sidebar from './components/Sidebar';
import TransformPanel from './components/TransformPanel';
import ContextMenu from './components/ContextMenu';
import LoginModal from './components/LoginModal';
import Viewer3D from './components/Viewer3D';
import TextTo3DModal from './components/TextTo3DModal';
import StatusBanner from './components/StatusBanner';
import SliderPanel from './components/SliderPanel';
import { io } from 'socket.io-client';
import { initLogger, logBehavior } from './utils/behaviorLogger';

function App() {
  // Session state
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [showLoginModal, setShowLoginModal] = useState(true);
  
  // Image state
  const [currentImageFilename, setCurrentImageFilename] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [points, setPoints] = useState([]);
  const [labels, setLabels] = useState([]);
  
  // Gallery state
  const [galleryItems, setGalleryItems] = useState([]);
  const [selectedGalleryItems, setSelectedGalleryItems] = useState(new Set());
  
  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isImagePanelOpen, setIsImagePanelOpen] = useState(true);
  
  // 3D state
  const [loadedObjects, setLoadedObjects] = useState({});
  const [selectedObject, setSelectedObject] = useState(null);
  const [gizmoMode, setGizmoMode] = useState('translate');
  const [selectedObjectTransform, setSelectedObjectTransform] = useState(null);
  const [transformInputChange, setTransformInputChange] = useState(null);
  
  // Text-to-3D state
  const [showTextTo3DModal, setShowTextTo3DModal] = useState(false);
  const [isTextTo3DLoading, setIsTextTo3DLoading] = useState(false);

  // Status banner
  const [statusMessage, setStatusMessage] = useState(null);

  // Slider state: { objectId: [{ object, attribute }, ...] }
  const [objectSliders, setObjectSliders] = useState({});
  // Set of objectIdx values currently having sliders built (supports multiple concurrent)
  const [creatingSlidersFor, setCreatingSlidersFor] = useState(new Set());
  const [sliderProgressMap, setSliderProgressMap] = useState({}); // { objectIdx: { step, message, skipped } }
  const socketRef = useRef(null);
  const [swapModelRequest, setSwapModelRequest] = useState(null);
  const [sliderScaleMode, setSliderScaleMode] = useState('height'); // 'height' | 'width' | 'original'
  const [useOriginalOrigin, setUseOriginalOrigin] = useState(true); // true = use original GLB at sv=0
  // Per-object brightness with two keys: 'origin' (base GLB) and 'variant' (all anchor variants)
  const [objectBrightness, setObjectBrightness] = useState({}); // { objectId: { origin: f, variant: f } }
  const [currentBrightnessMode, setCurrentBrightnessMode] = useState({}); // { objectId: 'origin'|'variant' }
  // Track in-flight anchor additions: { requestId: { sliderIndex, objectIdx } }
  const addingAnchorsRef = useRef({});
  const [addingAnchors, setAddingAnchors] = useState({}); // same shape, triggers re-renders
  // Max concurrent slider jobs (must match backend POOL_CONFIGS length)
  const MAX_CONCURRENT_SLIDERS = 2;
  // Track active slider jobs: { requestId: { objectIdx, isResume } }
  const pendingSliderRef = useRef({});
  // Track which objects we've already fetched slider data for
  const fetchedSlidersRef = useRef(new Set());
  // Current slider anchor per object per slider: { objectId: { sliderIndex: svString } }
  const sliderAnchorMapRef = useRef({});
  // Saved object_states from session resume (includes sliderAnchors)
  const savedObjectStatesRef = useRef(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, objectIdx: null });
  
  // Scene settings state - defaults match original index.html
  const [sceneSettings, setSceneSettings] = useState({
    backgroundColor: '#f0f0f0',
    showGrid: true,
    ambientIntensity: 1.5,
    mainLightIntensity: 2.5,
    exposure: 3.0
  });
  // Refs
  const fileInputRef = useRef(null);
  const lastTransformRef = useRef(null);
  const selectedObjectRef = useRef(selectedObject);
  const gizmoModeRef = useRef(gizmoMode);
  const viewer3DRef = useRef(null);
  const saveTimerRef = useRef(null);
  const loadedObjectsRef = useRef(loadedObjects);

  const resolveVariantUrlRef = useRef(null);
  const sliderScaleModeRef = useRef(sliderScaleMode);
  const useOriginalOriginRef = useRef(useOriginalOrigin);
  const currentSessionIdRef = useRef(currentSessionId);
  const currentUserIdRef = useRef(currentUserId);

  // Keep refs in sync with state
  useEffect(() => { selectedObjectRef.current = selectedObject; }, [selectedObject]);
  useEffect(() => { gizmoModeRef.current = gizmoMode; }, [gizmoMode]);
  useEffect(() => { loadedObjectsRef.current = loadedObjects; }, [loadedObjects]);
  useEffect(() => { sliderScaleModeRef.current = sliderScaleMode; }, [sliderScaleMode]);
  useEffect(() => { useOriginalOriginRef.current = useOriginalOrigin; }, [useOriginalOrigin]);
  useEffect(() => { currentSessionIdRef.current = currentSessionId; }, [currentSessionId]);
  useEffect(() => { currentUserIdRef.current = currentUserId; }, [currentUserId]);

  // Sync 3D selection to sidebar: selecting an object in the viewer highlights it in the gallery
  useEffect(() => {
    if (selectedObject != null) {
      const id = isNaN(selectedObject) ? selectedObject : Number(selectedObject);
      setSelectedGalleryItems(new Set([id]));
    }
  }, [selectedObject]);

  // Wrap transform change to track latest value in ref
  const handleTransformChange = useCallback((transform) => {
    lastTransformRef.current = transform;
    setSelectedObjectTransform(transform);
  }, []);

  // Ref to hold latest save function (avoids stale closure in handleTransformDragEnd)
  const saveObjectStatesRef = useRef(null);

  // Debounced save of all object transforms + visibility to backend.
  // Reads loadedObjects from ref so it always gets the latest state,
  // even when called right after a setState that hasn't been applied yet.
  const saveObjectStates = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (!currentSessionId || !currentUserId || !viewer3DRef.current) return;
      const transforms = viewer3DRef.current.getAllTransforms();
      const currentLoadedObjects = loadedObjectsRef.current;
      const objectStates = {};
      for (const [id, data] of Object.entries(currentLoadedObjects)) {
        objectStates[id] = {
          visible: data.visible !== false,
          transform: transforms[id] || null,
          sliderAnchors: sliderAnchorMapRef.current[id] || null,
          brightnessDepth: data.brightnessDepth || 0,
        };
      }
      fetch('/save_object_states', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSessionId,
          user_id: currentUserId,
          object_states: objectStates,
        }),
      }).catch(e => console.warn('Failed to save object states:', e));
    }, 500);
  }, [currentSessionId, currentUserId]);

  // Keep ref in sync
  useEffect(() => { saveObjectStatesRef.current = saveObjectStates; }, [saveObjectStates]);

  // Stable callback (no deps) — reads from ref so it works even though
  // Viewer3DCore captures it once at mount time.
  const handleTransformDragEnd = useCallback(() => {
    if (saveObjectStatesRef.current) saveObjectStatesRef.current();
  }, []);

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(prev => ({ ...prev, visible: false }));
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // Socket.IO connection to trellis server
  useEffect(() => {
    const socket = io();
    socketRef.current = socket;

    socket.on('slider_progress', (data) => {
      const reqId = data.request_id;
      const pending = pendingSliderRef.current[reqId];
      if (pending) {
        setSliderProgressMap(prev => ({ ...prev, [pending.objectIdx]: { ...data, sliderName: prev[pending.objectIdx]?.sliderName } }));
      }
    });

    socket.on('slider_complete', (data) => {
      const reqId = data.request_id;
      const pending = pendingSliderRef.current[reqId];
      if (pending) {
        const completeSlider = {
          slider_index: data.slider_index,
          object: data.object,
          attribute: data.attribute,
          neg_prompt: data.neg_prompt,
          pos_prompt: data.pos_prompt,
          anchors: data.anchors || [],
          glb_filename: data.glb_filename,
          complete: true,
        };

        setObjectSliders(prev => {
          const existing = prev[pending.objectIdx] || [];
          if (pending.isResume) {
            return {
              ...prev,
              [pending.objectIdx]: existing.map(s =>
                s.slider_index === data.slider_index ? completeSlider : s
              )
            };
          }
          return {
            ...prev,
            [pending.objectIdx]: [...existing, completeSlider]
          };
        });
        setSliderProgressMap(prev => {
          const next = { ...prev };
          delete next[pending.objectIdx];
          return next;
        });
        // Remove this pending entry and update creatingSlidersFor
        delete pendingSliderRef.current[reqId];
        setCreatingSlidersFor(prev => {
          const next = new Set(prev);
          // Only remove from set if no other pending job targets the same object
          const stillCreating = Object.values(pendingSliderRef.current).some(p => p.objectIdx === pending.objectIdx);
          if (!stillCreating) next.delete(pending.objectIdx);
          return next;
        });
      }
    });

    socket.on('slider_error', (data) => {
      alert('Slider error: ' + data.error);
      const reqId = data.request_id;
      const pending = pendingSliderRef.current[reqId];
      if (pending) {
        setSliderProgressMap(prev => {
          const next = { ...prev };
          delete next[pending.objectIdx];
          return next;
        });
        delete pendingSliderRef.current[reqId];
        setCreatingSlidersFor(prev => {
          const next = new Set(prev);
          const stillCreating = Object.values(pendingSliderRef.current).some(p => p.objectIdx === pending.objectIdx);
          if (!stillCreating) next.delete(pending.objectIdx);
          return next;
        });
      }
    });

    socket.on('anchor_point_complete', (data) => {
      const reqId = data.request_id;
      const pending = addingAnchorsRef.current[reqId];
      if (pending) {
        setObjectSliders(prevSliders => {
          const targetObj = String(pending.objectIdx);
          const updated = { ...prevSliders };
          if (updated[targetObj]) {
            updated[targetObj] = updated[targetObj].map(s =>
              s.slider_index === data.slider_index ? { ...s, anchors: data.anchors } : s
            );
          }
          return updated;
        });
        delete addingAnchorsRef.current[reqId];
        setAddingAnchors({ ...addingAnchorsRef.current });
      }
    });

    socket.on('anchor_point_error', (data) => {
      alert('Anchor point error: ' + data.error);
      const reqId = data.request_id;
      if (addingAnchorsRef.current[reqId]) {
        delete addingAnchorsRef.current[reqId];
        setAddingAnchors({ ...addingAnchorsRef.current });
      }
    });

    return () => socket.disconnect();
  }, []);

  // Resolve the correct GLB URL for a slider variant (server-side check, no 404 noise)
  const resolveVariantUrl = useCallback((glbFilename, sliderIndex, sliderValue) => {
    return fetch('/resolve_variant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: currentSessionId,
        user_id: currentUserId,
        glb_filename: glbFilename,
        slider_index: sliderIndex,
        slider_value: sliderValue,
        use_original: useOriginalOrigin,
      })
    }).then(r => r.json()).then(data => data.url);
  }, [currentSessionId, currentUserId, useOriginalOrigin]);

  // Keep resolveVariantUrl ref in sync
  useEffect(() => { resolveVariantUrlRef.current = resolveVariantUrl; }, [resolveVariantUrl]);

  // Fetch existing sliders from backend when an object is first selected
  useEffect(() => {
    if (!selectedObject || !loadedObjects[selectedObject] || !currentSessionId || !currentUserId) return;
    if (fetchedSlidersRef.current.has(selectedObject)) return;

    fetchedSlidersRef.current.add(selectedObject);
    const glbFilename = loadedObjects[selectedObject].glbUrl.split('/').pop();

    fetch('/trellis/get_sliders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: currentSessionId,
        user_id: currentUserId,
        glb_filename: glbFilename,
      })
    })
      .then(r => r.json())
      .then(data => {
        if (data.sliders && data.sliders.length > 0) {
          setObjectSliders(prev => ({
            ...prev,
            [selectedObject]: data.sliders,
          }));

          // Auto-correct origin toggle if only one option is available
          const firstComplete = data.sliders.find(s => s.complete);
          if (firstComplete) {
            const hasOrig = firstComplete.has_original !== false;
            const hasRecon = firstComplete.has_origin_recon === true;
            if (!hasOrig && hasRecon) setUseOriginalOrigin(false);
            else if (hasOrig && !hasRecon) setUseOriginalOrigin(true);
          }

          // Restore saved slider anchor positions, or apply origin Y-rotation.
          // Process the last slider that has a saved anchor or a non-zero origin rotation,
          // since only one model swap can be active at a time.
          const savedAnchors = sliderAnchorMapRef.current[selectedObject] || {};
          let applied = false;
          for (const slider of data.sliders) {
            if (!slider.complete || !slider.anchors) continue;
            const savedEntry = savedAnchors[slider.slider_index];
            const savedSv = savedEntry ? (typeof savedEntry === 'object' ? savedEntry.sv : savedEntry) : null;
            const originAnchor = slider.anchors.find(a => parseFloat(a[0]) === 0);
            const originYRotation = originAnchor ? (originAnchor[2] || 0) : 0;

            if (savedSv != null) {
              // Restore to the saved anchor position
              const anchor = slider.anchors.find(a => a[0] === String(savedSv));
              if (anchor) {
                // If at origin with useOriginalOrigin, the original GLB is already loaded — skip swap
                if (parseFloat(anchor[0]) === 0 && useOriginalOrigin) {
                  applied = true;
                  break;
                }
                const yRot = anchor[2] || 0;
                const objDepth = loadedObjects[selectedObject]?.brightnessDepth || 0;
                resolveVariantUrl(slider.glb_filename, slider.slider_index, anchor[0]).then(url => {
                  setSwapModelRequest({ id: selectedObject, url, yRotation: yRot, scaleMode: sliderScaleMode, originYRotation, brightnessDepth: objDepth + 1 });
                });
                applied = true;
                break;
              }
            }

            // No saved anchor — apply origin Y-rotation if non-zero and not using original
            if (!applied && originYRotation !== 0 && !useOriginalOrigin) {
              const objDepth2 = loadedObjects[selectedObject]?.brightnessDepth || 0;
              resolveVariantUrl(slider.glb_filename, slider.slider_index, '0.00000').then(url => {
                setSwapModelRequest({ id: selectedObject, url, yRotation: originYRotation, scaleMode: sliderScaleMode, originYRotation, brightnessDepth: objDepth2 + 1 });
              });
              applied = true;
              break;
            }
          }
        }
      })
      .catch(e => console.error('Failed to fetch sliders:', e));
  }, [selectedObject, loadedObjects, currentSessionId, currentUserId, resolveVariantUrl, sliderScaleMode]);

  // Session handlers
  const handleSessionStart = useCallback((sessionId, userId, galleryData = [], imageFilename = null, objectStates = null) => {
    initLogger(sessionId, userId);
    logBehavior(galleryData.length > 0 ? 'resume_session' : 'start_new_session', { sessionId, userId });
    setCurrentSessionId(sessionId);
    setCurrentUserId(userId);
    setShowLoginModal(false);
    fetchedSlidersRef.current = new Set();
    setObjectSliders({});
    pendingSliderRef.current = {};
    setCreatingSlidersFor(new Set());
    setSliderProgressMap({});
    savedObjectStatesRef.current = objectStates;
    appliedResumeAnchorsRef.current = false;

    // Restore slider anchor positions from saved state
    sliderAnchorMapRef.current = {};
    if (objectStates) {
      for (const [id, state] of Object.entries(objectStates)) {
        if (state.sliderAnchors) {
          sliderAnchorMapRef.current[id] = state.sliderAnchors;
        }
      }
    }

    if (imageFilename) {
      setImageUrl(`/uploads/${sessionId}/${imageFilename}`);
      setCurrentImageFilename(imageFilename);
    }

    if (galleryData.length > 0) {
      setGalleryItems(galleryData);
      setIsImagePanelOpen(false);
      // Load 3D models for items that have them, restoring saved transforms/visibility
      const objectsToLoad = {};
      galleryData.forEach(item => {
        if (item.has_3d && item.glb_url) {
          const saved = objectStates && objectStates[String(item.object_index)];
          objectsToLoad[item.object_index] = {
            glbUrl: item.glb_url,
            visible: saved ? saved.visible !== false : true,
            transform: saved ? saved.transform : null,
            brightnessDepth: saved?.brightnessDepth
              ?? (String(item.object_index).startsWith('fork_') ? 1 : 0),
          };
        }
      });
      setLoadedObjects(objectsToLoad);
    }

    localStorage.setItem('lastUserId', userId);
  }, []);

  // Stable callback fired by Viewer3DCore after all GLB models finish loading.
  // On session resume, applies saved slider anchors for all objects.
  const appliedResumeAnchorsRef = useRef(false);
  const handleObjectsReady = useCallback(() => {
    if (appliedResumeAnchorsRef.current) return;
    const anchorsMap = sliderAnchorMapRef.current;
    if (!anchorsMap || Object.keys(anchorsMap).length === 0) return;
    const currentLoaded = loadedObjectsRef.current;
    if (Object.keys(currentLoaded).length === 0) return;

    appliedResumeAnchorsRef.current = true;
    const resolve = resolveVariantUrlRef.current;
    if (!resolve) return;

    // For each object with saved anchors, fetch its slider data from backend,
    // then resolve the variant URL and apply the swap.
    // This handles both old format (plain sv string) and new format ({sv, glbFilename, ...}).
    const objectsWithAnchors = Object.entries(anchorsMap).filter(([objId]) => currentLoaded[objId]);
    const fetchPromises = objectsWithAnchors.map(([objId, sliderAnchors]) => {
      const glbFilename = currentLoaded[objId].glbUrl.split('/').pop();
      // Mark as fetched so the per-click useEffect doesn't re-fetch
      fetchedSlidersRef.current.add(objId);

      return fetch('/trellis/get_sliders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSessionIdRef.current,
          user_id: currentUserIdRef.current,
          glb_filename: glbFilename,
        })
      })
        .then(r => r.json())
        .then(data => ({ objId, sliderAnchors, sliders: data.sliders || [] }))
        .catch(() => null);
    });

    Promise.all(fetchPromises).then(results => {
      const swaps = [];
      for (const result of results) {
        if (!result || result.sliders.length === 0) continue;
        const { objId, sliderAnchors, sliders } = result;

        // Populate objectSliders so the UI shows them without needing a click
        setObjectSliders(prev => ({ ...prev, [objId]: sliders }));

        for (const slider of sliders) {
          if (!slider.complete || !slider.anchors) continue;
          const savedEntry = sliderAnchors[slider.slider_index];
          if (savedEntry == null) continue;
          const savedSv = typeof savedEntry === 'object' ? savedEntry.sv : savedEntry;
          if (savedSv == null) continue;

          const anchor = slider.anchors.find(a => a[0] === String(savedSv));
          if (!anchor) continue;
          // If at origin with useOriginalOrigin, the original GLB is already loaded
          if (parseFloat(anchor[0]) === 0 && useOriginalOriginRef.current) continue;

          const originAnchor = slider.anchors.find(a => parseFloat(a[0]) === 0);
          const originYRotation = originAnchor ? (originAnchor[2] || 0) : 0;
          const yRot = anchor[2] || 0;

          swaps.push({
            objId,
            glbFilename: slider.glb_filename,
            sliderIndex: slider.slider_index,
            sv: anchor[0],
            yRotation: yRot,
            originYRotation,
            brightnessDepth: (currentLoaded[objId]?.brightnessDepth || 0) + 1,
          });
          break; // One swap per object (last active slider wins)
        }
      }

      // Apply swaps sequentially with delays
      swaps.forEach((swap, i) => {
        resolve(swap.glbFilename, swap.sliderIndex, swap.sv).then(url => {
          setTimeout(() => {
            setSwapModelRequest({
              id: swap.objId,
              url,
              yRotation: swap.yRotation,
              scaleMode: sliderScaleModeRef.current,
              originYRotation: swap.originYRotation,
              brightnessDepth: swap.brightnessDepth,
            });
          }, i * 200);
        });
      });
    });
  }, []); // Stable callback — reads session/user from refs

  // File upload handler
  const handleFileUpload = useCallback(async (file) => {
    if (!currentSessionId) {
      alert('Please start a session first');
      setShowLoginModal(true);
      return;
    }
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('session_id', currentSessionId);
    
    setIsLoading(true);
    try {
      const response = await fetch('/upload', { method: 'POST', body: formData });
      const data = await response.json();
      
      if (data.error) {
        alert('Error: ' + data.error);
        return;
      }
      
      if (data.filepath) {
        logBehavior('upload_image', { filename: data.filepath });
        setImageUrl(`/uploads/${currentSessionId}/${data.filepath}`);
        setCurrentImageFilename(data.filepath);
        setPoints([]);
        setLabels([]);
        setSelectedGalleryItems(new Set());
        setIsImagePanelOpen(true);
      }
    } catch (error) {
      console.error('Error uploading:', error);
      alert('Upload failed');
    } finally {
      setIsLoading(false);
    }
  }, [currentSessionId]);

  // Segmentation handler
  const handleSegment = useCallback(async (newPoints, newLabels) => {
    if (!currentSessionId || !imageUrl) return;
    
    setIsLoading(true);
    try {
      const response = await fetch('/segment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: newPoints,
          labels: newLabels,
          session_id: currentSessionId
        })
      });
      const data = await response.json();
      if (data.image) {
        setImageUrl(`data:image/jpeg;base64,${data.image}`);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  }, [currentSessionId, imageUrl]);

  // Image click handler
  const handleImageClick = useCallback((x, y, isRightClick) => {
    const newPoints = [...points, [x, y]];
    const newLabels = [...labels, isRightClick ? 0 : 1];
    logBehavior('add_segmentation_point', { pointCoords: [x, y], label: isRightClick ? 'negative' : 'positive', totalPointCount: newPoints.length });
    setPoints(newPoints);
    setLabels(newLabels);
    handleSegment(newPoints, newLabels);
  }, [points, labels, handleSegment]);

  // Undo handler
  const handleUndo = useCallback(() => {
    if (points.length > 0) {
      const newPoints = points.slice(0, -1);
      const newLabels = labels.slice(0, -1);
      logBehavior('undo_point', { remainingPointCount: newPoints.length });
      setPoints(newPoints);
      setLabels(newLabels);
      handleSegment(newPoints, newLabels);
    }
  }, [points, labels, handleSegment]);

  // Reset handler. skipLog=true when called internally (e.g. from handleFinishObject)
  const handleReset = useCallback(async (skipLog = false) => {
    if (!skipLog) logBehavior('reset_points');
    setPoints([]);
    setLabels([]);
    setIsLoading(true);
    try {
      await fetch('/reset', { method: 'POST' });
      if (currentImageFilename && currentSessionId) {
        setImageUrl(`/uploads/${currentSessionId}/${currentImageFilename}`);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  }, [currentImageFilename, currentSessionId]);

  // Finish object handler
  const handleFinishObject = useCallback(async () => {
    if (points.length === 0) {
      alert("Define an object first!");
      return;
    }
    
    setIsLoading(true);
    try {
      const response = await fetch('/finish_object', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points,
          labels,
          session_id: currentSessionId
        })
      });
      const data = await response.json();
      
      if (data.object_image) {
        logBehavior('finish_object', { objectIndex: data.object_index, pointCount: points.length });
        setGalleryItems(prev => [...prev, {
          object_index: data.object_index,
          object_image: data.object_image,
          is_combined: data.is_combined || false,
          image_filename: currentImageFilename
        }]);
        setIsSidebarOpen(true);
        await handleReset(true);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  }, [points, labels, currentSessionId, currentImageFilename, handleReset]);

  // Gallery item click handler
  const handleGalleryItemClick = useCallback((idx, event) => {
    const isMultiSelect = event.ctrlKey || event.metaKey || event.shiftKey;
    if (isMultiSelect) {
      const newSet = new Set(selectedGalleryItems);
      if (newSet.has(idx)) {
        newSet.delete(idx);
      } else {
        newSet.add(idx);
      }
      logBehavior('select_gallery_item', { objectIndex: idx, isMultiSelect: true, selectedCount: newSet.size });
      setSelectedGalleryItems(newSet);
    } else {
      logBehavior('select_gallery_item', { objectIndex: idx, isMultiSelect: false, selectedCount: 1 });
      setSelectedGalleryItems(new Set([idx]));
    }
  }, [selectedGalleryItems]);

  // Context menu handler
  const handleContextMenu = useCallback((event, idx) => {
    event.preventDefault();
    event.stopPropagation();
    
    if (!selectedGalleryItems.has(idx)) {
      setSelectedGalleryItems(new Set([idx]));
    }
    
    setContextMenu({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      objectIdx: idx
    });
  }, [selectedGalleryItems]);

  // Trigger multi-view rendering on trellis server (synchronous, non-fatal)
  const triggerRenderViews = useCallback(async (glbFilename) => {
    setStatusMessage('Rendering multi-views...');
    try {
      await fetch('/trellis/render_views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSessionId,
          user_id: currentUserId,
          glb_filename: glbFilename,
        })
      });
    } catch (e) {
      console.error('Multi-view render error (non-fatal):', e);
    } finally {
      setStatusMessage(null);
    }
  }, [currentSessionId, currentUserId]);

  // Convert to 3D handler
  const handleConvertTo3D = useCallback(async (objectIdx) => {
    setContextMenu(prev => ({ ...prev, visible: false }));

    if (loadedObjects[objectIdx]) {
      return; // Already loaded
    }

    logBehavior('convert_to_3d', { objectIndex: objectIdx });
    setIsLoading(true);
    setStatusMessage('Generating 3D model...');
    try {
      const response = await fetch('/to_3d', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ object_index: objectIdx, session_id: currentSessionId })
      });

      const data = await response.json();
      if (data.glb_url) {
        setLoadedObjects(prev => ({
          ...prev,
          [objectIdx]: { glbUrl: data.glb_url, visible: true }
        }));
        setGalleryItems(prev => prev.map(item =>
          item.object_index === objectIdx ? { ...item, has_3d: true, glb_url: data.glb_url } : item
        ));
        setIsImagePanelOpen(false);
        setIsLoading(false);

        // Render multi-views in the background (non-blocking)
        const glbFilename = data.glb_url.split('/').pop();
        triggerRenderViews(glbFilename);
      } else if (data.error) {
        alert("Error: " + data.error);
        setIsLoading(false);
        setStatusMessage(null);
      }
    } catch (e) {
      console.error("3D Error:", e);
      alert("Failed to generate 3D model");
      setIsLoading(false);
      setStatusMessage(null);
    }
  }, [currentSessionId, loadedObjects, triggerRenderViews]);

  // Combine objects handler
  const handleCombineObjects = useCallback(async () => {
    if (selectedGalleryItems.size < 2) {
      alert("Select at least 2 objects to combine");
      return;
    }
    
    const indices = Array.from(selectedGalleryItems);
    setIsLoading(true);
    
    try {
      const response = await fetch('/combine_objects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indices, session_id: currentSessionId })
      });
      
      const data = await response.json();
      if (data.object_image) {
        logBehavior('combine_objects', { objectIndices: indices, newObjectIndex: data.object_index });
        // Remove old items and add new combined item
        setGalleryItems(prev => [
          ...prev.filter(item => !indices.includes(item.object_index)),
          {
            object_index: data.object_index,
            object_image: data.object_image,
            is_combined: true,
            image_filename: currentImageFilename
          }
        ]);
        
        // Remove 3D objects for combined items
        setLoadedObjects(prev => {
          const newObjects = { ...prev };
          indices.forEach(idx => delete newObjects[idx]);
          return newObjects;
        });
        
        setSelectedGalleryItems(new Set());
      }
    } catch (e) {
      console.error(e);
      alert("Combine failed");
    } finally {
      setIsLoading(false);
    }
  }, [selectedGalleryItems, currentSessionId, currentImageFilename]);

  // Delete objects handler
  const handleDeleteObjects = useCallback(async () => {
    if (selectedGalleryItems.size === 0) return;
    if (!window.confirm("Delete selected object(s)?")) return;
    
    const indices = Array.from(selectedGalleryItems);
    logBehavior('delete_objects', { objectIndices: indices });

    // Remove from gallery
    setGalleryItems(prev => prev.filter(item => !indices.includes(item.object_index)));
    
    // Remove 3D objects
    setLoadedObjects(prev => {
      const newObjects = { ...prev };
      indices.forEach(idx => delete newObjects[idx]);
      return newObjects;
    });
    
    setSelectedGalleryItems(new Set());
    setSelectedObject(null);
    
    // Notify backend
    indices.forEach(idx => {
      fetch('/delete_object', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ object_index: idx, session_id: currentSessionId })
      });
    });
  }, [selectedGalleryItems, currentSessionId]);

  // Text-to-3D handler (synchronous)
  const handleTextTo3DGenerate = useCallback(async (prompt, seed) => {
    if (!currentSessionId || !currentUserId) {
      alert('Please start a session first');
      return;
    }

    setIsTextTo3DLoading(true);
    setStatusMessage('Generating 3D model...');
    try {
      const response = await fetch('/trellis/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          seed,
          session_id: currentSessionId,
          user_id: currentUserId,
        })
      });

      const data = await response.json();
      if (data.error) {
        alert('Error: ' + data.error);
        return;
      }

      if (data.glb_url && data.object_id) {
        logBehavior('text_to_3d_generate', { prompt, seed, objectId: data.object_id });
        setGalleryItems(prev => [...prev, {
          object_index: data.object_id,
          source: 'trellis',
          prompt,
          is_combined: false,
          has_3d: true,
          glb_url: data.glb_url,
        }]);

        setLoadedObjects(prev => ({
          ...prev,
          [data.object_id]: { glbUrl: data.glb_url, visible: true }
        }));

        setIsSidebarOpen(true);
        setShowTextTo3DModal(false);
        setIsTextTo3DLoading(false);
        setStatusMessage(null);

        // Render multi-views in the background (non-blocking)
        const glbFilename = data.glb_url.split('/').pop();
        triggerRenderViews(glbFilename);
        return;
      }
    } catch (e) {
      console.error('Text-to-3D error:', e);
      alert('Failed to generate 3D model');
    } finally {
      setIsTextTo3DLoading(false);
      setStatusMessage(null);
    }
  }, [currentSessionId, currentUserId, triggerRenderViews]);

  // Toggle object visibility
  const handleToggleVisibility = useCallback((objectIdx) => {
    setLoadedObjects(prev => {
      const newVisibility = !prev[objectIdx]?.visible;
      logBehavior('toggle_3d_visibility', { objectIndex: objectIdx, newVisibility });
      return {
        ...prev,
        [objectIdx]: { ...prev[objectIdx], visible: newVisibility }
      };
    });
    setContextMenu(prev => ({ ...prev, visible: false }));
    // Save visibility state to backend (debounced).
    // The 500ms delay in saveObjectStates ensures loadedObjectsRef
    // has been updated by the time the save actually fires.
    saveObjectStates();
  }, [saveObjectStates]);

  // Create slider handler (via Socket.IO) with dedup check — supports concurrent jobs
  const handleCreateSlider = useCallback((objectIdx, objectText, attribute, numSamples = 4) => {
    if (!currentSessionId || !currentUserId || !socketRef.current) return;

    // Check if all pools are busy
    if (creatingSlidersFor.size >= MAX_CONCURRENT_SLIDERS) {
      alert(`All ${MAX_CONCURRENT_SLIDERS} GPU pools are busy. Please wait for a slider to finish.`);
      return 'busy';
    }

    const obj = loadedObjects[objectIdx];
    if (!obj) return;
    const glbFilename = obj.glbUrl.split('/').pop();
    const existingSliders = objectSliders[objectIdx] || [];

    // Check if this object+attribute pair already exists
    const match = existingSliders.find(
      s => s.object.toLowerCase() === objectText.toLowerCase() && s.attribute.toLowerCase() === attribute.toLowerCase()
    );

    // Generate a unique request_id for this job
    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (match) {
      if (match.complete && match.anchors && match.anchors.length > 0) {
        return 'exists';
      }
      // Incomplete — resume the build with the same slider_index
      logBehavior('resume_slider', { objectText, attributeText: attribute, sliderIndex: match.slider_index });
      pendingSliderRef.current[requestId] = { objectIdx, isResume: true };
      setCreatingSlidersFor(prev => new Set(prev).add(objectIdx));
      setSliderProgressMap(prev => ({ ...prev, [objectIdx]: { step: 0, message: 'Resuming...', sliderName: `${objectText} — ${attribute}` } }));

      socketRef.current.emit('create_slider', {
        glb_filename: glbFilename,
        object: objectText,
        attribute,
        slider_index: match.slider_index,
        num_samples: numSamples,
        session_id: currentSessionId,
        user_id: currentUserId,
        request_id: requestId,
      });
      return 'resuming';
    }

    // New slider — index is 1 + max existing index (or 0 if none)
    const sliderIndex = existingSliders.length > 0
      ? Math.max(...existingSliders.map(s => s.slider_index)) + 1
      : 0;

    logBehavior('create_slider', { objectText, attributeText: attribute, sliderIndex, glbFilename });
    pendingSliderRef.current[requestId] = { objectIdx, isResume: false };
    setCreatingSlidersFor(prev => new Set(prev).add(objectIdx));
    setSliderProgressMap(prev => ({ ...prev, [objectIdx]: { step: 0, message: 'Starting...', sliderName: `${objectText} — ${attribute}` } }));

    socketRef.current.emit('create_slider', {
      glb_filename: glbFilename,
      object: objectText,
      attribute,
      slider_index: sliderIndex,
      num_samples: numSamples,
      session_id: currentSessionId,
      user_id: currentUserId,
      request_id: requestId,
    });
    return 'creating';
  }, [currentSessionId, currentUserId, loadedObjects, objectSliders, creatingSlidersFor]);


  // Slider anchor change: swap 3D model to the variant at the selected anchor
  const handleSliderAnchorChange = useCallback((objectIdx, slider, anchorIndex) => {
    if (!currentSessionId) return;
    const anchor = slider.anchors[anchorIndex];
    if (!anchor) return;
    const yRotation = anchor[2] || 0;
    const originAnchor = slider.anchors.find(a => parseFloat(a[0]) === 0);
    const originYRotation = originAnchor ? (originAnchor[2] || 0) : 0;

    // Track current anchor position for persistence (store enough to replay swap on load)
    if (!sliderAnchorMapRef.current[objectIdx]) sliderAnchorMapRef.current[objectIdx] = {};
    sliderAnchorMapRef.current[objectIdx][slider.slider_index] = {
      sv: anchor[0],
      yRotation,
      originYRotation,
      glbFilename: slider.glb_filename,
    };
    // Debounced save to persist slider positions
    saveObjectStates();

    const isOriginAnchor = parseFloat(anchor[0]) === 0;
    const bMode = (isOriginAnchor && useOriginalOrigin) ? 'origin' : 'variant';
    setCurrentBrightnessMode(prev => ({ ...prev, [objectIdx]: bMode }));
    resolveVariantUrl(slider.glb_filename, slider.slider_index, anchor[0]).then(url => {
      logBehavior('move_slider', {
        sliderIndex: slider.slider_index,
        anchorValue: anchor[0],
        percentage: Math.round((anchor[1] * 200) - 100),
        objectText: slider.object,
        attributeText: slider.attribute,
        glbFilename: url.split('/').pop(),
      });
      const objDepth = loadedObjects[objectIdx]?.brightnessDepth || 0;
      const swapDepth = (isOriginAnchor && useOriginalOrigin) ? 0 : objDepth + 1;
      const mb = objectBrightness[objectIdx]?.[bMode] ?? 1.0;
      setSwapModelRequest({ id: objectIdx, url, yRotation, scaleMode: sliderScaleMode, originYRotation, brightnessDepth: swapDepth, manualBrightness: mb });
    });
  }, [currentSessionId, sliderScaleMode, resolveVariantUrl, saveObjectStates, loadedObjects, useOriginalOrigin, objectBrightness]);

  // Handle per-anchor Y-rotation change: persist + update local state + trigger swap
  const handleAnchorRotationChange = useCallback((objectIdx, slider, sliderValue, degrees) => {
    if (!currentSessionId || !currentUserId) return;

    const glbFilename = loadedObjects[objectIdx]?.glbUrl?.split('/').pop();
    if (!glbFilename) return;

    logBehavior('set_anchor_rotation', { sliderIndex: slider.slider_index, anchorValue: sliderValue, rotationDegrees: degrees });

    // Persist to backend
    fetch('/trellis/set_anchor_rotation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: currentSessionId,
        user_id: currentUserId,
        glb_filename: glbFilename,
        slider_index: slider.slider_index,
        slider_value: sliderValue,
        y_rotation: degrees,
      })
    }).catch(e => console.error('Failed to save anchor rotation:', e));

    // Update local slider state
    setObjectSliders(prev => {
      const updated = { ...prev };
      const sliders = (updated[objectIdx] || []).map(s => {
        if (s.slider_index !== slider.slider_index) return s;
        return {
          ...s,
          anchors: s.anchors.map(a =>
            a[0] === sliderValue ? [a[0], a[1], degrees] : a
          ),
        };
      });
      updated[objectIdx] = sliders;
      return updated;
    });

    // Trigger model swap with new rotation
    const isOrigin = parseFloat(sliderValue) === 0;
    const originAnchor = slider.anchors.find(a => parseFloat(a[0]) === 0);
    const originYRotation = isOrigin ? degrees : (originAnchor ? (originAnchor[2] || 0) : 0);

    // Update saved anchor data with new rotation
    const saved = sliderAnchorMapRef.current[objectIdx]?.[slider.slider_index];
    if (saved) {
      saved.yRotation = degrees;
      if (isOrigin) saved.originYRotation = degrees;
      saveObjectStates();
    }

    const rotObjDepth = loadedObjects[objectIdx]?.brightnessDepth || 0;
    const rotSwapDepth = (isOrigin && useOriginalOrigin) ? 0 : rotObjDepth + 1;
    const rotBMode = (isOrigin && useOriginalOrigin) ? 'origin' : 'variant';
    const rotMb = objectBrightness[objectIdx]?.[rotBMode] ?? 1.0;
    resolveVariantUrl(glbFilename, slider.slider_index, sliderValue).then(url => {
      setSwapModelRequest({ id: objectIdx, url, yRotation: degrees, scaleMode: sliderScaleMode, originYRotation, brightnessDepth: rotSwapDepth, manualBrightness: rotMb });
    });
  }, [currentSessionId, currentUserId, loadedObjects, sliderScaleMode, resolveVariantUrl, saveObjectStates, useOriginalOrigin, objectBrightness]);

  // Fork an anchor object as a new standalone object
  const handleForkAnchor = useCallback(async (objectIdx, slider, anchorIndex) => {
    if (!currentSessionId || !currentUserId) return;
    const anchor = slider.anchors[anchorIndex];
    if (!anchor) return;

    const glbFilename = loadedObjects[objectIdx]?.glbUrl?.split('/').pop();
    if (!glbFilename) return;

    const sliderValue = anchor[0];
    const name = `${slider.object} (${slider.attribute} @ ${Math.round((anchor[1] * 200) - 100)}%)`;

    try {
      const response = await fetch('/trellis/fork_anchor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSessionId,
          user_id: currentUserId,
          glb_filename: glbFilename,
          slider_index: slider.slider_index,
          slider_value: sliderValue,
          name,
        })
      });
      const data = await response.json();
      if (data.error) {
        alert('Fork error: ' + data.error);
        return;
      }

      logBehavior('fork_anchor', { sliderIndex: slider.slider_index, sliderValue, newObjectName: name, newObjectIndex: data.object_id });

      // Add to gallery and 3D scene
      setGalleryItems(prev => [...prev, {
        object_index: data.object_id,
        source: 'trellis',
        prompt: data.name,
        is_combined: false,
        has_3d: true,
        glb_url: data.glb_url,
      }]);
      const isOriginAnchor = parseFloat(sliderValue) === 0;
      const parentDepth = loadedObjects[objectIdx]?.brightnessDepth || 0;
      const forkDepth = (isOriginAnchor && useOriginalOrigin) ? 0 : parentDepth + 1;
      setLoadedObjects(prev => ({
        ...prev,
        [data.object_id]: { glbUrl: data.glb_url, visible: true, brightnessDepth: forkDepth }
      }));
      setIsSidebarOpen(true);

      // Render multi-views in background
      triggerRenderViews(data.glb_filename);
    } catch (e) {
      console.error('Fork anchor error:', e);
      alert('Failed to fork anchor object');
    }
  }, [currentSessionId, currentUserId, loadedObjects, triggerRenderViews, useOriginalOrigin]);

  // Add anchor point to an existing slider (supports concurrent adds on different objects)
  const handleAddAnchorPoint = useCallback((objectIdx, slider, percentage) => {
    console.log('[AddAnchor] called', { objectIdx, slider: slider.slider_index, percentage, hasSocket: !!socketRef.current });
    if (!currentSessionId || !currentUserId || !socketRef.current) return;

    // Block if this specific object already has an anchor add in-flight
    const alreadyAdding = Object.values(addingAnchorsRef.current).some(
      a => a.objectIdx === objectIdx
    );
    if (alreadyAdding) return;

    const obj = loadedObjects[objectIdx];
    if (!obj) return;
    const glbFilename = obj.glbUrl.split('/').pop();

    const requestId = `anchor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log('[AddAnchor] emitting add_anchor_point', { glb_filename: glbFilename, slider_index: slider.slider_index, percentage, requestId });
    logBehavior('add_anchor_point', { sliderIndex: slider.slider_index, percentage });
    addingAnchorsRef.current[requestId] = { sliderIndex: slider.slider_index, objectIdx };
    setAddingAnchors({ ...addingAnchorsRef.current });
    socketRef.current.emit('add_anchor_point', {
      glb_filename: glbFilename,
      slider_index: slider.slider_index,
      percentage,
      session_id: currentSessionId,
      user_id: currentUserId,
      request_id: requestId,
    });
  }, [currentSessionId, currentUserId, loadedObjects]);

  return (
    <>
      {showLoginModal && (
        <LoginModal
          onSessionStart={handleSessionStart}
          setIsLoading={setIsLoading}
        />
      )}
      
      <Header
        currentUserId={currentUserId}
        isLoading={isLoading}
        onUploadClick={() => fileInputRef.current?.click()}
        onToggleImage={() => { logBehavior('toggle_image_panel', { isOpen: !isImagePanelOpen }); setIsImagePanelOpen(!isImagePanelOpen); }}
        onUndo={handleUndo}
        onReset={handleReset}
        onFinishObject={handleFinishObject}
        onTextTo3D={() => setShowTextTo3DModal(true)}
        isImagePanelOpen={isImagePanelOpen}
        sceneSettings={sceneSettings}
        onSceneSettingsChange={setSceneSettings}
      />
      
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => e.target.files[0] && handleFileUpload(e.target.files[0])}
      />
      
      <StatusBanner message={statusMessage} />

      <div className="main-container">
        <Viewer3D
          ref={viewer3DRef}
          loadedObjects={loadedObjects}
          selectedObject={selectedObject}
          setSelectedObject={setSelectedObject}
          gizmoMode={gizmoMode}
          onTransformChange={handleTransformChange}
          onTransformDragEnd={handleTransformDragEnd}
          onObjectsReady={handleObjectsReady}
          transformInputChange={transformInputChange}
          swapModelRequest={swapModelRequest}
          backgroundColor={sceneSettings.backgroundColor}
          showGrid={sceneSettings.showGrid}
          ambientIntensity={sceneSettings.ambientIntensity}
          mainLightIntensity={sceneSettings.mainLightIntensity}
          exposure={sceneSettings.exposure}
        />
        
        {selectedObject !== null && (
          <TransformPanel
            gizmoMode={gizmoMode}
            setGizmoMode={setGizmoMode}
            transform={selectedObjectTransform}
            onTransformInputChange={(type, value) => setTransformInputChange({ type, value })}
            onTransformCommit={() => saveObjectStates()}
          />
        )}

        {selectedObject !== null && loadedObjects[selectedObject] && (
          <SliderPanel
            objectId={selectedObject}
            sliders={objectSliders[selectedObject] || []}
            savedSliderAnchors={sliderAnchorMapRef.current[selectedObject] || null}
            onCreateSlider={handleCreateSlider}
            onAnchorChange={handleSliderAnchorChange}
            onAddAnchorPoint={handleAddAnchorPoint}
            onRotationChange={handleAnchorRotationChange}
            onForkAnchor={handleForkAnchor}
            addingAnchor={Object.values(addingAnchors).find(a => a.objectIdx === selectedObject) || null}
            isCreating={creatingSlidersFor.size >= MAX_CONCURRENT_SLIDERS}
            isCreatingThisObject={creatingSlidersFor.has(selectedObject)}
            progress={sliderProgressMap[selectedObject] || null}
            scaleMode={sliderScaleMode}
            onScaleModeChange={(mode) => {
              logBehavior('change_scale_mode', { mode });
              setSliderScaleMode(mode);
              // Re-trigger the current swap with the new scale mode
              if (swapModelRequest) {
                setSwapModelRequest({ ...swapModelRequest, scaleMode: mode });
              }
            }}
            brightness={objectBrightness[selectedObject]?.[currentBrightnessMode[selectedObject] || 'origin'] ?? 1.0}
            onBrightnessChange={(factor) => {
              const bm = currentBrightnessMode[selectedObject] || 'origin';
              setObjectBrightness(prev => ({
                ...prev,
                [selectedObject]: { ...(prev[selectedObject] || {}), [bm]: factor }
              }));
              if (viewer3DRef.current) {
                viewer3DRef.current.setObjectBrightness(selectedObject, factor);
              }
            }}
            useOriginalOrigin={useOriginalOrigin}
            onToggleOriginalOrigin={() => {
              const next = !useOriginalOrigin;
              setUseOriginalOrigin(next);
              // Re-trigger swap for current object if a slider is at origin
              if (selectedObject != null && objectSliders[selectedObject]) {
                const savedAnchors = sliderAnchorMapRef.current[selectedObject] || {};
                for (const slider of objectSliders[selectedObject]) {
                  if (!slider.complete || !slider.anchors) continue;
                  const savedSv = savedAnchors[slider.slider_index];
                  // Default to origin if no saved position
                  const currentSv = savedSv != null ? String(savedSv) : '0.00000';
                  if (parseFloat(currentSv) === 0) {
                    const originAnchor = slider.anchors.find(a => parseFloat(a[0]) === 0);
                    const yRot = originAnchor ? (originAnchor[2] || 0) : 0;
                    // Resolve with the NEW toggle value (can't use resolveVariantUrl since it captures old state)
                    fetch('/resolve_variant', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        session_id: currentSessionId,
                        user_id: currentUserId,
                        glb_filename: slider.glb_filename,
                        slider_index: slider.slider_index,
                        slider_value: '0.00000',
                        use_original: next,
                      })
                    }).then(r => r.json()).then(data => {
                      const toggleDepth = next ? 0 : (loadedObjects[selectedObject]?.brightnessDepth || 0) + 1;
                      const toggleBMode = next ? 'origin' : 'variant';
                      const toggleMb = objectBrightness[selectedObject]?.[toggleBMode] ?? 1.0;
                      setSwapModelRequest({ id: selectedObject, url: data.url, yRotation: yRot, scaleMode: sliderScaleMode, originYRotation: yRot, brightnessDepth: toggleDepth, manualBrightness: toggleMb });
                    });
                    break;
                  }
                }
              }
            }}
          />
        )}

        <ImagePanel
          isOpen={isImagePanelOpen}
          onClose={() => setIsImagePanelOpen(false)}
          imageUrl={imageUrl}
          points={points}
          labels={labels}
          onImageClick={handleImageClick}
        />
        
        <Sidebar
          isOpen={isSidebarOpen}
          onToggle={() => { logBehavior('toggle_sidebar', { isOpen: !isSidebarOpen }); setIsSidebarOpen(!isSidebarOpen); }}
          galleryItems={galleryItems}
          selectedItems={selectedGalleryItems}
          loadedObjects={loadedObjects}
          onItemClick={handleGalleryItemClick}
          onContextMenu={handleContextMenu}
          onCombine={handleCombineObjects}
          onDelete={handleDeleteObjects}
        />
      </div>
      
      {contextMenu.visible && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          objectIdx={contextMenu.objectIdx}
          hasLoaded3D={!!loadedObjects[contextMenu.objectIdx]}
          isVisible={loadedObjects[contextMenu.objectIdx]?.visible}
          onConvertTo3D={() => handleConvertTo3D(contextMenu.objectIdx)}
          onToggleVisibility={() => handleToggleVisibility(contextMenu.objectIdx)}
          isLoading={isLoading}
        />
      )}

      {showTextTo3DModal && (
        <TextTo3DModal
          onGenerate={handleTextTo3DGenerate}
          onClose={() => !isTextTo3DLoading && setShowTextTo3DModal(false)}
          isLoading={isTextTo3DLoading}
          statusMessage={statusMessage}
        />
      )}
    </>
  );
}

export default App;
