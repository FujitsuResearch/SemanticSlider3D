import React, { useState, useCallback, useRef, useEffect } from 'react';

const STEPS = [
  { num: 1, label: 'Generate editing direction' },
  { num: 2, label: 'Select & filter views' },
  { num: 3, label: 'Edit views' },
  { num: 4, label: 'Build slider map' },
  { num: 5, label: 'Generate anchor points' },
];

function AnchorSlider({ objectId, slider, onAnchorChange, isActive, onActivate, currentAnchorIndex, setCurrentAnchorIndex }) {
  const anchors = slider.anchors || [];

  // Find default anchor: the one whose slider_value is "0" (original object), or index 0
  const originIndex = anchors.findIndex(a => parseFloat(a[0]) === 0);
  const originLpips = originIndex >= 0 ? anchors[originIndex][1] : null;

  // Initialize from tracked anchor if available, otherwise origin
  const initLpips = currentAnchorIndex != null && anchors[currentAnchorIndex]
    ? anchors[currentAnchorIndex][1]
    : (originLpips !== null ? originLpips : (anchors[0] ? anchors[0][1] : 0));
  const [value, setValue] = useState(initLpips);

  // Sync value when currentAnchorIndex or anchors change (e.g. re-selecting the object)
  useEffect(() => {
    if (currentAnchorIndex != null && anchors[currentAnchorIndex]) {
      setValue(anchors[currentAnchorIndex][1]);
    } else if (anchors.length > 0) {
      // No saved anchor — reset to origin (sv=0) or first anchor
      const oi = anchors.findIndex(a => parseFloat(a[0]) === 0);
      setValue(oi >= 0 ? anchors[oi][1] : anchors[0][1]);
    }
  }, [currentAnchorIndex, anchors]);

  const findNearestAnchor = useCallback((lpips) => {
    if (anchors.length === 0) return 0;
    let nearest = 0;
    let minDist = Math.abs(anchors[0][1] - lpips);
    for (let i = 1; i < anchors.length; i++) {
      const dist = Math.abs(anchors[i][1] - lpips);
      if (dist < minDist) {
        minDist = dist;
        nearest = i;
      }
    }
    return nearest;
  }, [anchors]);

  const handleChange = useCallback((e) => {
    const raw = parseFloat(e.target.value);
    const nearestIdx = findNearestAnchor(raw);
    const snapped = anchors[nearestIdx][1];
    setValue(snapped);
    setCurrentAnchorIndex(nearestIdx);
    onActivate();
    onAnchorChange(objectId, slider, nearestIdx);
  }, [anchors, findNearestAnchor, objectId, slider, onAnchorChange, onActivate, setCurrentAnchorIndex]);

  if (anchors.length === 0) {
    return <input type="range" min="0" max="1" step="0.01" defaultValue="0.5" disabled />;
  }

  // Convert normalized lpips (0-1) to percentage (-100 to 100)
  const currentPct = Math.round((value * 200) - 100);

  return (
    <div className={`anchor-slider-container${!isActive ? ' inactive' : ''}`}>
      <div className="anchor-slider-track">
        <input
          type="range"
          min="0"
          max="1"
          step="0.001"
          value={value}
          onChange={handleChange}
          className="anchor-slider"
        />
        <div className="anchor-ticks">
          <div className="anchor-slider-tooltip" style={{ left: `${value * 100}%` }}>
            {currentPct}%
          </div>
          {anchors.map((anchor, i) => (
            <div
              key={i}
              className={`anchor-tick${Math.abs(anchor[1] - value) < 0.001 ? ' active' : ''}${parseFloat(anchor[0]) === 0 ? ' origin' : ''}`}
              style={{ left: `${anchor[1] * 100}%` }}
            />
          ))}
        </div>
      </div>
      <div className="anchor-slider-labels">
        <span>-100%</span>
        <span>100%</span>
      </div>
    </div>
  );
}

