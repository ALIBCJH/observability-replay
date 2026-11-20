import type { Adapter, Capabilities } from "./adapters/types.js";
import {
  stepsIn,
  tsAt,
  type AlertEvent,
  type ChangeEvent,
  type EdgeSeries,
  type Samples,
  type ServiceRef,
  type ServiceSeries,
  type SourceQuery,
  type TimeRange,
  type Ts,
} from "./model.js";

/** Hard limits, so no request can pull an unbounded amount of history. */
export const MAX_WINDOW_MINUTES = 360;
export const MIN_WINDOW_MINUTES = 5;
export const MAX_FRAMES = 240;
const MIN_STEP = 15;

export type OnsetSignal = "latency_p95" | "error_ratio" | "rate_drop";

/** The first moment a service's signal left its baseline. */
export interface Onset {
  service: string;
  signal: OnsetSignal;
  at: Ts;
  baseline: number;
  peak: number;
  peakAt: Ts;
}

/** Everything the view needs to draw a replay. Plain JSON. */
export interface ReplayBundle {
  version: 1;
  backend: string;
  capabilities: Capabilities;
  range: TimeRange;
  services: ServiceRef[];
  serviceSeries: ServiceSeries[];
  edgeSeries: EdgeSeries[];
  alerts: AlertEvent[];
  changes: ChangeEvent[];
  onsets: Onset[];
  focus?: string;
  queries: SourceQuery[];
}

/** Turn "the last N minutes (ending at …)" into a bounded, step-aligned range. */
export function resolveRange(
  minutes: number,
  end?: Ts,
  now: Ts = Date.now() / 1000,
  maxFrames: number = MAX_FRAMES,
): TimeRange {
  const m = Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, minutes));
  const window = m * 60;
  const step = Math.max(MIN_STEP, Math.ceil(window / maxFrames / MIN_STEP) * MIN_STEP);
  const alignedEnd = Math.floor(Math.min(end ?? now, now) / step) * step;
  return { start: alignedEnd - window, end: alignedEnd, step };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const SUSTAIN = 3;

/**
 * Find where a series first leaves its baseline and stays out for a few
 * samples. The baseline is the median of the first fifth of the window, so an
 * incident already under way when the window opens will not be detected.
 */
function detect(
  samples: Samples,
  range: TimeRange,
  breached: (v: number, baseline: number) => boolean,
  pickPeak: "max" | "min",
  /** The baseline to assume when the head of the window has too few samples. */
  assumed?: number,
): Omit<Onset, "service" | "signal"> | null {
  const head = samples
    .slice(0, Math.max(5, Math.floor(samples.length / 5)))
    .filter((v): v is number => v !== null);
  if (head.length < 3 && assumed === undefined) return null;
  const baseline = head.length < 3 ? assumed! : median(head);
  let run = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    run = v !== null && v !== undefined && breached(v, baseline) ? run + 1 : 0;
    if (run < SUSTAIN) continue;
    const start = i - SUSTAIN + 1;
    let peak = samples[start]!;
    let peakI = start;
    for (let j = start; j < samples.length; j++) {
      const x = samples[j];
      if (x === null || x === undefined) continue;
      if (pickPeak === "max" ? x > peak : x < peak) {
        peak = x;
        peakI = j;
      }
    }
    return { at: tsAt(range, start), baseline, peak, peakAt: tsAt(range, peakI) };
  }
  return null;
}

export function findOnsets(series: ServiceSeries[], range: TimeRange): Onset[] {
  const out: Onset[] = [];
  for (const s of series) {
    const lat = detect(s.latencyP95, range, (v, b) => v > Math.max(3 * b, b + 0.1), "max");
    if (lat) out.push({ service: s.service, signal: "latency_p95", ...lat });
    // A service that had no traffic, or no samples yet, when the window
    // opened has no measured error baseline. Errors are judged against zero
    // then: unlike latency, "no errors" is the normal state of any service.
    const err = detect(s.errorRatio, range, (v, b) => v > Math.max(3 * b, b + 0.02), "max", 0);
    if (err) out.push({ service: s.service, signal: "error_ratio", ...err });
    const drop = detect(s.rate, range, (v, b) => b > 0 && v < 0.6 * b, "min");
    if (drop) out.push({ service: s.service, signal: "rate_drop", ...drop });
  }
  return out.sort((a, b) => a.at - b.at || a.service.localeCompare(b.service));
}

