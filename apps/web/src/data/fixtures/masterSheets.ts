/**
 * Phase 1 stand-ins for the `USER_LIST` and `DB_CELL` sheets (doc 02 §3.1–3.2), as raw rows so the login
 * rules are exercised. Every name is invented: no real name from `USER_LIST` may appear here (doc 08).
 */
import type { Cell, UserListRow } from '@m100/shared';

export const USER_LIST: readonly UserListRow[] = [
  { username: 'DEWI CONTOH', typeInspection: 'PSI lv.2' },
  { username: 'ANDI CONTOH', typeInspection: 'PSI lv.1' },
  { username: 'GITA CONTOH', typeInspection: 'CFA' },
  { username: 'BUNGA CONTOH', typeInspection: 'PSI lv.1' },
  { username: 'EKO CONTOH', typeInspection: 'PSI lv.2' },
  { username: 'HADI CONTOH', typeInspection: 'T1QM' },
  // Listed twice with the same type: shown once.
  { username: 'ANDI CONTOH', typeInspection: 'PSI lv.1' },
  { username: 'INDAH CONTOH', typeInspection: 'AQL3RD PARTY' },
  // CFA and PSI: shown once, as PSI.
  { username: 'FAJAR CONTOH', typeInspection: 'CFA' },
  { username: 'FAJAR CONTOH', typeInspection: 'PSI lv.2' },
  { username: 'CAHYA CONTOH', typeInspection: 'PSI lv.1' },
];

export const DB_CELL: readonly Cell[] = [
  { factory: 'F 1', cell: 'F1-01' },
  { factory: 'F 3', cell: 'F3-10' },
  { factory: 'F 3', cell: 'F3-11' },
  { factory: 'F 3', cell: 'F3-12' },
  // Not offered at login.
  { factory: 'PWA', cell: 'PWA' },
  { factory: 'BOTTOM', cell: '-' },
];
