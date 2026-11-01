/**
 * Behavior Logger - logs user interactions to the backend.
 *
 * Each log entry is POSTed as JSON to /log_behavior and contains:
 *   timestamp, sessionId, userId, action (string), data (object)
 */

let _sessionId = null;
let _userId = null;

export function initLogger(sessionId, userId) {
  _sessionId = sessionId;
  _userId = userId;
}

export function logBehavior(action, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    sessionId: _sessionId,
    userId: _userId,
    action,
    data,
  };

  // Fire-and-forget POST to backend
  fetch('/log_behavior', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  }).catch((e) => console.warn('Failed to log behavior:', e));

  // Also log to console in development
  if (process.env.NODE_ENV === 'development') {
    console.log('[behavior]', action, data);
  }
}
