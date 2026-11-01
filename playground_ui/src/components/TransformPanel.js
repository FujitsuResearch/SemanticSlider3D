import React, { useEffect, useState, useRef, memo, useCallback } from 'react';

const TransformPanel = memo(function TransformPanel({
  gizmoMode,
  setGizmoMode,
  transform,
  onTransformInputChange,
  onTransformCommit
}) {
  // Local state for controlled inputs
  const [localPosition, setLocalPosition] = useState({ x: 0, y: 0, z: 0 });
  const [localRotation, setLocalRotation] = useState({ x: 0, y: 0, z: 0 });
  const [localScale, setLocalScale] = useState({ x: 1, y: 1, z: 1 });
  // Track whether user has edited inputs since last sync (to avoid spurious blur logs)
  const dirtyRef = useRef(false);

  // Sync local state with transform prop (only when transform changes from 3D scene)
  useEffect(() => {
    if (transform) {
      dirtyRef.current = false;
      setLocalPosition({
        x: parseFloat(transform.position.x.toFixed(2)),
        y: parseFloat(transform.position.y.toFixed(2)),
        z: parseFloat(transform.position.z.toFixed(2))
      });
      setLocalRotation({
        x: parseFloat(transform.rotation.x.toFixed(1)),
        y: parseFloat(transform.rotation.y.toFixed(1)),
        z: parseFloat(transform.rotation.z.toFixed(1))
      });
      setLocalScale({
        x: parseFloat(transform.scale.x.toFixed(2)),
        y: parseFloat(transform.scale.y.toFixed(2)),
        z: parseFloat(transform.scale.z.toFixed(2))
      });
    }
  }, [transform]);

  const handlePositionChange = useCallback((axis, value) => {
    dirtyRef.current = true;
    setLocalPosition(prev => {
      const newPos = { ...prev, [axis]: value };
      if (onTransformInputChange) {
        onTransformInputChange('position', newPos);
      }
      return newPos;
    });
  }, [onTransformInputChange]);

  const handleRotationChange = useCallback((axis, value) => {
    dirtyRef.current = true;
    setLocalRotation(prev => {
      const newRot = { ...prev, [axis]: value };
      if (onTransformInputChange) {
        onTransformInputChange('rotation', newRot);
      }
      return newRot;
    });
  }, [onTransformInputChange]);

  const handleScaleChange = useCallback((axis, value) => {
    dirtyRef.current = true;
    setLocalScale(prev => {
      const newScale = { ...prev, [axis]: value };
      if (onTransformInputChange) {
        onTransformInputChange('scale', newScale);
      }
      return newScale;
    });
  }, [onTransformInputChange]);

  const handleBlur = useCallback(() => {
    if (onTransformCommit && dirtyRef.current) {
      dirtyRef.current = false;
      onTransformCommit({ position: localPosition, rotation: localRotation, scale: localScale });
    }
  }, [onTransformCommit, localPosition, localRotation, localScale]);

  return (
    <div className="transform-panel">
      <div className="transform-header">Transform Object</div>
      
      <div className="gizmo-controls">
        <button 
          className={`gizmo-btn ${gizmoMode === 'translate' ? 'active' : ''}`}
          onClick={() => setGizmoMode('translate')}
        >
          Move
        </button>
        <button 
          className={`gizmo-btn ${gizmoMode === 'rotate' ? 'active' : ''}`}
          onClick={() => setGizmoMode('rotate')}
        >
          Rotate
        </button>
        <button 
          className={`gizmo-btn ${gizmoMode === 'scale' ? 'active' : ''}`}
          onClick={() => setGizmoMode('scale')}
        >
          Scale
        </button>
      </div>
      
      <div className="transform-group">
        <div className="transform-label">Position</div>
        <div className="input-row">
          <div className="input-wrapper">
            <span>X</span>
            <input
              type="number"
              step="0.1"
              value={localPosition.x}
              onChange={e => handlePositionChange('x', parseFloat(e.target.value) || 0)}
              onBlur={handleBlur}
            />
          </div>
          <div className="input-wrapper">
            <span>Y</span>
            <input
              type="number"
              step="0.1"
              value={localPosition.y}
              onChange={e => handlePositionChange('y', parseFloat(e.target.value) || 0)}
              onBlur={handleBlur}
            />
          </div>
          <div className="input-wrapper">
            <span>Z</span>
            <input
              type="number"
              step="0.1"
              value={localPosition.z}
              onChange={e => handlePositionChange('z', parseFloat(e.target.value) || 0)}
              onBlur={handleBlur}
            />
          </div>
        </div>
      </div>

      <div className="transform-group">
        <div className="transform-label">Rotation (Deg)</div>
        <div className="input-row">
          <div className="input-wrapper">
            <span>X</span>
            <input
              type="number"
              step="1"
              value={localRotation.x}
              onChange={e => handleRotationChange('x', parseFloat(e.target.value) || 0)}
              onBlur={handleBlur}
            />
          </div>
          <div className="input-wrapper">
            <span>Y</span>
            <input
              type="number"
              step="1"
              value={localRotation.y}
              onChange={e => handleRotationChange('y', parseFloat(e.target.value) || 0)}
              onBlur={handleBlur}
            />
          </div>
          <div className="input-wrapper">
            <span>Z</span>
            <input
              type="number"
              step="1"
              value={localRotation.z}
              onChange={e => handleRotationChange('z', parseFloat(e.target.value) || 0)}
              onBlur={handleBlur}
            />
          </div>
        </div>
      </div>

      <div className="transform-group">
        <div className="transform-label">Scale</div>
        <div className="input-row">
          <div className="input-wrapper">
            <span>X</span>
            <input
              type="number"
              step="0.1"
              value={localScale.x}
              onChange={e => handleScaleChange('x', parseFloat(e.target.value) || 1)}
              onBlur={handleBlur}
            />
          </div>
          <div className="input-wrapper">
            <span>Y</span>
            <input
              type="number"
              step="0.1"
              value={localScale.y}
              onChange={e => handleScaleChange('y', parseFloat(e.target.value) || 1)}
              onBlur={handleBlur}
            />
          </div>
          <div className="input-wrapper">
            <span>Z</span>
            <input
              type="number"
              step="0.1"
              value={localScale.z}
              onChange={e => handleScaleChange('z', parseFloat(e.target.value) || 1)}
              onBlur={handleBlur}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

export default TransformPanel;
