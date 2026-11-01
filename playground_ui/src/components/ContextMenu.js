import React from 'react';

function ContextMenu({ 
  x, 
  y, 
  objectIdx, 
  hasLoaded3D, 
  isVisible, 
  onConvertTo3D, 
  onToggleVisibility,
  isLoading 
}) {
  // Adjust position to stay within viewport
  const menuWidth = 150;
  const adjustedX = x + menuWidth > window.innerWidth ? window.innerWidth - menuWidth - 10 : x;

  return (
    <div 
      className="context-menu"
      style={{ left: adjustedX, top: y }}
      onClick={e => e.stopPropagation()}
    >
      {!hasLoaded3D ? (
        <div 
          className={`context-menu-item ${isLoading ? 'disabled' : ''}`}
          onClick={onConvertTo3D}
          title={isLoading ? "Another object is being generated..." : ""}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
            <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
            <line x1="12" y1="22.08" x2="12" y2="12"></line>
          </svg>
          To 3D
        </div>
      ) : (
        <div 
          className="context-menu-item"
          onClick={onToggleVisibility}
        >
          {isVisible ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                <line x1="1" y1="1" x2="23" y2="23"></line>
              </svg>
              Hide 3D
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              Show 3D
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default ContextMenu;
