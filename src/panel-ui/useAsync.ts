import { useCallback, useEffect, useState } from 'react';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
}

/**
 * The whole data layer. A screen gets loading/error/data plus reload(), which is every state
 * the panel actually has — react-query would be a cache, an invalidation graph and 40 KB to
 * solve a problem these screens do not have (nothing here is shared between routes).
 *
 * Aborts in flight on unmount and on a dep change, so a fast search-and-navigate cannot land
 * a stale response on top of a fresh one.
 */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): AsyncState<T> & {
  reload: () => void;
  setData: (updater: (prev: T | null) => T | null) => void;
} {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    fn(ac.signal).then(
      (data) => {
        if (!ac.signal.aborted) setState({ data, loading: false, error: null });
      },
      (err: unknown) => {
        if (!ac.signal.aborted) setState({ data: null, loading: false, error: err });
      },
    );
    return () => ac.abort();
    // fn is intentionally not a dep: it is an inline closure, so it is a new identity every
    // render and would refetch forever. The caller lists what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback(
    (updater: (prev: T | null) => T | null) => setState((s) => ({ ...s, data: updater(s.data) })),
    [],
  );

  return { ...state, reload, setData };
}
