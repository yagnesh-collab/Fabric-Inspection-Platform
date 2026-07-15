import type { ReactNode } from "react";
import type { HealthData } from "../types";
import styles from "./HealthPanel.module.css";

interface Props {
  health: HealthData | null;
  error: string | null;
}

const TYPE_META: Record<string, { label: string; color: string }> = {
  threshold_exceeded: { label: "Threshold Exceeded", color: "#EF4444" },
  new_anomaly_class:  { label: "New Anomaly Class",  color: "#8B5CF6" },
};

export function HealthPanel({ health, error }: Props) {
  const isOk = health?.status === "ok";

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.iconBox}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
            </svg>
          </div>
          <span className={styles.title}>Cloud Ingestion</span>
        </div>
        <span className={`${styles.badge} ${isOk ? styles.badgeOk : error ? styles.badgeErr : styles.badgeIdle}`}>
          {isOk ? "Healthy" : error ? "Unreachable" : "—"}
        </span>
      </div>

      {error && (
        <div className={styles.errorBanner}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Cannot reach consumer: {error}
        </div>
      )}

      {!health && !error && (
        <div className={styles.loading}>
          <div className={styles.spinner} />
          Connecting to consumer…
        </div>
      )}

      {health && (
        <>
          <div className={styles.eventTypes}>
            {Object.keys(health.events_by_type).length === 0 ? (
              <div className={styles.emptyEvents}>No events recorded yet</div>
            ) : (
              Object.entries(health.events_by_type).map(([type, count]) => {
                const m = TYPE_META[type];
                const total = Object.values(health.events_by_type).reduce((a, b) => a + b, 0);
                const pct = total > 0 ? (count / total) * 100 : 0;
                return (
                  <div key={type} className={styles.eventTypeRow}>
                    <div className={styles.eventTypeHeader}>
                      <div className={styles.eventTypeDot} style={{ background: m?.color ?? "#94A3B8" }} />
                      <span className={styles.eventTypeName}>{m?.label ?? type.replace(/_/g, " ")}</span>
                      <span className={styles.eventTypeCount}>{count.toLocaleString()}</span>
                    </div>
                    <div className={styles.eventBar}>
                      <div
                        className={styles.eventBarFill}
                        style={{ width: `${pct}%`, background: m?.color ?? "#94A3B8" }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className={styles.metaList}>
            <MetaRow
              icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>}
              label="Queue backlog"
              value={health.queue_backlog.toString()}
              warn={health.queue_backlog > 50}
            />
            <MetaRow
              icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
              label="Uptime"
              value={formatUptime(health.uptime_seconds)}
            />
            {health.last_event_at && (
              <MetaRow
                icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
                label="Last event"
                value={new Date(health.last_event_at).toLocaleTimeString()}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MetaRow({ icon, label, value, warn }: { icon: ReactNode; label: string; value: string; warn?: boolean }) {
  return (
    <div className={styles.metaRow}>
      <span className={styles.metaIcon}>{icon}</span>
      <span className={styles.metaLabel}>{label}</span>
      <span className={`${styles.metaValue} ${warn ? styles.metaWarn : ""}`}>{value}</span>
    </div>
  );
}

function formatUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(s % 60)}s`;
}
