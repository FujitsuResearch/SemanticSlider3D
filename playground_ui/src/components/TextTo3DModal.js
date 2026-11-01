import React, { useState } from 'react';

function TextTo3DModal({ onGenerate, onClose, isLoading, statusMessage }) {
  const [prompt, setPrompt] = useState('');
  const [seed, setSeed] = useState(42);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (prompt.trim() && !isLoading) {
      onGenerate(prompt.trim(), seed);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal text-to-3d-modal" onClick={e => e.stopPropagation()}>
        <h2>Text to 3D</h2>
        <p>Generate a 3D model from a text description.</p>

        <form onSubmit={handleSubmit}>
          <textarea
            className="text-to-3d-prompt"
            placeholder="Describe the 3D object you want to generate..."
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={3}
            autoFocus
            disabled={isLoading}
          />

          <div className="text-to-3d-options">
            <label className="text-to-3d-seed-label">
              Seed
              <input
                type="number"
                value={seed}
                onChange={e => setSeed(parseInt(e.target.value) || 0)}
                className="text-to-3d-seed-input"
                disabled={isLoading}
              />
            </label>
          </div>

          <div className="modal-actions">
            <button type="button" onClick={onClose} disabled={isLoading}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!prompt.trim() || isLoading}>
              {isLoading ? 'Generating...' : 'Generate'}
            </button>
          </div>
        </form>

        {isLoading && (
          <div className="text-to-3d-loading">
            <div className="text-to-3d-spinner"></div>
            <span>{statusMessage || 'Generating 3D model... This may take a minute.'}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default TextTo3DModal;
