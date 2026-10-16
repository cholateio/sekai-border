// src/log.js
// Single-line JSON for Cloud Logging. `detail` must come from safeDetail() or be plain numbers/strings (spec §5.3).
export function log(level, msg, detail = {}) {
    const line = JSON.stringify({ severity: level.toUpperCase(), msg, ...detail, ts: new Date().toISOString() });
    (level === 'error' ? console.error : console.log)(line);
}
