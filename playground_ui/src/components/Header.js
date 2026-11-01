import React, { useState, useRef, useEffect } from 'react';
import SceneSettingsPanel from './SceneSettingsPanel';

function Header({
  currentUserId,
  isLoading,
  onUploadClick,
  onToggleImage,
  onUndo,
  onReset,
  onFinishObject,
  onTextTo3D,
  isImagePanelOpen,
  sceneSettings,
  onSceneSettingsChange
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const settingsRef = useRef(null);

  // Close dropdown on click outside
  useEffect(() => {
    if (!settingsOpen) return;
    const handleClick = (e) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [settingsOpen]);

  return (
    <header className="header">
      <div className="header-left">
        <h1>3D Object Editor</h1>

        {currentUserId && (
          <div className="session-info">
            <span>User:</span>
            <span className="user-id">{currentUserId}</span>
          </div>
        )}

        <div className="controls">
          <div className="divider"></div>

          <div className="button-group">
            <span className="button-group-label">Image to 3D</span>
            <div className="button-group-buttons">
              <button onClick={onUploadClick}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginRight: 4}}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                Upload
              </button>
              <button
                className={isImagePanelOpen ? 'active' : ''}
                onClick={onToggleImage}
                title="Show/Hide Image"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginRight: 4}}>
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
                Image
              </button>
              <button onClick={onUndo} title="Undo Last Point">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginRight: 4}}>
                  <path d="M3 7v6h6"/>
                  <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
                </svg>
                Undo
              </button>
              <button onClick={onReset} title="Reset All Points">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginRight: 4}}>
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                  <path d="M3 3v5h5"/>
                </svg>
                Reset
              </button>
              <button className="success" onClick={onFinishObject}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginRight: 4}}>
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                Finish
              </button>
            </div>
          </div>

          <div className="divider"></div>

          <div className="button-group">
            <span className="button-group-label">Text to 3D</span>
            <div className="button-group-buttons">
              <button className="primary" onClick={onTextTo3D} title="Generate 3D from text">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginRight: 4}}>
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
                </svg>
                Generate
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="header-right">
        <button
          className={helpOpen ? 'active' : ''}
          onClick={() => setHelpOpen(true)}
          title="Controls Help"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </button>
        <div className="scene-settings-dropdown" ref={settingsRef}>
          <button
            className={settingsOpen ? 'active' : ''}
            onClick={() => setSettingsOpen(!settingsOpen)}
            title="Scene Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          {settingsOpen && (
            <SceneSettingsPanel
              settings={sceneSettings}
              onSettingsChange={onSceneSettingsChange}
            />
          )}
        </div>
        <div className={`status-badge ${isLoading ? 'processing' : ''}`} title="Processing Status"></div>
      </div>

      {helpOpen && (
        <div className="modal-overlay" onClick={() => setHelpOpen(false)}>
          <div className="modal help-modal" onClick={e => e.stopPropagation()}>
            <div className="help-modal-header">
              <h2>Scene Controls</h2>
              <button onClick={() => setHelpOpen(false)} style={{ border: 'none', padding: 4 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <div className="help-columns">
              <div className="help-column">
                <h3>Mouse</h3>
                <table className="help-table">
                  <tbody>
                    <tr><td className="help-key">Left drag</td><td>Rotate</td></tr>
                    <tr><td className="help-key">Right drag</td><td>Pan</td></tr>
                    <tr><td className="help-key">Middle drag</td><td>Pan</td></tr>
                    <tr><td className="help-key">Scroll wheel</td><td>Zoom</td></tr>
                    <tr><td className="help-key">Shift + left drag</td><td>Pan</td></tr>
                    <tr><td className="help-key">Click</td><td>Select object</td></tr>
                  </tbody>
                </table>
              </div>

              <div className="help-column">
                <h3>Trackpad</h3>
                <table className="help-table">
                  <tbody>
                    <tr><td className="help-key">Pinch</td><td>Zoom</td></tr>
                    <tr><td className="help-key">Two-finger scroll</td><td>Pan</td></tr>
                    <tr><td className="help-key">Shift + two-finger</td><td>Rotate</td></tr>
                    <tr><td className="help-key">Click</td><td>Select object</td></tr>
                    <tr><td className="help-key">Click + drag</td><td>Rotate</td></tr>
                    <tr><td className="help-key">Shift + click drag</td><td>Pan</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="help-section">
              <h3>Object Transform</h3>
              <table className="help-table">
                <tbody>
                  <tr><td className="help-key">Click object</td><td>Select and show transform gizmo</td></tr>
                  <tr><td className="help-key">Drag gizmo</td><td>Move / rotate / scale (based on mode)</td></tr>
                  <tr><td className="help-key">Click empty space</td><td>Deselect</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

export default Header;
