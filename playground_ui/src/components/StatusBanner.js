import React from 'react';

function StatusBanner({ message }) {
  if (!message) return null;

  return (
    <div className="status-banner">
      <div className="status-banner-spinner"></div>
      <span>{message}</span>
    </div>
  );
}

export default StatusBanner;
