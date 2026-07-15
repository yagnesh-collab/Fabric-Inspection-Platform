export interface FrameMeta {
  frame_id: string;
  frame_index: number;
  device_id: string;
  anomaly_class: string | null;
  confidence: number;
  has_anomaly: boolean;
  threshold: number;
  threshold_exceeded: boolean;
  timestamp: number;
}

export interface HealthData {
  status: string;
  uptime_seconds: number;
  processed_total: number;
  queue_backlog: number;
  events_by_type: Record<string, number>;
  last_event_at: string | null;
  db_event_count: number | null;
}
