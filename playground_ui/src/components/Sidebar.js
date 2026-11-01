import React from 'react';

function Sidebar({
  isOpen,
  onToggle,
  galleryItems,
  selectedItems,
  loadedObjects,
  onItemClick,
  onContextMenu,
  onCombine,
  onDelete
}) {
  const hasSelection = selectedItems.size > 0;
  const hasCombinedSelected = galleryItems.some(
    item => selectedItems.has(item.object_index) && item.is_combined
  );
  const hasTrellisSelected = galleryItems.some(
    item => selectedItems.has(item.object_index) && item.source === 'trellis'
  );

  return (
    <div className={`sidebar ${isOpen ? '' : 'collapsed'}`}>
      <div className="sidebar-toggle" onClick={onToggle}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points={isOpen ? "9 18 15 12 9 6" : "15 18 9 12 15 6"}/>
        </svg>
      </div>
      
      <div className="sidebar-header">
        3D Assets
        <button style={{ border: 'none', padding: 4 }} onClick={onToggle}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      
      {hasSelection && (
        <div className="sidebar-controls">
          <button
            className="primary"
            onClick={onCombine}
            title={hasTrellisSelected ? "Cannot combine text-generated objects" : "Combine Selected"}
            disabled={hasTrellisSelected}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
            </svg>
            Combine
          </button>
          
          {hasCombinedSelected && (
            <button className="primary" title="Uncombine Selected">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 14h6m2 0h8M4 10h6m2 0h8M10 3v18"/>
              </svg>
              Uncombine
            </button>
          )}
          
          <button className="danger" onClick={onDelete} title="Delete Selected">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
            Delete
          </button>
        </div>
      )}
      
      <div className="sidebar-content">
        <div className="gallery-grid">
          {galleryItems.map(item => (
            <GalleryItem
              key={item.object_index}
              item={item}
              isSelected={selectedItems.has(item.object_index)}
              has3D={!!loadedObjects[item.object_index]}
              onClick={onItemClick}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function GalleryItem({ item, isSelected, has3D, onClick, onContextMenu }) {
  const handleClick = (e) => onClick(item.object_index, e);
  const handleContextMenu = (e) => onContextMenu(e, item.object_index);

  const isTrellis = item.source === 'trellis';
  const isCommons = item.source === 'commons';

  const displayName = item.prompt || String(item.object_index);

  return (
    <div className="gallery-item-wrapper" onClick={handleClick} onContextMenu={handleContextMenu}>
      <div
        className={`gallery-item ${isSelected ? 'selected' : ''} ${has3D ? 'has-3d' : ''} ${isTrellis ? 'trellis-source' : ''} ${isCommons ? 'commons-source' : ''}`}
      >
        <div className="indicator-3d"></div>

        {isTrellis || isCommons ? (
          <div className="trellis-placeholder">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
            </svg>
          </div>
        ) : (
          <img
            src={`data:image/png;base64,${item.object_image}`}
            alt={`Object ${item.object_index}`}
          />
        )}

        {item.is_combined && (
          <div style={{
            position: 'absolute',
            bottom: 4,
            right: 4,
            fontSize: 12,
            color: 'var(--text-muted)'
          }}>
            ⚄
          </div>
        )}
      </div>
      <div className="gallery-item-name" title={displayName}>
        {displayName}
      </div>
    </div>
  );
}

export default Sidebar;
