/**
 * The neutral model. The agent, the replay builder and the renderer only ever
 * see these shapes. Nothing in here knows which observability tool the data
 * came from; adapters translate into it.
 */

/** Unix time in seconds. */
export type Ts = number;

export interface TimeRange {
  start: Ts;
  end: Ts;
  /** Seconds between samples. */
  step: number;
}

/** The three request signals every backend can express for a service. */
export type Signal = "rate" | "error_ratio" | "latency_p95";

export const SIGNAL_UNITS: Record<Signal, string> = {
  rate: "req/s",
  error_ratio: "ratio",
  latency_p95: "seconds",
};

export interface ServiceRef {
  /** Stable id used on edges and series. */
  id: string;
  /** Optional placement labels, shown as-is. */
  cloud?: string;
  cluster?: string;
  kind?: "service" | "database" | "queue" | "external";
}

export interface EdgeRef {
  from: string;
  to: string;
}

/** One value per step of the range; null where the backend had no sample. */
export type Samples = (number | null)[];

export interface ServiceSeries {
  service: string;
  rate: Samples;
  errorRatio: Samples;
  latencyP95: Samples;
}

export interface EdgeSeries extends EdgeRef {
  rate: Samples;
  errorRatio: Samples;
}

/** Topology plus its request signals over a time range. */
export interface ServiceGraphSeries {
  range: TimeRange;
  services: ServiceRef[];
  serviceSeries: ServiceSeries[];
  edgeSeries: EdgeSeries[];
}

export interface AlertEvent {
  name: string;
  severity?: string;
  service?: string;
  /** When it started firing; undefined endsAt means still firing. */
  startsAt: Ts;
  endsAt?: Ts;
  summary?: string;
}

/**
 * What a workload consumed against what it asked for. CPU is in cores, memory
 * in bytes. `restarts` is the number of container restarts within each step.
 */
export interface ResourceSeries {
  service: string;
  cpuUsage: Samples;
  cpuRequest: Samples;
  /** Share of CPU periods in which the workload was throttled, 0 to 1. */
  cpuThrottled: Samples;
  memUsage: Samples;
  memLimit: Samples;
  restarts: Samples;
  replicas: Samples;
}

/** A deploy, rollback, config change: anything that changed the system. */
export interface ChangeEvent {
  at: Ts;
  service?: string;
  kind: "deploy" | "rollback" | "config" | "scale" | "other";
  description: string;
}

/**
 * The query an adapter actually ran, in the backend's own language, so any
 * number on screen can be checked in the source tool.
 */
export interface SourceQuery {
  purpose: string;
  language: string;
  query: string;
}

export function stepsIn(range: TimeRange): number {
  return Math.floor((range.end - range.start) / range.step) + 1;
}

export function tsAt(range: TimeRange, i: number): Ts {
  return range.start + i * range.step;
}
