/**
 * The error codes of doc 04 §6 and the exception that carries one. Every error leaves the API as
 * `application/problem+json` (RFC 9457) through `ProblemFilter`.
 */
import { HttpException } from '@nestjs/common';

interface ProblemSpec {
  status: number;
  title: string;
  retryable: boolean;
  /** Indonesian text the tablet shows as is; absent where doc 04 §6 shows "—". */
  detail?: string;
}

export const PROBLEMS = {
  DEVICE_KEY_INVALID: {
    status: 401,
    title: 'Device key invalid',
    retryable: false,
    detail: 'Tablet belum terdaftar. Hubungi admin.',
  },
  TOKEN_INVALID: {
    status: 401,
    title: 'Token invalid',
    retryable: false,
    detail: 'Sesi login tidak valid. Silakan login ulang.',
  },
  // Retryable after a refresh (doc 04 §5); the tablet handles it silently.
  TOKEN_EXPIRED: { status: 401, title: 'Token expired', retryable: true },
  USER_NOT_FOUND: {
    status: 422,
    title: 'User not found',
    retryable: false,
    detail: 'Nama tidak ada di daftar PSI.',
  },
  CELL_NOT_FOUND: {
    status: 422,
    title: 'Cell not found',
    retryable: false,
    detail: 'Factory/Cell tidak ditemukan.',
  },
  PO_NOT_FOUND: {
    status: 404,
    title: 'PO not found',
    retryable: false,
    detail: 'PO tidak ditemukan di master PO.',
  },
  SUBMISSION_UUID_REUSED: {
    status: 409,
    title: 'Submission UUID reused',
    retryable: false,
    detail: 'Data kiriman berbeda dengan kiriman sebelumnya. Hubungi admin.',
  },
  // VALIDATION_FAILED, PHOTO_MISSING and SUBMIT_DISABLED have no fixed text: the caller fills the doc 04 §6
  // template ("Data tidak lengkap: …", "Foto wajib untuk: …", "Pengiriman sedang dinonaktifkan: …").
  VALIDATION_FAILED: { status: 422, title: 'Validation failed', retryable: false },
  PHOTO_MISSING: { status: 422, title: 'Photo missing', retryable: false },
  PHOTO_NOT_ALLOWED: {
    status: 422,
    title: 'Photo not allowed',
    retryable: false,
    detail: 'PSI lv.1 tidak mengirim foto.',
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    title: 'Payload too large',
    retryable: false,
    detail: 'Ukuran foto terlalu besar.',
  },
  RATE_LIMITED: { status: 429, title: 'Rate limited', retryable: true },
  SUBMIT_DISABLED: { status: 503, title: 'Submit disabled', retryable: true },
  DB_UNAVAILABLE: { status: 503, title: 'Database unavailable', retryable: true },
  PHOTO_STORE_UNAVAILABLE: { status: 503, title: 'Photo store unavailable', retryable: true },
  ADMIN_AUTH_REQUIRED: { status: 401, title: 'Admin login required', retryable: false },
  ADMIN_LOGIN_FAILED: { status: 401, title: 'Admin login failed', retryable: false },
  ADMIN_LOCKED: { status: 423, title: 'Admin account locked', retryable: false },
  NOT_FOUND: { status: 404, title: 'Not found', retryable: false },
  CONFLICT: { status: 409, title: 'Conflict', retryable: false },
  IMPORT_INVALID: { status: 422, title: 'Import invalid', retryable: false },
  INTERNAL: {
    status: 500,
    title: 'Internal error',
    retryable: true,
    detail: 'Terjadi kesalahan server. Data tetap tersimpan di tablet.',
  },
} as const satisfies Record<string, ProblemSpec>;

export type ProblemCode = keyof typeof PROBLEMS;

export interface ProblemError {
  path: string;
  code: string;
  message: string;
}

/** The `Problem` schema of `04-openapi.yaml`. */
export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  retryable: boolean;
  detail?: string;
  errors?: ProblemError[];
}

export interface ProblemOptions {
  /** Replaces the default text, e.g. with the list of failed checks. */
  detail?: string;
  errors?: ProblemError[];
  /** Seconds, sent as `Retry-After` (429, 503). */
  retryAfter?: number;
  /** Only where doc 04 allows another status for the code (`PO_NOT_FOUND` is 404 or 422). */
  status?: number;
}

export class ApiProblem extends HttpException {
  readonly body: ProblemBody;
  readonly retryAfter?: number;

  constructor(
    readonly code: ProblemCode,
    options: ProblemOptions = {},
  ) {
    const spec: ProblemSpec = PROBLEMS[code];
    const status = options.status ?? spec.status;
    super(code, status);
    const detail = options.detail ?? spec.detail;
    this.body = {
      type: `https://m100/errors/${code.toLowerCase().replace(/_/g, '-')}`,
      title: spec.title,
      status,
      code,
      retryable: spec.retryable,
      ...(detail === undefined ? {} : { detail }),
      ...(options.errors === undefined ? {} : { errors: options.errors }),
    };
    this.retryAfter = options.retryAfter;
  }
}
