/**
 * Viewer3D - Thin React wrapper for Viewer3DCore
 *
 * This component does NOT contain any Three.js logic.
 * It simply:
 *   1. Mounts the vanilla JS Viewer3DCore on mount
 *   2. Syncs React props to the core via imperative calls
 *   3. Forwards events from the core to React callbacks
 *
 * All 3D performance is handled by Viewer3DCore - React never touches 3D state.
 */

import React, { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import Viewer3DCore from '../lib/Viewer3DCore';

const Viewer3D = forwardRef(function Viewer3D({
  loadedObjects,
  selectedObject,
  setSelectedObject,
  gizmoMode,
  onTransformChange,
  onTransformDragEnd,
  onObjectsReady,
  transformInputChange,
  swapModelRequest,
  // Scene settings
  backgroundColor,
  ambientIntensity,
  mainLightIntensity,
  exposure,
  showGrid
}, ref) {
  const containerRef = useRef(null);
  const coreRef = useRef(null);

  // Expose core methods to parent via ref
  useImperativeHandle(ref, () => ({
    getAllTransforms: () => coreRef.current ? coreRef.current.getAllTransforms() : {},
    setObjectBrightness: (id, factor) => coreRef.current && coreRef.current.setObjectBrightness(id, factor),
  }), []);

  // ═══════════════════════════════════════════════════════════════════════════
  // MOUNT/UNMOUNT - Create core once, never recreate
  // ═══════════════════════════════════════════════════════════════════════════

  useEffect(() => {
    // Create the vanilla JS core
    coreRef.current = new Viewer3DCore(containerRef.current);

    // Wire up event callbacks (these never change)
    coreRef.current.onSelect(setSelectedObject);
    coreRef.current.onTransformChange(onTransformChange);
    coreRef.current.onTransformDragEnd(onTransformDragEnd);
    coreRef.current.onObjectsReady(onObjectsReady);

    // Cleanup on unmount
    return () => {
      if (coreRef.current) {
        coreRef.current.dispose();
        coreRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - intentionally runs once on mount

  // ═══════════════════════════════════════════════════════════════════════════
  // SYNC PROPS TO CORE - Imperative updates, no React re-renders in 3D
  // ═══════════════════════════════════════════════════════════════════════════

  // Sync loaded objects
  useEffect(() => {
    if (coreRef.current && loadedObjects) {
      coreRef.current.syncObjects(loadedObjects);
    }
  }, [loadedObjects]);

  // Sync selection
  useEffect(() => {
    if (coreRef.current) {
      coreRef.current.selectObject(selectedObject);
    }
  }, [selectedObject]);

  // Sync gizmo mode
  useEffect(() => {
    if (coreRef.current && gizmoMode) {
      coreRef.current.setGizmoMode(gizmoMode);
    }
  }, [gizmoMode]);

  // Apply transform from panel inputs
  useEffect(() => {
    if (coreRef.current && transformInputChange) {
      coreRef.current.setTransform(transformInputChange.type, transformInputChange.value);
    }
  }, [transformInputChange]);

  // Swap model when requested (slider anchor change)
  useEffect(() => {
    if (coreRef.current && swapModelRequest) {
      coreRef.current.swapModel(swapModelRequest.id, swapModelRequest.url, swapModelRequest.yRotation || 0, swapModelRequest.scaleMode || 'height', swapModelRequest.originYRotation || 0, swapModelRequest.brightnessDepth || 0, swapModelRequest.manualBrightness ?? 1.0);
    }
  }, [swapModelRequest]);

  // ═══════════════════════════════════════════════════════════════════════════
  // SYNC SCENE SETTINGS - Background, lighting, grid
  // ═══════════════════════════════════════════════════════════════════════════

  // Sync background color
  useEffect(() => {
    if (coreRef.current && backgroundColor) {
      coreRef.current.setBackgroundColor(backgroundColor);
    }
  }, [backgroundColor]);

  // Sync ambient light intensity
  useEffect(() => {
    if (coreRef.current && ambientIntensity !== undefined) {
      coreRef.current.setAmbientIntensity(ambientIntensity);
    }
  }, [ambientIntensity]);

  // Sync main light intensity (for fine-tuning)
  useEffect(() => {
    if (coreRef.current && mainLightIntensity !== undefined) {
      coreRef.current.setMainLightIntensity(mainLightIntensity);
    }
  }, [mainLightIntensity]);

  // Sync exposure (brightness)
  useEffect(() => {
    if (coreRef.current && exposure !== undefined) {
      coreRef.current.setExposure(exposure);
    }
  }, [exposure]);

  // Sync grid visibility
  useEffect(() => {
    if (coreRef.current && showGrid !== undefined) {
      coreRef.current.setGridVisible(showGrid);
    }
  }, [showGrid]);

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER - Just a container div, nothing else
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div
      ref={containerRef}
      className="viewer3d"
      style={{ width: '100%', height: '100%' }}
    />
  );
});

// Memoize to prevent unnecessary re-renders from parent
export default React.memo(Viewer3D);
