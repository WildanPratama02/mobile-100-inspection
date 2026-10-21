/**
 * The login lists built from the master sheets (doc 02 §3.1–3.2). Pure functions: the API builds the
 * `/master-data` document with them, and the web test fixtures go through the same rules.
 */
import type { Cell, Factory, PsiLevel, User } from './domain';

/** One `USER_LIST` row: `USERNAME` and `TYPE INSPECTION` as text (`ID` is not used). */
export interface UserListRow {
  username: string;
  typeInspection: string;
}

const PSI_LEVELS: readonly string[] = ['PSI lv.1', 'PSI lv.2'] satisfies PsiLevel[];

function isPsiLevel(type: string): type is PsiLevel {
  return PSI_LEVELS.includes(type);
}

/**
 * Login names: distinct (username, level) of the PSI types only, sorted by name (AC-01.1). A name listed
 * twice with the same type appears once; a name at both PSI levels appears once per level.
 */
export function loginUsers(rows: readonly UserListRow[]): User[] {
  const seen = new Set<string>();
  const users: User[] = [];
  for (const { username, typeInspection } of rows) {
    if (!isPsiLevel(typeInspection)) continue;
    const key = `${username}\u0000${typeInspection}`;
    if (seen.has(key)) continue;
    seen.add(key);
    users.push({ username, level: typeInspection });
  }
  return users.sort(
    (a, b) => a.username.localeCompare(b.username, 'id') || a.level.localeCompare(b.level),
  );
}

/** `F 1` … `F 5` today; `PWA` and `BOTTOM` are not offered (decided 16 Oct 2026). */
const FACTORY = /^F \d+$/;

/** Factories of the form `F <number>` in sheet order, each with its distinct cells; `rows` are `DB_CELL`. */
export function loginFactories(rows: readonly Cell[]): Factory[] {
  const byFactory = new Map<string, string[]>();
  for (const { factory, cell } of rows) {
    if (!FACTORY.test(factory)) continue;
    const cells = byFactory.get(factory) ?? [];
    if (!cells.includes(cell)) cells.push(cell);
    byFactory.set(factory, cells);
  }
  return [...byFactory].map(([factory, cells]) => ({ factory, cells }));
}
