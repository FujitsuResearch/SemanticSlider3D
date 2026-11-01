import React from 'react';
import { logBehavior } from '../utils/behaviorLogger';

const BACKGROUND_PRESETS = [
  { value: '#f0f0f0', label: 'Light Gray (Default)' },
  { value: '#ffffff', label: 'White' },
  { value: '#e8e8e8', label: 'Soft Gray' },
  { value: '#d0d0d0', label: 'Medium Gray' },
  { value: '#1e1e1e', label: 'Dark Gray' },
  { value: '#0a0a0a', label: 'Near Black' },
  { value: '#1a365d', label: 'Dark Blue' },
  { value: '#1c4532', label: 'Dark Green' }
];

function SceneSettingsPanel({ settings, onSettingsChange }) {
  const handleChange = (key, value) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  const logSetting = (key, value) => {
    logBehavior('change_scene_setting', { settingName: key, value });
  };

  return (
    <div className="scene-settings-dropdown-content">
      <div className="scene-settings-header">Scene Settings</div>

      <div className="settings-section">
        <div className="settings-label">Background</div>
        <div className="color-presets">
          {BACKGROUND_PRESETS.map(preset => (
            <button
              key={preset.value}
              className={`color-preset ${settings.backgroundColor === preset.value ? 'active' : ''}`}
              style={{ backgroundColor: preset.value }}
              onClick={() => { handleChange('backgroundColor', preset.value); logSetting('backgroundColor', preset.value); }}
              title={preset.label}
            />
          ))}
        </div>
        <div className="color-input-row">
          <input
            type="color"
            value={settings.backgroundColor}
            onChange={(e) => handleChange('backgroundColor', e.target.value)}
            onBlur={(e) => logSetting('backgroundColor', e.target.value)}
          />
          <input
            type="text"
            value={settings.backgroundColor}
            onChange={(e) => handleChange('backgroundColor', e.target.value)}
            onBlur={(e) => logSetting('backgroundColor', e.target.value)}
            placeholder="#f0f0f0"
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">Ambient Light</div>
        <div className="slider-row">
          <input
            type="range"
            min="0"
            max="5"
            step="0.1"
            value={settings.ambientIntensity ?? 1.5}
            onChange={(e) => handleChange('ambientIntensity', parseFloat(e.target.value))}
            onMouseUp={(e) => logSetting('ambientIntensity', parseFloat(e.target.value))}
          />
          <span className="slider-value">{(settings.ambientIntensity ?? 1.5).toFixed(1)}</span>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">Directional Light</div>
        <div className="slider-row">
          <input
            type="range"
            min="0"
            max="5"
            step="0.1"
            value={settings.mainLightIntensity ?? 2.5}
            onChange={(e) => handleChange('mainLightIntensity', parseFloat(e.target.value))}
            onMouseUp={(e) => logSetting('mainLightIntensity', parseFloat(e.target.value))}
          />
          <span className="slider-value">{(settings.mainLightIntensity ?? 2.5).toFixed(1)}</span>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">Exposure (Brightness)</div>
        <div className="slider-row">
          <input
            type="range"
            min="0.1"
            max="10"
            step="0.1"
            value={settings.exposure ?? 1.0}
            onChange={(e) => handleChange('exposure', parseFloat(e.target.value))}
            onMouseUp={(e) => logSetting('exposure', parseFloat(e.target.value))}
          />
          <span className="slider-value">{(settings.exposure ?? 1.0).toFixed(1)}</span>
        </div>
      </div>

      <div className="settings-section">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={settings.showGrid}
            onChange={(e) => { handleChange('showGrid', e.target.checked); logSetting('showGrid', e.target.checked); }}
          />
          <span>Show Grid</span>
        </label>
      </div>
    </div>
  );
}

export default SceneSettingsPanel;
