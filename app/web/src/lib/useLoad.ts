import { useCallback, useEffect, useRef, useState } from "react";

export interface Load<T> { data: T | undefined; error: string | null; loading: boolean; reload: () => void; setData: (d: T) => void }

/** Runs `fn` when `deps` change; a stale response from an earlier dep set is dropped. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Load<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    fnRef.current().then(
      (d) => { if (mine === seq.current) { setData(d); setLoading(false); } },
      (e: unknown) => { if (mine === seq.current) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } },
    );
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}