function AddAnchorRow({ objectId, slider, onAddAnchorPoint, addingAnchor, isPoolBusy }) {
  const [pct, setPct] = useState('');
  const isThisAdding = addingAnchor && addingAnchor.objectIdx === objectId && addingAnchor.sliderIndex === slider.slider_index;
  const isThisObjectAdding = addingAnchor && addingAnchor.objectIdx === objectId;
  const isDisabled = isThisObjectAdding || isPoolBusy;

  const handleAdd = () => {
    const val = parseFloat(pct);
    if (isNaN(val) || val < -100 || val > 100) return;
    onAddAnchorPoint(objectId, slider, val);
  };

  return (
    <div className="add-anchor-row">
      <input
        type="number"
        min="-100"
        max="100"
        placeholder="%"
        value={pct}
        onChange={e => setPct(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleAdd()}
        disabled={isDisabled}
        className="add-anchor-input"
      />
      <button
        className="add-anchor-btn"
        onClick={handleAdd}
        disabled={isDisabled || pct === '' || isNaN(parseFloat(pct))}
      >
        {isThisAdding ? <span className="spinner-small" /> : isPoolBusy ? 'GPU pools busy' : 'Add Point'}
      </button>
    </div>
  );
}

function RotationInput({ degrees, onCommit }) {
  const [localVal, setLocalVal] = useState(String(degrees));

  // Sync when the upstream value changes (e.g. switching anchors)
  useEffect(() => {
    setLocalVal(String(degrees));
  }, [degrees]);

  const commit = () => {
    const parsed = parseInt(localVal, 10);
    if (!isNaN(parsed) && parsed !== degrees) {
      onCommit(Math.max(-180, Math.min(180, parsed)));
    }
  };

  return (
    <div className="anchor-rotation-control">
      <label>Y-Rot</label>
      <input
        type="number"
        min="-180"
        max="180"
        step="5"
        value={localVal}
        onChange={(e) => setLocalVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className="rotation-input"
      />
      <span className="rotation-degrees">&deg;</span>
    </div>
  );
}

const SCALE_MODES = ['height', 'width', 'original'];
const SCALE_MODE_LABELS = { height: 'H', width: 'W', original: '1:1' };
const SCALE_MODE_TITLES = { height: 'Align height', width: 'Align width', original: 'Original scale' };

function SliderPanel({ objectId, sliders, savedSliderAnchors, onCreateSlider, onAnchorChange, onAddAnchorPoint, onRotationChange, onForkAnchor, addingAnchor, isCreating, isCreatingThisObject, progress, scaleMode, onScaleModeChange, useOriginalOrigin, onToggleOriginalOrigin, brightness, onBrightnessChange }) {
  const [objectText, setObjectText] = useState('');
  const [attributeText, setAttributeText] = useState('');
  const [numSamples, setNumSamples] = useState(4);
  const [duplicateHint, setDuplicateHint] = useState(null);
  const [pos, setPos] = useState({ x: 20, y: 20 });
  const [activeSliderIndex, setActiveSliderIndex] = useState(null);
  // Per-object anchor positions: { objectId: { sliderIndex: anchorIndex } }
  const anchorIndexByObjectRef = useRef({});
  const prevObjectIdRef = useRef(objectId);
  const dragRef = useRef(null);

  // Derive current object's anchor map from the persistent ref
  const anchorIndexMap = anchorIndexByObjectRef.current[objectId] || {};
  const setAnchorIndexMap = useCallback((updater) => {
    const prev = anchorIndexByObjectRef.current[objectId] || {};
    const next = typeof updater === 'function' ? updater(prev) : updater;
    anchorIndexByObjectRef.current[objectId] = next;
    // Force re-render by toggling a counter
    setRenderTick(t => t + 1);
  }, [objectId]);
  const [, setRenderTick] = useState(0);

  // Reset active slider when switching objects (but keep anchor positions)
  useEffect(() => {
    if (prevObjectIdRef.current !== objectId) {
      setActiveSliderIndex(null);
      prevObjectIdRef.current = objectId;
    }
  }, [objectId]);

  // Seed anchor positions from saved slider anchors on first visit
  const seededObjectsRef = useRef(new Set());
  useEffect(() => {
    if (!savedSliderAnchors || seededObjectsRef.current.has(objectId)) return;
    if (!sliders || sliders.length === 0) return;
    seededObjectsRef.current.add(objectId);

    const indexMap = {};
    for (const slider of sliders) {
      if (!slider.complete || !slider.anchors) continue;
      const savedEntry = savedSliderAnchors[slider.slider_index];
      if (savedEntry == null) continue;
      const savedSv = typeof savedEntry === 'object' ? savedEntry.sv : savedEntry;
      if (savedSv == null) continue;
      const idx = slider.anchors.findIndex(a => a[0] === String(savedSv));
      if (idx >= 0) {
        indexMap[slider.slider_index] = idx;
      }
    }
    if (Object.keys(indexMap).length > 0) {
      anchorIndexByObjectRef.current[objectId] = indexMap;
      setRenderTick(t => t + 1);
    }
  }, [objectId, sliders, savedSliderAnchors]);

  const onMouseDown = useCallback((e) => {
    const el = dragRef.current;
    if (!el) return;
    const startX = e.clientX - pos.x;
    const startY = e.clientY - pos.y;
    const onMove = (ev) => setPos({ x: ev.clientX - startX, y: ev.clientY - startY });
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [pos]);

  const handleCreate = () => {
    if (!objectText.trim() || !attributeText.trim()) return;
    setDuplicateHint(null);
    const result = onCreateSlider(objectId, objectText.trim(), attributeText.trim(), numSamples);
    if (result === 'exists') {
      setDuplicateHint(`"${objectText.trim()} — ${attributeText.trim()}" already exists below.`);
      return;
    }
    // Clear inputs for 'creating' or 'resuming'
    setObjectText('');
    setAttributeText('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleCreate();
  };

  return (
    <div className="slider-panel" ref={dragRef} style={{ left: pos.x, top: pos.y }}>
      <div className="slider-panel-header" onMouseDown={onMouseDown}>
        <span>Edit Sliders</span>
        <div className="scale-mode-toggle" onMouseDown={e => e.stopPropagation()}>
          {SCALE_MODES.map(mode => (
            <button
              key={mode}
              className={`scale-mode-btn${scaleMode === mode ? ' active' : ''}`}
              title={SCALE_MODE_TITLES[mode]}
              onClick={() => onScaleModeChange(mode)}
            >
              {SCALE_MODE_LABELS[mode]}
            </button>
          ))}
          {(() => {
            const cs = sliders.find(s => s.complete);
            const hasOrig = !cs || cs.has_original !== false;
            const hasRecon = cs && cs.has_origin_recon === true;
            const canToggle = hasOrig && hasRecon;
            const forced = !canToggle ? (hasRecon ? false : true) : useOriginalOrigin;
            return (
              <button
                className={`scale-mode-btn origin-toggle${forced ? ' active' : ''}`}
                title={!canToggle
                  ? (hasRecon ? 'Only reconstructed origin available' : 'Only original GLB available')
                  : (forced ? 'Origin shows original GLB (click for reconstructed)' : 'Origin shows reconstructed GLB (click for original)')}
                onClick={canToggle ? onToggleOriginalOrigin : undefined}
                disabled={!canToggle}
              >
                {forced ? 'Orig' : 'Recon'}
              </button>
            );
          })()}
        </div>
      </div>

      <div className="slider-panel-inputs">
        <input
          type="text"
          placeholder="Object (e.g. face)"
          value={objectText}
          onChange={e => { setObjectText(e.target.value); setDuplicateHint(null); }}
          onKeyDown={handleKeyDown}
          disabled={isCreating}
        />
        <input
          type="text"
          placeholder="Attribute (e.g. smile)"
          value={attributeText}
          onChange={e => { setAttributeText(e.target.value); setDuplicateHint(null); }}
          onKeyDown={handleKeyDown}
          disabled={isCreating}
        />
        <div className="num-samples-row">
          <label>Samples</label>
          <input
            type="number"
            min="1"
            max="20"
            value={numSamples}
            onChange={e => setNumSamples(Math.max(1, parseInt(e.target.value) || 1))}
            onKeyDown={handleKeyDown}
            disabled={isCreating}
            className="num-samples-input"
          />
        </div>
        <div className="brightness-row" onMouseDown={e => e.stopPropagation()}>
          <label>Brightness</label>
          <input
            type="range"
            min="0.2"
            max="5.0"
            step="0.05"
            value={brightness}
            onChange={e => onBrightnessChange(parseFloat(e.target.value))}
          />
          <span className="brightness-value">{brightness.toFixed(2)}</span>
          {brightness !== 1.0 && (
            <button className="brightness-reset" onClick={() => onBrightnessChange(1.0)} title="Reset to 1.0">↺</button>
          )}
        </div>
        <button
          className="primary"
          onClick={handleCreate}
          disabled={isCreating || isCreatingThisObject || !objectText.trim() || !attributeText.trim()}
        >
          {isCreatingThisObject ? 'Creating...' : isCreating ? 'All GPU pools busy' : 'Create Slider'}
        </button>
        {duplicateHint && (
          <div className="slider-duplicate-hint">{duplicateHint}</div>
        )}
      </div>

      {isCreatingThisObject && progress && (
        <div className="slider-progress">
          {progress.sliderName && (
            <div className="slider-progress-name">Building: {progress.sliderName}</div>
          )}
          {STEPS.map(({ num, label }) => {
            let status = 'pending';
            if (progress.step > num) status = 'done';
            else if (progress.step === num) status = progress.skipped ? 'skipped' : 'active';
            return (
              <div key={num} className={`slider-progress-step ${status}`}>
                <div className="slider-progress-indicator">
                  {status === 'done' || status === 'skipped' ? '\u2713' : status === 'active' ? <span className="spinner-small" /> : num}
                </div>
                <div className="slider-progress-label">
                  {status === 'active' ? progress.message : label}
                  {status === 'skipped' && ' (cached)'}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {sliders && sliders.length > 0 && (
        <div className="slider-panel-list">
          {sliders.map((slider, i) => (
            <div key={`${objectId}-${slider.slider_index ?? i}`} className="slider-panel-item">
              <div className="slider-panel-item-label">
                {slider.object} — {slider.attribute}
                {!slider.complete && (
                  <span
                    className="slider-incomplete-badge resumable"
                    onClick={() => !isCreating && !isCreatingThisObject && onCreateSlider(objectId, slider.object, slider.attribute, numSamples)}
                    title="Click to resume building this slider"
                  >
                    incomplete
                  </span>
                )}
              </div>
              {slider.complete ? (
                <>
                  <AnchorSlider
                    objectId={objectId}
                    slider={slider}
                    onAnchorChange={onAnchorChange}
                    isActive={activeSliderIndex === slider.slider_index}
                    onActivate={() => setActiveSliderIndex(slider.slider_index)}
                    currentAnchorIndex={anchorIndexMap[slider.slider_index] ?? null}
                    setCurrentAnchorIndex={(idx) => setAnchorIndexMap(prev => ({ ...prev, [slider.slider_index]: idx }))}
                  />
                  {activeSliderIndex === slider.slider_index && anchorIndexMap[slider.slider_index] != null && slider.anchors[anchorIndexMap[slider.slider_index]] && (
                    <div className="anchor-controls-row">
                      <RotationInput
                        degrees={slider.anchors[anchorIndexMap[slider.slider_index]][2] || 0}
                        onCommit={(deg) => {
                          const anchor = slider.anchors[anchorIndexMap[slider.slider_index]];
                          onRotationChange(objectId, slider, anchor[0], deg);
                        }}
                      />
                      <button
                        className="fork-anchor-btn"
                        title="Copy this variant as a new object"
                        onClick={() => onForkAnchor(objectId, slider, anchorIndexMap[slider.slider_index])}
                      >
                        Fork
                      </button>
                    </div>
                  )}
                  {activeSliderIndex === slider.slider_index && (
                    <AddAnchorRow
                      objectId={objectId}
                      slider={slider}
                      onAddAnchorPoint={onAddAnchorPoint}
                      addingAnchor={addingAnchor}
                      isPoolBusy={isCreating}
                    />
                  )}
                </>
              ) : (
                <input type="range" min="0" max="1" step="0.01" defaultValue="0.5" disabled />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default SliderPanel;
