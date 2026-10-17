// One AbortController per round: every DB call takes `signal`, `race` rejects at the deadline (spec §7).
export function makeDeadline(ms) {
    const ctrl = new AbortController(), start = Date.now(); let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ctrl.abort(); rej(new Error(`deadline ${ms} ms exceeded`)); }, ms); });
    timeout.catch(() => {});
    return { signal: ctrl.signal, timeout, race: (p) => Promise.race([p, timeout]), elapsed: () => Date.now() - start, expired: () => ctrl.signal.aborted, clear: () => clearTimeout(timer) };
}
