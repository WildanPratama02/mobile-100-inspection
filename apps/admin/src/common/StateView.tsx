/** The standard states of doc 05 §20.8: loading "Memuat…", empty (a sentence and the action), error (`Notice`). */
import type { ReactNode } from 'react';
import { Button, Notice } from '@m100/ui';
import type { ApiError } from '../api/client';

export const LOADING_TEXT = 'Memuat…';

export function Loading() {
  return (
    <p className="adm-state" role="status" aria-live="polite">
      {LOADING_TEXT}
    </p>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="adm-state adm-state--empty">
      <p>{children}</p>
      {action}
    </div>
  );
}

/** The server's list of problems (409, 422 with `errors`). */
export function ProblemList({ error }: { error: ApiError }) {
  if (error.errors.length === 0) return null;
  return (
    <ul className="adm-problems">
      {error.errors.map((e, i) => (
        <li key={i}>
          {e.path ? <b>{e.path}: </b> : null}
          {e.message}
        </li>
      ))}
    </ul>
  );
}

/** A danger `Notice` with the API `detail` and its list of problems, or with `text` that replaces both. */
export function ProblemNotice({ error, text }: { error: ApiError; text?: string }) {
  return (
    <Notice tone="danger">
      {text ?? error.detail}
      {text ? null : <ProblemList error={error} />}
    </Notice>
  );
}

/** A failed load: the API `detail` and COBA LAGI. */
export function LoadError({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="adm-state">
      <ProblemNotice error={error} />
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          COBA LAGI
        </Button>
      ) : null}
    </div>
  );
}
