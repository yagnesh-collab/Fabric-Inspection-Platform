import type { AlertItem } from "../hooks/useAlertHistory";
import styles from "./AlertList.module.css";

interface Props {
  alerts: AlertItem[];
}

export function AlertList({ alerts }: Props) {
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.iconBox}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
            </svg>
          </div>
          <span className={styles.title}>Alerts</span>
        </div>
        {alerts.length > 0 && (
          <span className={styles.countBadge}>{alerts.length}</span>
        )}
      </div>

      <div className={styles.list} role="list">
        {alerts.length === 0 ? (
          <div className={styles.empty}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className={styles.emptyIcon}>
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
            </svg>
            <span className={styles.emptyTitle}>No alerts yet</span>
            <span className={styles.emptyHint}>Alerts appear when confidence exceeds threshold</span>
          </div>
        ) : (
          alerts.map((a, i) => (
            <div key={a.id} className={styles.item} role="listitem" style={{ animationDelay: `${Math.min(i, 5) * 20}ms` }}>
              <div className={styles.itemLeft}>
                <div className={styles.severityBar} />
                <div className={styles.itemMeta}>
                  <span className={styles.itemClass}>
                    {a.anomaly_class.replace(/_/g, " ")}
                  </span>
                  <span className={styles.itemTime}>
                    {new Date(a.timestamp * 1000).toLocaleTimeString()}
                  </span>
                </div>
              </div>
              <div className={styles.confPill}>
                {(a.confidence * 100).toFixed(1)}%
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
