import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/auth";

export function useSecurityData<T>(url: string, intervalMs = 30000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const previousUrl = useRef(url);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision requests a fresh load after a mutation.
  useEffect(() => {
    let alive = true;
    let pending = false;
    if (previousUrl.current !== url) setData(null);
    previousUrl.current = url;
    setLoading(true);
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const result = await api<T>(url);
        if (alive) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (alive)
          setError(
            e instanceof Error ? e.message : "Could not load security data.",
          );
      } finally {
        pending = false;
        if (alive) setLoading(false);
      }
    }
    void load();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, intervalMs);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [url, revision, intervalMs]);
  return { data, error, loading, refresh };
}
export function when(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString() : "Not reported";
}
export function label(value: string) {
  return value.replace(/[._-]/g, " ").replace(/^./, (c) => c.toUpperCase());
}
