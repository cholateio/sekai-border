// src/errors.js
// `detail` must never carry upstream player fields; build it with safeDetail() from validate.js.
export class UpstreamError extends Error {
    constructor(phase, code, detail = {}) { super(`${phase}:${code}`); this.phase = phase; this.code = code; this.detail = detail; }
}
export class DbError extends Error {
    constructor(phase, message) { super(`${phase}:${message}`); this.phase = phase; }
}
