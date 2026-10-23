/** One function per admin endpoint of doc 04 §8. */
import { API_BASE, queryString, request } from './client';
import type {
  AdminAccount,
  AdminAreaMap,
  AdminCell,
  AdminDefect,
  AdminFactory,
  AdminMapRow,
  AdminMe,
  AdminPo,
  AdminPoInput,
  AdminPsiUser,
  AdminSubmissionDetail,
  AdminSubmissionSummary,
  AuditFilter,
  AuditLogEntry,
  ImportReport,
  Page,
  PsiLevel,
  SubmissionFilter,
} from './types';
import type { Po } from '@m100/shared';

// Session and own password.
export const login = (username: string, password: string) =>
  request<void>('/auth/login', { method: 'POST', body: { username, password } });
export const logout = () => request<void>('/auth/logout', { method: 'POST' });
export const me = () => request<AdminMe>('/me');
export const changeOwnPassword = (currentPassword: string, newPassword: string) =>
  request<void>('/me/password', { method: 'POST', body: { currentPassword, newPassword } });

// A2 PSI users.
export const listPsiUsers = () => request<AdminPsiUser[]>('/psi-users');
export const createPsiUser = (body: { username: string; level: PsiLevel }) =>
  request<AdminPsiUser>('/psi-users', { method: 'POST', body });
export const updatePsiUser = (
  id: number,
  body: Partial<{ username: string; level: PsiLevel; active: boolean }>,
) => request<AdminPsiUser>(`/psi-users/${id}`, { method: 'PATCH', body });

// A3 Factories and cells.
export const listFactories = () => request<AdminFactory[]>('/factories');
export const createFactory = (name: string) =>
  request<AdminFactory>('/factories', { method: 'POST', body: { name } });
export const updateFactory = (id: number, body: Partial<{ name: string; active: boolean }>) =>
  request<AdminFactory>(`/factories/${id}`, { method: 'PATCH', body });
export const listCells = (factoryId?: number) =>
  request<AdminCell[]>('/cells', { query: { factoryId } });
export const createCell = (factoryId: number, code: string) =>
  request<AdminCell>('/cells', { method: 'POST', body: { factoryId, code } });
export const updateCell = (
  id: number,
  body: Partial<{ factoryId: number; code: string; active: boolean }>,
) => request<AdminCell>(`/cells/${id}`, { method: 'PATCH', body });

// A4 POs.
export const searchPos = (q: string) => request<AdminPo[]>('/pos', { query: { q } });
export const createPo = (body: Po) => request<AdminPo>('/pos', { method: 'POST', body });
export const updatePo = (po: string, body: AdminPoInput) =>
  request<AdminPo>(`/pos/${encodeURIComponent(po)}`, { method: 'PATCH', body });

// A5 Defects and area map.
export const listDefects = () => request<AdminDefect[]>('/defects');
export const updateDefect = (id: string, active: boolean) =>
  request<AdminDefect>(`/defects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { active },
  });
export const getAreaMap = () => request<AdminAreaMap>('/area-map');
export const updateMapRow = (id: string, active: boolean) =>
  request<AdminMapRow>(`/area-map/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { active },
  });

/** The two imports of the 3-step flow (doc 05 §20.5): a dry run first, then the real run. */
export type ImportKind = 'pos' | 'area-map';
export function runImport(kind: ImportKind, file: File, dryRun: boolean): Promise<ImportReport> {
  const form = new FormData();
  form.append('file', file);
  return request<ImportReport>(`/${kind}/import`, {
    method: 'POST',
    body: form,
    query: { dryRun },
  });
}

// A1 Submissions (read-only, AC-14.4).
export const listSubmissions = (filter: SubmissionFilter, page: number) =>
  request<Page<AdminSubmissionSummary>>('/submissions', { query: { ...filter, page } });
export const getSubmission = (id: string) =>
  request<AdminSubmissionDetail>(`/submissions/${encodeURIComponent(id)}`);
/** A plain link: the browser downloads the file with the session cookie. */
export const exportCsvUrl = (filter: SubmissionFilter) =>
  `${API_BASE}/submissions/export.csv${queryString({ ...filter })}`;
export const photoUrl = (id: number) => `${API_BASE}/photos/${id}`;

// A6 Admins.
export const listAdmins = () => request<AdminAccount[]>('/admins');
export const createAdmin = (username: string, password: string) =>
  request<AdminAccount>('/admins', { method: 'POST', body: { username, password } });
export const setAdminActive = (id: number, active: boolean) =>
  request<AdminAccount>(`/admins/${id}`, { method: 'PATCH', body: { active } });
export const resetAdminPassword = (id: number, password: string) =>
  request<AdminAccount>(`/admins/${id}`, { method: 'PATCH', body: { password } });

// A7 Audit log.
export const readAuditLog = (filter: AuditFilter, page: number) =>
  request<Page<AuditLogEntry>>('/audit-log', { query: { ...filter, page } });
