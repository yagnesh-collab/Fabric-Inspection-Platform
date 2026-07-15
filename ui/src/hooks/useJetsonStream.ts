import { useEffect, useRef, useState } from "react";
import type { FrameMeta } from "../types";

// Always route through nginx on the same host:port the page was served from.
// This works for both localhost:3000 and any production domain.
const WS_URL =
  typeof window !== "undefined"
    ? `ws://${window.location.host}/ws/stream`
    : "ws://localhost:3000/ws/stream";

export interface StreamState {
  frameDataUrl: string | null;
  meta: FrameMeta | null;
  connected: boolean;
  fps: number;
}

export function useJetsonStream(): StreamState {
  const [frameDataUrl, setFrameDataUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<FrameMeta | null>(null);
  const [connected, setConnected] = useState(false);
  const [fps, setFps] = useState(0);

  const frameTimesRef = useRef<number[]>([]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      ws = new WebSocket(WS_URL);

      ws.onopen = () => setConnected(true);

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === "frame") {
            setFrameDataUrl(`data:image/jpeg;base64,${msg.data as string}`);
            setMeta(msg.meta as FrameMeta);

            const now = performance.now();
            frameTimesRef.current.push(now);
            frameTimesRef.current = frameTimesRef.current.filter((t) => now - t <= 1000);
            setFps(frameTimesRef.current.length);
          }
        } catch {
        }
      };

      ws.onclose = () => {
        setConnected(false);
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    return () => {
      reconnectTimer && clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { frameDataUrl, meta, connected, fps };
}
