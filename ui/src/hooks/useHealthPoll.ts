import { useCallback, useEffect, useRef, useState } from "react";
import type { HealthData } from "../types";

// Always route through nginx on the same host:port the page was served from.
const BASE =
  typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.host}/api/consumer`
    : "http://localhost:3000/api/consumer";

const API_KEY = import.meta.env.VITE_API_KEY as string;

export function useHealthPoll(intervalMs = 3000) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/health`, {
        headers: { "X-API-Key": API_KEY },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as HealthData;
      setHealth(data);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    fetch_();
    timerRef.current = setInterval(fetch_, intervalMs);
    return () => {
      timerRef.current && clearInterval(timerRef.current);
    };
  }, [fetch_, intervalMs]);

  return { health, error };
}
