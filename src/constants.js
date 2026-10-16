// src/constants.js
export const ALLOWED_RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 1000, 1500, 2000, 2500, 3000, 5000, 10000];
export const TOP_TARGET = new Set(ALLOWED_RANKS.slice(0, 19)); // 1..10, 20..100 (owns rank 100)
export const BORDER_TARGET = new Set(ALLOWED_RANKS.slice(19)); // 200..10000
// Final boards may lack these: WL chapter borders and main borders before ~event 110 have no 1500/2500 line (probed 2026-10-16).
export const FINAL_OPTIONAL = new Set([1500, 2500]);
export const SLOT_MS = 5 * 60 * 1000;
export const ANNOUNCE_GRACE_MS = 15 * 60 * 1000;