export async function buildReplay(
  adapter: Adapter,
  range: TimeRange,
  focus?: string,
): Promise<ReplayBundle> {
  if (!adapter.capabilities.serviceGraph) {
    throw new Error(`Backend "${adapter.name}" has no service graph, so there is nothing to replay.`);
  }
  const [graph, alerts, changes] = await Promise.all([
    adapter.serviceGraph(range),
    adapter.capabilities.alerts ? adapter.alerts(range) : { data: [], queries: [] },
    adapter.capabilities.changes ? adapter.changes(range) : { data: [], queries: [] },
  ]);
  const known = new Set(graph.data.services.map((s) => s.id));
  return {
    version: 1,
    backend: adapter.name,
    capabilities: adapter.capabilities,
    range,
    services: graph.data.services,
    serviceSeries: graph.data.serviceSeries,
    edgeSeries: graph.data.edgeSeries,
    alerts: alerts.data,
    changes: changes.data,
    onsets: findOnsets(graph.data.serviceSeries, range),
    focus: focus && known.has(focus) ? focus : undefined,
    queries: [...graph.queries, ...alerts.queries, ...changes.queries],
  };
}

export function clock(ts: Ts): string {
  return new Date(ts * 1000).toISOString().slice(11, 19);
}

export function formatValue(signal: OnsetSignal, v: number): string {
  if (signal === "latency_p95") return v >= 1 ? `${v.toFixed(2)}s` : `${Math.round(v * 1000)}ms`;
  if (signal === "error_ratio") return `${(v * 100).toFixed(1)}%`;
  return `${v.toFixed(1)} req/s`;
}

const SIGNAL_LABEL: Record<OnsetSignal, string> = {
  latency_p95: "p95 latency rose",
  error_ratio: "error ratio rose",
  rate_drop: "request rate fell",
};

/** The short text the model reads; the full bundle goes to the view. */
export function summarize(b: ReplayBundle): string {
  const r = b.range;
  const lines: string[] = [
    `Replay of ${Math.round((r.end - r.start) / 60)} min, ${clock(r.start)} to ${clock(r.end)} UTC ` +
      `(${new Date(r.end * 1000).toISOString().slice(0, 10)}), backend "${b.backend}": ` +
      `${b.services.length} services, ${b.edgeSeries.length} edges, ${stepsIn(r)} frames at ${r.step}s.`,
  ];
  if (b.services.length === 0) {
    lines.push("The backend returned no service graph data for this range.");
    return lines.join("\n");
  }
  if (b.onsets.length === 0) {
    lines.push("No signal left its baseline in this window.");
  } else {
    lines.push("", "First departures from baseline, in time order:");
    b.onsets.forEach((o, i) => {
      lines.push(
        `${i + 1}. ${clock(o.at)} ${o.service}: ${SIGNAL_LABEL[o.signal]} from ` +
          `${formatValue(o.signal, o.baseline)} to ${formatValue(o.signal, o.peak)} (extreme at ${clock(o.peakAt)})`,
      );
    });
    lines.push(
      "Baseline is the median of the first fifth of the window. The order shows sequence, not proven cause.",
    );
  }
  if (b.capabilities.changes) {
    lines.push("", b.changes.length ? "Changes:" : "Changes: none recorded in this window.");
    for (const c of b.changes) {
      lines.push(`- ${clock(c.at)} ${c.kind}${c.service ? ` ${c.service}` : ""}: ${c.description}`);
    }
  } else {
    lines.push("", "Changes: this backend cannot report deploys.");
  }
  if (b.capabilities.alerts) {
    lines.push("", b.alerts.length ? "Alerts:" : "Alerts: none fired in this window.");
    for (const a of b.alerts) {
      const until = a.endsAt ? `until ${clock(a.endsAt)}` : "still firing at window end";
      lines.push(
        `- ${clock(a.startsAt)} ${a.name}${a.severity ? ` [${a.severity}]` : ""}` +
          `${a.service ? ` on ${a.service}` : ""}, ${until}`,
      );
    }
  }
  return lines.join("\n");
}
