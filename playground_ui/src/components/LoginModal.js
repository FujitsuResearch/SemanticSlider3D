import React, { useState, useEffect, useRef } from 'react';

function LoginModal({ onSessionStart, setIsLoading }) {
  const [userId, setUserId] = useState('');
  const [sessions, setSessions] = useState([]);
  const [showSessions, setShowSessions] = useState(false);
  const [resumingSessionId, setResumingSessionId] = useState(null);

  useEffect(() => {
    const savedUserId = localStorage.getItem('lastUserId');
    if (savedUserId) {
      setUserId(savedUserId);
    }
  }, []);

  const validateUserId = (id) => {
    if (!id.trim()) {
      alert('Please enter a user ID');
      return false;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      alert('User ID can only contain letters, numbers, underscores, and dashes');
      return false;
    }
    return true;
  };

  const checkExistingSessions = async () => {
    if (!validateUserId(userId)) return;
    
    setIsLoading(true);
    try {
      const response = await fetch(`/get_user_sessions/${userId}`);
      const data = await response.json();
      
      if (data.sessions && data.sessions.length > 0) {
        setSessions(data.sessions);
        setShowSessions(true);
      } else {
        setSessions([]);
        setShowSessions(true);
      }
      
      localStorage.setItem('lastUserId', userId);
    } catch (e) {
      console.error('Error fetching sessions:', e);
      alert('Failed to check sessions');
    } finally {
      setIsLoading(false);
    }
  };

  const resumeSession = async (sessionId) => {
    if (resumingSessionId) return;
    setResumingSessionId(sessionId);
    setIsLoading(true);
    try {
      const response = await fetch('/resume_session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, session_id: sessionId })
      });
      
      const data = await response.json();
      
      if (data.error) {
        alert('Error: ' + data.error);
        return;
      }
      
      onSessionStart(
        data.session_id,
        data.user_id,
        data.gallery_items || [],
        data.image_filename,
        data.object_states || null
      );
    } catch (e) {
      console.error('Session resume error:', e);
      alert('Failed to resume session');
    } finally {
      setResumingSessionId(null);
      setIsLoading(false);
    }
  };

  const [isStartingNew, setIsStartingNew] = useState(false);

  const startNewSession = async () => {
    if (!validateUserId(userId)) return;

    setIsLoading(true);
    setIsStartingNew(true);
    try {
      const response = await fetch('/start_session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId })
      });

      const data = await response.json();

      if (data.error) {
        alert('Error: ' + data.error);
        return;
      }

      onSessionStart(data.session_id, data.user_id, data.gallery_items || []);
    } catch (e) {
      console.error('Session start error:', e);
      alert('Failed to start session');
    } finally {
      setIsStartingNew(false);
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      checkExistingSessions();
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>Welcome</h2>
        <p>Enter your user ID to continue. Your work is saved automatically.</p>
        
        <input
          type="text"
          placeholder="Enter your user ID (e.g., john_doe)"
          value={userId}
          onChange={e => setUserId(e.target.value)}
          onKeyPress={handleKeyPress}
          autoComplete="off"
        />
        
        {showSessions && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: 8 }}>
              {sessions.length > 0 ? 'Resume a previous session:' : 'No previous sessions found'}
            </div>
            {sessions.length > 0 && (
              <div style={{ maxHeight: 150, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                {sessions.map(session => {
                  const isThis = resumingSessionId === session.session_id;
                  return (
                    <div
                      key={session.session_id}
                      className={`session-item${resumingSessionId ? ' disabled' : ''}`}
                      onClick={() => resumeSession(session.session_id)}
                      style={resumingSessionId ? { pointerEvents: 'none', opacity: isThis ? 1 : 0.5 } : {}}
                    >
                      <div>
                        <div className="session-date">
                          {session.created_at ? new Date(session.created_at).toLocaleString() : session.session_id}
                        </div>
                        <div className="session-meta">
                          {isThis ? 'Loading scene...' : `${session.object_count} objects${session.has_image ? ' \u2022 Has image' : ''}`}
                        </div>
                      </div>
                      {isThis ? (
                        <div className="spinner-small" />
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="9 18 15 12 9 6"/>
                        </svg>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        
        <div className="modal-actions">
          <button onClick={checkExistingSessions} disabled={isStartingNew}>Check Sessions</button>
          <button className="primary" onClick={startNewSession} disabled={isStartingNew}
            style={isStartingNew ? { display: 'flex', alignItems: 'center', gap: 8 } : {}}>
            {isStartingNew ? (<><div className="spinner-small" />Preparing session...</>) : 'New Session'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default LoginModal;
