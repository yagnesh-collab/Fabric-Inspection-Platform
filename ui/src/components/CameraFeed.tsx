import { useState, useEffect, useCallback } from "react";
import type { FrameMeta } from "../types";
import styles from "./CameraFeed.module.css";

interface Props {
  frameDataUrl: string | null;
  meta: FrameMeta | null;
  connected: boolean;
  fps: number;
}

export function CameraFeed({ frameDataUrl, meta, connected, fps }: Props) {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const thresholdExceeded = meta?.threshold_exceeded ?? false;
  const hasAnomaly        = meta?.has_anomaly ?? false;
  const confidence        = meta?.confidence ?? 0;
  const anomalyClass      = (meta?.anomaly_class ?? "unknown").replace(/_/g, " ");
  const confPct           = (confidence * 100).toFixed(1);
  const confColor         = thresholdExceeded ? styles.barDanger : hasAnomaly ? styles.barWarn : styles.barOk;

  const openLightbox  = useCallback(() => frameDataUrl && setLightboxOpen(true), [frameDataUrl]);
  const closeLightbox = useCallback(() => setLightboxOpen(false), []);

  useEffect(() => {
    if (!lightboxOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") closeLightbox(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lightboxOpen, closeLightbox]);

  useEffect(() => {
    document.body.style.overflow = lightboxOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [lightboxOpen]);

  return (
    <>
      {/* === Dashboard thumbnail === */}
      <div className={`${styles.card} ${thresholdExceeded ? styles.alertCard : ""}`}>
        <div
          className={`${styles.feedWrapper} ${frameDataUrl ? styles.clickable : ""}`}
          onClick={openLightbox}
          role={frameDataUrl ? "button" : undefined}
          aria-label="Expand camera feed"
          tabIndex={frameDataUrl ? 0 : undefined}
          onKeyDown={(e) => e.key === "Enter" && openLightbox()}
        >
          {frameDataUrl ? (
            <img src={frameDataUrl} alt="Live fabric feed" className={styles.frame} />
          ) : (
            <div className={styles.placeholder}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.894L15 14"/>
                <rect x="3" y="6" width="12" height="12" rx="2"/>
              </svg>
              <span>Waiting for stream…</span>
            </div>
          )}

          {/* badges */}
          <div className={styles.topRow}>
            <div className={`${styles.liveBadge} ${connected ? styles.liveOn : styles.liveOff}`}>
              <span className={connected ? styles.liveDot : styles.offlineDot} />
              {connected ? "LIVE" : "OFFLINE"}
            </div>
            {connected && <div className={styles.fpsBadge}>{fps} fps</div>}
          </div>

          {/* bottom scrim */}
          {meta && !thresholdExceeded && (
            <div className={styles.bottomMeta}>
              <span className={styles.frameNum}>#{meta.frame_index.toLocaleString()}</span>
              <span className={styles.deviceId}>{meta.device_id}</span>
            </div>
          )}

          {thresholdExceeded && (
            <div className={styles.alertBanner}>
              <div className={styles.alertIconWrap}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
              </div>
              <div className={styles.alertBannerText}>
                <span className={styles.alertTitle}>Threshold Exceeded</span>
                <span className={styles.alertClass}>{anomalyClass}</span>
              </div>
              <div className={styles.alertConf}>{confPct}%</div>
            </div>
          )}

          {/* hover expand hint */}
          {frameDataUrl && (
            <div className={styles.expandHint}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
                <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
              </svg>
              Expand
            </div>
          )}
        </div>

        {meta && (
          <div className={styles.metaStrip}>
            <div className={styles.classChip} data-type={thresholdExceeded ? "danger" : hasAnomaly ? "warn" : "ok"}>
              {hasAnomaly ? anomalyClass : "No defect"}
            </div>
            <div className={styles.confGroup}>
              <span className={styles.confLabel}>Confidence</span>
              <div className={styles.confBarTrack}>
                <div className={`${styles.confBarFill} ${confColor}`} style={{ width: `${confPct}%` }} />
              </div>
              <span className={styles.confPct}>{confPct}%</span>
            </div>
            <div className={styles.threshold}>Threshold <span>{(meta.threshold * 100).toFixed(0)}%</span></div>
          </div>
        )}
      </div>

      {/* === Lightbox modal === */}
      {lightboxOpen && (
        <div className={styles.backdrop} onClick={closeLightbox} aria-modal="true" role="dialog" aria-label="Camera feed fullscreen">
          <button className={styles.closeBtn} onClick={closeLightbox} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>

          <div className={styles.lightboxContent} onClick={(e) => e.stopPropagation()}>
            <div className={`${styles.lightboxFeed} ${thresholdExceeded ? styles.lightboxAlert : ""}`}>
              <img src={frameDataUrl!} alt="Fabric feed fullscreen" className={styles.lightboxImg} />

              <div className={styles.topRow}>
                <div className={`${styles.liveBadge} ${connected ? styles.liveOn : styles.liveOff}`}>
                  <span className={connected ? styles.liveDot : styles.offlineDot} />
                  {connected ? "LIVE" : "OFFLINE"}
                </div>
                {connected && <div className={styles.fpsBadge}>{fps} fps</div>}
              </div>

              {thresholdExceeded && (
                <div className={styles.alertBanner}>
                  <div className={styles.alertIconWrap}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                  </div>
                  <div className={styles.alertBannerText}>
                    <span className={styles.alertTitle}>Threshold Exceeded</span>
                    <span className={styles.alertClass}>{anomalyClass}</span>
                  </div>
                  <div className={styles.alertConf}>{confPct}%</div>
                </div>
              )}
            </div>

            {meta && (
              <div className={styles.lightboxMeta}>
                <div className={styles.lightboxMetaLeft}>
                  <div className={styles.classChip} data-type={thresholdExceeded ? "danger" : hasAnomaly ? "warn" : "ok"}>
                    {hasAnomaly ? anomalyClass : "No defect"}
                  </div>
                  <span className={styles.lightboxFrameNum}>Frame #{meta.frame_index.toLocaleString()}</span>
                  <span className={styles.lightboxDevice}>{meta.device_id}</span>
                </div>
                <div className={styles.confGroup}>
                  <span className={styles.confLabel}>Confidence</span>
                  <div className={styles.confBarTrack} style={{ width: "120px" }}>
                    <div className={`${styles.confBarFill} ${confColor}`} style={{ width: `${confPct}%` }} />
                  </div>
                  <span className={styles.confPct}>{confPct}%</span>
                </div>
                <div className={styles.threshold}>Threshold <span>{(meta.threshold * 100).toFixed(0)}%</span></div>
                <span className={styles.escHint}>ESC to close</span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
