// Strata, the params document (v1) and its backoff lookups (spec §4.1, §4.4). Everything infer needs is a lookup here.
export const FAMILIES = ['main', 'wl'];
export const GROUPS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'];
export const MEMBERS = ['linear', 'measured', 'prior', 'profile'];
export const BIN_EDGES = [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1];
export const BIN_MID = [0.075, 0.225, 0.4, 0.6, 0.775, 0.925];
export const HTE_EDGES = [0, 1, 2, 3, 4, 6, 9, 12, 18, 24];   // hours to end, last bin open
export const HFS_EDGES = [0, 1, 2, 3, 6, 12, 24];              // hours from start, last bin open
export const DEFAULT_SIGMA = 0.25, DEFAULT_Q10 = -0.32, DEFAULT_Q90 = 0.32, SIGMA_FLOOR = 0.03;
export const MIN_N_SIGMA = 8, MIN_N_QUANT = 20, PRIOR_MAX_SAMPLES = 12;

export function rankGroup(rank) { if (rank <= 3) return 'G1'; if (rank <= 10) return 'G2'; if (rank <= 100) return 'G3'; if (rank <= 500) return 'G4'; if (rank === 1000) return 'G5'; return 'G6'; }
export function progressBin(tau) { if (!(tau > 0)) return 0; for (let i = 1; i < BIN_EDGES.length - 1; i++) if (tau < BIN_EDGES[i]) return i - 1; return BIN_EDGES.length - 2; }
export const familyOf = (chapter) => (chapter === 0 ? 'main' : 'wl');
export const PROFILE_HOD_BINS = (group) => (group === 'G6' ? 8 : 24);
export const cellKey = (family, group, bin) => `${family}:${group}:${bin}`;
export const groupKey = (family, group) => `${family}:${group}`;
export const priorKey = (family, type, days, rank) => `${family}:${family === 'wl' ? '-' : (type ?? '-')}:${days}:${rank}`;

export function lookupSigma(params, family, group, bin, member) {
    const c = params.sigma.cell?.[cellKey(family, group, bin)]?.[member]; if (c && c.n >= MIN_N_SIGMA) return { sigma: Math.max(c.s, SIGMA_FLOOR), level: 1 };
    const g = params.sigma.group?.[groupKey(family, group)]?.[member]; if (g && g.n >= MIN_N_SIGMA) return { sigma: Math.max(g.s, SIGMA_FLOOR), level: 2 };
    const f = params.sigma.family?.[family]?.[member]; if (f && f.n >= MIN_N_SIGMA) return { sigma: Math.max(f.s, SIGMA_FLOOR), level: 3 };
    return { sigma: DEFAULT_SIGMA, level: 4 };
}
export function lookupQuantiles(params, family, group, bin) {
    const c = params.resid.cell?.[cellKey(family, group, bin)]; if (c && c.n >= MIN_N_QUANT) return { q10: c.q10, q90: c.q90, n: c.n, level: 1 };
    const g = params.resid.group?.[groupKey(family, group)]; if (g && g.n >= MIN_N_QUANT) return { q10: g.q10, q90: g.q90, n: g.n, level: 2 };
    const f = params.resid.family?.[family]; if (f && f.n >= MIN_N_QUANT) return { q10: f.q10, q90: f.q90, n: f.n, level: 3 };
    return { q10: DEFAULT_Q10, q90: DEFAULT_Q90, n: 0, level: 4 };
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isCount = (x) => Number.isInteger(x) && x >= 0;
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
export function validateParams(p) {
    const errors = [];
    const err = (m) => errors.push(m);
    if (!isObj(p)) return { ok: false, errors: ['params is not an object'] };
    if (p.version !== 1) err('version must be 1');
    if (typeof p.trained_at !== 'string' || Number.isNaN(Date.parse(p.trained_at))) err('trained_at must be an ISO date');
    if (!isObj(p.input) || !isCount(p.input.main_periods) || !isCount(p.input.wl_periods) || !isCount(p.input.prior_rows) || !Array.isArray(p.input.excluded) || !p.input.excluded.every(Number.isInteger)) err('input malformed');
    if (!isObj(p.profile)) err('profile must be an object'); else for (const [k, v] of Object.entries(p.profile)) {
        const h = k.endsWith(':G6') ? 8 : 24;
        if (!isObj(v) || !Array.isArray(v.hod) || v.hod.length !== h || !Array.isArray(v.hte) || v.hte.length !== 10 || !Array.isArray(v.hfs) || v.hfs.length !== 7) { err(`profile ${k} shape`); continue; }
        if (![...v.hod, ...v.hte, ...v.hfs, v.wk].every(fin) || !isCount(v.n) || !isCount(v.lines)) err(`profile ${k} values`);
    }
    for (const lvl of ['cell', 'group', 'family']) {
        if (!isObj(p.sigma) || !isObj(p.sigma[lvl])) { err(`sigma.${lvl} missing`); continue; }
        for (const [k, members] of Object.entries(p.sigma[lvl])) { if (!isObj(members)) { err(`sigma.${lvl}.${k}`); continue; }
            for (const [m, v] of Object.entries(members)) if (!MEMBERS.includes(m) || !isObj(v) || !fin(v.s) || !(v.s > 0 && v.s < 2) || !isCount(v.n)) err(`sigma.${lvl}.${k}.${m}`); }
    }
    for (const lvl of ['cell', 'group', 'family']) {
        if (!isObj(p.resid) || !isObj(p.resid[lvl])) { err(`resid.${lvl} missing`); continue; }
        for (const [k, v] of Object.entries(p.resid[lvl])) if (!isObj(v) || !fin(v.q10) || !fin(v.q90) || v.q10 > v.q90 || !isCount(v.n) || !fin(v.mae) || v.mae < 0 || !fin(v.cover) || v.cover < 0 || v.cover > 1) err(`resid.${lvl}.${k}`);
    }
    if (!isObj(p.prior)) err('prior must be an object'); else for (const [k, v] of Object.entries(p.prior)) if (!isObj(v) || !fin(v.m) || !isCount(v.n)) err(`prior.${k}`);
    if (!isObj(p.periods)) err('periods must be an object'); else for (const [k, v] of Object.entries(p.periods)) if (!isObj(v) || !fin(v.mae) || !isCount(v.n)) err(`periods.${k}`);
    return { ok: errors.length === 0, errors };
}
