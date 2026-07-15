import { useState, useEffect } from "react";
import { useAlertHistory } from "./hooks/useAlertHistory";
import { useHealthPoll } from "./hooks/useHealthPoll";
import { useJetsonStream } from "./hooks/useJetsonStream";
import { AlertList } from "./components/AlertList";
import { CameraFeed } from "./components/CameraFeed";
import { HealthPanel } from "./components/HealthPanel";
import styles from "./App.module.css";

function useCurrentTime() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

function formatUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(s % 60)}s`;
}

export default function App() {
  const { frameDataUrl, meta, connected, fps } = useJetsonStream();
  const { health, error } = useHealthPoll(3000);
  const alerts = useAlertHistory(meta);
  const now = useCurrentTime();

  const isOnline = health?.status === "ok";

  const timeStr = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.logoGroup}>
          <div className={styles.logoMark}>N</div>
          <span className={styles.wordmark}>Nextex</span>
          <span className={styles.slash}>/</span>
          <span className={styles.pageName}>Fabric Inspection</span>
        </div>
        <div className={styles.headerRight}>
          <div
            className={`${styles.statusPill} ${
              isOnline ? styles.pillOnline : error ? styles.pillOffline : styles.pillIdle
            }`}
          >
            <span
              className={`${styles.statusDot} ${
                isOnline ? styles.dotOnline : error ? styles.dotOffline : styles.dotIdle
              }`}
            />
            {isOnline ? "System Online" : error ? "Offline" : "Connecting"}
          </div>
          <span className={styles.clock}>{timeStr}</span>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.grid}>
          <div className={styles.leftCol}>
            <CameraFeed
              frameDataUrl={frameDataUrl}
              meta={meta}
              connected={connected}
              fps={fps}
            />

            <div className={styles.kpiRow}>
              <div className={styles.kpi}>
                <span className={styles.kpiLabel}>Total Events</span>
                <span className={styles.kpiValue}>
                  {health?.processed_total?.toLocaleString() ?? "—"}
                </span>
              </div>
              <div className={styles.kpi}>
                <span className={styles.kpiLabel}>DB Persisted</span>
                <span className={styles.kpiValue}>
                  {health?.db_event_count?.toLocaleString() ?? "—"}
                </span>
              </div>
              <div className={styles.kpi}>
                <span className={styles.kpiLabel}>Queue Backlog</span>
                <span
                  className={`${styles.kpiValue} ${
                    (health?.queue_backlog ?? 0) > 50 ? styles.kpiWarn : ""
                  }`}
                >
                  {health?.queue_backlog ?? "—"}
                </span>
              </div>
              <div className={styles.kpi}>
                <span className={styles.kpiLabel}>Uptime</span>
                <span className={styles.kpiValue}>
                  {health ? formatUptime(health.uptime_seconds) : "—"}
                </span>
              </div>
            </div>
          </div>

          <div className={styles.rightCol}>
            <HealthPanel health={health} error={error} />
            <AlertList alerts={alerts} />
          </div>
        </div>
      </main>
    </div>
  );
}
