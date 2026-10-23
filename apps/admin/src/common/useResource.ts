import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

export type Resource<T> =
  | { state: 'loading'; data?: undefined; error?: undefined }
  | { state: 'ok'; data: T; error?: undefined }
  | { state: 'error'; data?: undefined; error: ApiError };

/**
 * Loads `load()` whenever `key` changes, and again on `reload()`. Until the answer for the current key arrives the
 * resource is `loading`; an answer for an older key is dropped.
 */
export function useResource<T>(
  load: () => Promise<T>,
  key: string,
): Resource<T> & { reload: () => void } {
  const [round, setRound] = useState(0);
  const token = `${round}:${key}`;
  const [settled, setSettled] = useState<{ token: string; resource: Resource<T> } | null>(null);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let current = true;
    loadRef.current().then(
      (data) => {
        if (current) setSettled({ token, resource: { state: 'ok', data } });
      },
      (error: unknown) => {
        if (current) setSettled({ token, resource: { state: 'error', error: asApiError(error) } });
      },
    );
    return () => {
      current = false;
    };
  }, [token]);

  const reload = useCallback(() => setRound((r) => r + 1), []);
  const resource: Resource<T> = settled?.token === token ? settled.resource : { state: 'loading' };
  return { ...resource, reload };
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError({
    status: 0,
    code: 'CLIENT',
    detail: error instanceof Error ? error.message : String(error),
  });
}
