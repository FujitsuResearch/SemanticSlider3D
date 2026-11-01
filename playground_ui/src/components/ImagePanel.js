import React, { useCallback, useRef } from 'react';

function ImagePanel({ isOpen, onClose, imageUrl, points, labels, onImageClick }) {
  const imageRef = useRef(null);
  
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    if (!imageRef.current) return;
    
    const rect = imageRef.current.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const relY = e.clientY - rect.top;
    
    const scaleX = imageRef.current.naturalWidth / rect.width;
    const scaleY = imageRef.current.naturalHeight / rect.height;
    const trueX = Math.round(relX * scaleX);
    const trueY = Math.round(relY * scaleY);
    
    onImageClick(trueX, trueY, e.button === 2);
  }, [onImageClick]);

  const handleContextMenu = (e) => e.preventDefault();

  return (
    <div className={`image-panel ${isOpen ? '' : 'hidden'}`}>
      <div className="panel-header">
        <span>Source Image</span>
        <div style={{ cursor: 'pointer' }} onClick={onClose}>✕</div>
      </div>
      
      {imageUrl ? (
        <div 
          className="image-wrapper"
          onContextMenu={handleContextMenu}
        >
          <img 
            ref={imageRef}
            src={imageUrl} 
            alt="Source" 
            className="main-image"
            onMouseDown={handleMouseDown}
            draggable={false}
          />
          
          {/* Render markers */}
          {imageRef.current && points.map((point, idx) => {
            const rect = imageRef.current.getBoundingClientRect();
            const scaleX = rect.width / imageRef.current.naturalWidth;
            const scaleY = rect.height / imageRef.current.naturalHeight;
            const displayX = point[0] * scaleX;
            const displayY = point[1] * scaleY;
            
            return (
              <div
                key={idx}
                className={`marker ${labels[idx] === 1 ? 'positive' : 'negative'}`}
                style={{ left: displayX, top: displayY }}
              />
            );
          })}
        </div>
      ) : (
        <div className="placeholder-container">
          Upload an image to start segmentation
        </div>
      )}
    </div>
  );
}

export default ImagePanel;
