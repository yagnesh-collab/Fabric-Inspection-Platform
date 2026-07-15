import { useEffect, useRef, useState } from "react";
import type { FrameMeta } from "../types";

const HISTORY_LIMIT = 30;

export interface AlertItem {
  id: string;
  anomaly_class: string;
  confidence: number;
  frame_id: string;
  timestamp: number;
}

export function useAlertHistory(meta: FrameMeta | null) {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const lastFrameIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!meta) return;
    if (meta.frame_id === lastFrameIdRef.current) return;
    lastFrameIdRef.current = meta.frame_id;

    if (meta.threshold_exceeded && meta.anomaly_class) {
      const item: AlertItem = {
        id: meta.frame_id,
        anomaly_class: meta.anomaly_class,
        confidence: meta.confidence,
        frame_id: meta.frame_id,
        timestamp: meta.timestamp,
      };
      setAlerts((prev) => [item, ...prev].slice(0, HISTORY_LIMIT));
    }
  }, [meta]);

  return alerts;
}
