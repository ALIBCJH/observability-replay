import type { Adapter, Capabilities, Sourced } from "./adapters/types.js";
import {
  stepsIn,
  type EndpointSeries,
  type LatencySeries,
  type ResourceSeries,
  type Samples,
  type ServiceGraphSeries,
  type SourceQuery,
  type TimeRange,
  type Ts,
} from "./model.js";

/**
 * Performance analytics: traffic, latency, errors and resource use per
 * service and per route over a chosen period, each set beside the period
 * just before it. Like the other views it only reads, and every figure is
 * computed from samples the backend returned; a figure with no samples
 * behind it is null, never a guess.
 */

export const PERFORMANCE_RANGES = ["15m", "1h", "6h", "24h", "7d", "30d"] as const;
export type RangeKey = (typeof PERFORMANCE_RANGES)[number];

const RANGE_MINUTES: Record<RangeKey, number> = {
  "15m": 15,
  "1h": 60,
  "6h": 360,
  "24h": 1440,
  "7d": 10080,
  "30d": 43200,
};

export const RANGE_WORDS: Record<RangeKey, string> = {
  "15m": "15 minutes",
  "1h": "hour",
  "6h": "6 hours",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

/**
 * However long the period, a read returns at most this many samples per
 * series: a longer period gets wider steps, not more of them.
 */
export const PERFORMANCE_MAX_FRAMES = 96;
const MIN_STEP = 15;

export function isRangeKey(v: unknown): v is RangeKey {
  return typeof v === "string" && (PERFORMANCE_RANGES as readonly string[]).includes(v);
}

export function performanceRange(key: RangeKey, now: Ts = Date.now() / 1000): TimeRange {
  const window = RANGE_MINUTES[key] * 60;
  const step = Math.max(MIN_STEP, Math.ceil(window / PERFORMANCE_MAX_FRAMES / MIN_STEP) * MIN_STEP);
  const end = Math.floor(now / step) * step;
  return { start: end - window, end, step };
}

/** The period of the same length that ends where `range` starts. */
export function previousRange(range: TimeRange): TimeRange {
  const window = range.end - range.start;
  return { start: range.start - window, end: range.start, step: range.step };
}

/** A figure for the chosen period and the same figure for the one before it. */
export interface Compared {
  now: number | null;
  before: number | null;
}

export interface ServicePerformance {
  id: string;
  cloud?: string;
  cluster?: string;
  kind?: string;
  /** Requests served in the period. */
  requests: Compared;
  ratePeak: number | null;
  /** Failed requests over all requests. */
  errorRatio: Compared;
  /** Total time over total requests; null without latency detail. */
  latencyMean: Compared;
  /** The median of the period's samples of each percentile. */
  p50: Compared;
  p90: Compared;
  p95: Compared;
  p99: Compared;
  p95Worst: number | null;
  /** Mean CPU in cores and mean memory in bytes; null without resources. */
  cpu: Compared | null;
  memory: Compared | null;
  series: {
    rate: Samples;
    rateBefore: Samples;
    errorRatio: Samples;
    errorRatioBefore: Samples;
    latencyP95: Samples;
    latencyP95Before: Samples;
    latencyMean?: Samples;
    p50?: Samples;
    p90?: Samples;
    p99?: Samples;
    cpuUsage?: Samples;
    cpuRequest?: Samples;
    memUsage?: Samples;
    memLimit?: Samples;
  };
}

export interface EndpointPerformance {
  service: string;
  endpoint: string;
  requests: number | null;
  /** This route's part of the requests to all of its service's routes. */
  share: number | null;
  /** Median and worst of the period's p95 samples. */
  p95: number | null;
  p95Worst: number | null;
  /** 4xx and 5xx responses over all responses. */
  ratio4xx: number | null;
  ratio5xx: number | null;
  series: { rate: Samples; rate4xx: Samples; rate5xx: Samples; latencyP95: Samples };
}

export interface PerformanceBundle {
  version: 1;
  kind: "performance";
  backend: string;
  /** True when the figures are scripted demo data and not telemetry. */
  simulated: boolean;
  capabilities: Capabilities;
  rangeKey: RangeKey;
  range: TimeRange;
  before: TimeRange;
  /** Every service together. A request that crosses three services counts three times. */
  totals: {
    requests: Compared;
    errorRatio: Compared;
    series: { rate: Samples; rateBefore: Samples; errorRatio: Samples; errorRatioBefore: Samples };
  };
  services: ServicePerformance[];
  endpoints: EndpointPerformance[];
  /** What could not be read, in words; the page shows these as they are. */
  gaps: string[];
  focus?: string;
  queries: SourceQuery[];
}

// ---------- arithmetic over samples ----------

const present = (s: Samples | undefined): number[] => (s ?? []).filter((v): v is number => v !== null && v !== undefined);

function median(s: Samples | undefined): number | null {
  const v = present(s).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

function mean(s: Samples | undefined): number | null {
  const v = present(s);
  return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
}

function peak(s: Samples | undefined): number | null {
  const v = present(s);
  return v.length ? Math.max(...v) : null;
}

/** Requests in the period: each rate sample stands for one step. */
function count(rate: Samples | undefined, step: number): number | null {
  const v = present(rate);
  return v.length ? Math.round(v.reduce((a, x) => a + x, 0) * step) : null;
}

/** The mean of `values` with each sample weighted by the traffic at that step. */
function weighted(values: Samples | undefined, rate: Samples | undefined): number | null {
  let top = 0;
  let bottom = 0;
  (values ?? []).forEach((v, i) => {
    const r = rate?.[i];
    if (v === null || v === undefined || r === null || r === undefined) return;
    top += v * r;
    bottom += r;
  });
  return bottom > 0 ? top / bottom : null;
}

/** Add series step by step; a step is null only where every series is. */
function addUp(all: Samples[], n: number): Samples {
  const out: Samples = new Array(n).fill(null);
  for (const s of all) {
    for (let i = 0; i < n; i++) {
      const v = s[i];
      if (v !== null && v !== undefined) out[i] = (out[i] ?? 0) + v;
    }
  }
  return out;
}

const divide = (part: Samples, whole: Samples): Samples =>
  whole.map((w, i) => {
    const p = part[i];
    if (w === null || w === undefined || p === null || p === undefined) return null;
    return w === 0 ? 0 : Math.min(1, p / w);
  });

const times = (a: Samples, b: Samples): Samples =>
  a.map((v, i) => {
    const w = b[i];
    return v === null || v === undefined || w === null || w === undefined ? null : v * w;
  });

// ---------- the bundle ----------

type Settled<T> = { ok: true; value: Sourced<T> } | { ok: false; why: string };

async function attempt<T>(wanted: boolean, read: () => Promise<Sourced<T>>): Promise<Settled<T> | null> {
  if (!wanted) return null;
  try {
    return { ok: true, value: await read() };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}

export async function buildPerformance(
  adapter: Adapter,
  rangeKey: RangeKey,
  focus?: string,
  now?: Ts,
): Promise<PerformanceBundle> {
  if (!adapter.capabilities.serviceGraph) {
    throw new Error(`Backend "${adapter.name}" has no request metrics, so there is nothing to analyse.`);
  }
  const range = performanceRange(rangeKey, now);
  const before = previousRange(range);
  const caps = adapter.capabilities;
  // The chosen period's request metrics are the page; without them it fails.
  // Everything else is optional, and a failure there becomes a stated gap.
  const [graph, graphBefore, latency, endpoints, resources, resourcesBefore] = await Promise.all([
    adapter.serviceGraph(range),
    attempt<ServiceGraphSeries>(true, () => adapter.serviceGraph(before)),
    attempt<LatencySeries[]>(caps.latencyDetail, () => adapter.latency(range)),
    attempt<EndpointSeries[]>(caps.endpoints, () => adapter.endpoints(range)),
    attempt<ResourceSeries[]>(caps.resources, () => adapter.resources(range)),
    attempt<ResourceSeries[]>(caps.resources, () => adapter.resources(before)),
  ]);

  const gaps: string[] = [];
  const queries: SourceQuery[] = [...graph.queries];
  function take<T>(r: Settled<T> | null, what: string, listQueries = true): T | null {
    if (!r) return null;
    if (!r.ok) {
      gaps.push(`${what} could not be read: ${r.why}`);
      return null;
    }
    if (listQueries) queries.push(...r.value.queries);
    return r.value.data;
  }
  // The previous period runs the same queries over other times; listing them twice says nothing new.
  const gBefore = take(graphBefore, "The previous period", false);
  const lat = take(latency, "Latency percentiles");
  const eps = take(endpoints, "Per-route metrics");
  const res = take(resources, "CPU and memory");
  const resBefore = take(resourcesBefore, "CPU and memory for the previous period", false);
  if (!caps.endpoints) gaps.push("Per-route metrics are switched off for this backend.");
  else if (eps && eps.length === 0) gaps.push("The backend returned no per-route metrics for this period.");
  if (!caps.resources) gaps.push("CPU and memory are switched off for this backend.");

  const n = stepsIn(range);
  const blank = (): Samples => new Array(n).fill(null);
  const step = range.step;
  const beforeBy = new Map((gBefore?.serviceSeries ?? []).map((s) => [s.service, s]));
  const latBy = new Map((lat ?? []).map((s) => [s.service, s]));
  const resBy = new Map((res ?? []).map((s) => [s.service, s]));
  const resBeforeBy = new Map((resBefore ?? []).map((s) => [s.service, s]));
  const refs = new Map(graph.data.services.map((s) => [s.id, s]));

  const services: ServicePerformance[] = graph.data.serviceSeries.map((s) => {
    const ref = refs.get(s.service);
    const b = beforeBy.get(s.service);
    const l = latBy.get(s.service);
    const r = resBy.get(s.service);
    const rb = resBeforeBy.get(s.service);
    const failed = (rate: Samples, ratio: Samples) => weighted(ratio, rate);
    return {
      id: s.service,
      cloud: ref?.cloud,
      cluster: ref?.cluster,
      kind: ref?.kind,
      requests: { now: count(s.rate, step), before: count(b?.rate, step) },
      ratePeak: peak(s.rate),
      errorRatio: { now: failed(s.rate, s.errorRatio), before: b ? failed(b.rate, b.errorRatio) : null },
      // The previous period's distribution is not read, so only p95 has a "before".
      latencyMean: { now: weighted(l?.mean, s.rate), before: null },
      p50: { now: median(l?.p50), before: null },
      p90: { now: median(l?.p90), before: null },
      p95: { now: median(s.latencyP95), before: median(b?.latencyP95) },
      p99: { now: median(l?.p99), before: null },
      p95Worst: peak(s.latencyP95),
      cpu: r ? { now: mean(r.cpuUsage), before: mean(rb?.cpuUsage) } : null,
      memory: r ? { now: mean(r.memUsage), before: mean(rb?.memUsage) } : null,
      series: {
        rate: s.rate,
        rateBefore: b?.rate ?? blank(),
        errorRatio: s.errorRatio,
        errorRatioBefore: b?.errorRatio ?? blank(),
        latencyP95: s.latencyP95,
        latencyP95Before: b?.latencyP95 ?? blank(),
        ...(l ? { latencyMean: l.mean, p50: l.p50, p90: l.p90, p99: l.p99 } : {}),
        ...(r ? { cpuUsage: r.cpuUsage, cpuRequest: r.cpuRequest, memUsage: r.memUsage, memLimit: r.memLimit } : {}),
      },
    };
  });
  // Busiest first; a service with no requests at all goes last.
  services.sort((a, b) => (b.requests.now ?? -1) - (a.requests.now ?? -1) || a.id.localeCompare(b.id));

  const perService = new Map<string, number>();
  for (const e of eps ?? []) perService.set(e.service, (perService.get(e.service) ?? 0) + (count(e.rate, step) ?? 0));
  const endpointRows: EndpointPerformance[] = (eps ?? []).map((e) => {
    const requests = count(e.rate, step);
    const all = perService.get(e.service) ?? 0;
    const part = (s: Samples) => {
      const c = present(s).reduce((a, x) => a + x, 0);
      const whole = present(e.rate).reduce((a, x) => a + x, 0);
      return present(e.rate).length === 0 ? null : whole === 0 ? 0 : Math.min(1, c / whole);
    };
    return {
      service: e.service,
      endpoint: e.endpoint,
      requests,
      share: requests === null || all === 0 ? null : requests / all,
      p95: median(e.latencyP95),
      p95Worst: peak(e.latencyP95),
      ratio4xx: part(e.rate4xx),
      ratio5xx: part(e.rate5xx),
      series: { rate: e.rate, rate4xx: e.rate4xx, rate5xx: e.rate5xx, latencyP95: e.latencyP95 },
    };
  });
  endpointRows.sort((a, b) => (b.requests ?? -1) - (a.requests ?? -1) || a.endpoint.localeCompare(b.endpoint));

  const fleet = (series: { rate: Samples; errorRatio: Samples }[]) => {
    const rate = addUp(series.map((s) => s.rate), n);
    const failedRate = addUp(series.map((s) => times(s.rate, s.errorRatio)), n);
    const ratio = divide(failedRate, rate);
    return { rate, ratio, requests: count(rate, step), errorRatio: weighted(ratio, rate) };
  };
  const nowAll = fleet(graph.data.serviceSeries);
  const beforeAll = gBefore ? fleet(gBefore.serviceSeries) : null;

  return {
    version: 1,
    kind: "performance",
    backend: adapter.name,
    simulated: adapter.name === "demo",
    capabilities: caps,
    rangeKey,
    range,
    before,
    totals: {
      requests: { now: nowAll.requests, before: beforeAll?.requests ?? null },
      errorRatio: { now: nowAll.errorRatio, before: beforeAll?.errorRatio ?? null },
      series: {
        rate: nowAll.rate,
        rateBefore: beforeAll?.rate ?? blank(),
        errorRatio: nowAll.ratio,
        errorRatioBefore: beforeAll?.ratio ?? blank(),
      },
    },
    services,
    endpoints: endpointRows,
    gaps,
    focus: focus && refs.has(focus) ? focus : undefined,
    queries,
  };
}

// ---------- the text the model reads ----------

const NONE = "no data";
const latencyText = (v: number | null) => (v === null ? NONE : v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`);
const ratioText = (v: number | null) => (v === null ? NONE : `${(v * 100).toFixed(v < 0.1 ? 2 : 1)}%`);
const countText = (v: number | null) => (v === null ? NONE : v.toLocaleString("en-US"));

/**
 * How a figure moved against the previous period, as a signed percentage.
 * Null when either side is missing or the earlier figure is zero.
 */
export function change(c: Compared): number | null {
  if (c.now === null || c.before === null || c.before === 0) return null;
  return (c.now - c.before) / c.before;
}

function changeText(c: Compared): string {
  const d = change(c);
  if (d === null) return c.before === null ? "no earlier figure" : `was ${c.before === 0 ? "0" : "unknown"}`;
  if (Math.abs(d) < 0.005) return "unchanged";
  return `${d > 0 ? "+" : ""}${(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%`;
}

export function summarizePerformance(b: PerformanceBundle, service?: string): string {
  const day = (ts: Ts) => new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
  const lines = [
    `Performance over the last ${RANGE_WORDS[b.rangeKey]}, ${day(b.range.start)} to ${day(b.range.end)} UTC, ` +
      `backend "${b.backend}"${b.simulated ? " (SIMULATED demo data, not telemetry)" : ""}. ` +
      `Changes are against the ${RANGE_WORDS[b.rangeKey]} before.`,
  ];
  const picked = service ? b.services.filter((s) => s.id === service) : b.services;
  if (service && picked.length === 0) lines.push(`No service called "${service}" in this period.`);
  if (!service) {
    lines.push(
      "",
      `All services: ${countText(b.totals.requests.now)} requests (${changeText(b.totals.requests)}), ` +
        `${ratioText(b.totals.errorRatio.now)} failed (earlier ${ratioText(b.totals.errorRatio.before)}).`,
    );
  }
  if (picked.length) lines.push("", "Per service:");
  for (const s of picked) {
    const where = s.cloud ? ` [${s.cloud}]` : "";
    const parts = [
      `${countText(s.requests.now)} requests (${changeText(s.requests)})`,
      `p95 ${latencyText(s.p95.now)} (earlier ${latencyText(s.p95.before)}, worst ${latencyText(s.p95Worst)})`,
      `failed ${ratioText(s.errorRatio.now)} (earlier ${ratioText(s.errorRatio.before)})`,
    ];
    if (s.p99.now !== null) parts.push(`mean ${latencyText(s.latencyMean.now)}, p50 ${latencyText(s.p50.now)}, p99 ${latencyText(s.p99.now)}`);
    if (s.cpu) parts.push(`CPU ${s.cpu.now === null ? NONE : `${s.cpu.now.toFixed(2)} cores`} (${changeText(s.cpu)})`);
    if (s.memory) parts.push(`memory ${s.memory.now === null ? NONE : `${Math.round(s.memory.now / 1048576)} MiB`} (${changeText(s.memory)})`);
    lines.push(`- ${s.id}${where}: ${parts.join("; ")}`);
  }
  const eps = service ? b.endpoints.filter((e) => e.service === service) : b.endpoints;
  if (eps.length) {
    const row = (e: EndpointPerformance) =>
      `- ${e.service} ${e.endpoint}: ${countText(e.requests)} requests, p95 ${latencyText(e.p95)}, ` +
      `4xx ${ratioText(e.ratio4xx)}, 5xx ${ratioText(e.ratio5xx)}`;
    const slow = [...eps].filter((e) => e.p95 !== null).sort((a, c) => c.p95! - a.p95!).slice(0, 5);
    const failing = [...eps].filter((e) => (e.ratio5xx ?? 0) > 0).sort((a, c) => c.ratio5xx! - a.ratio5xx!).slice(0, 5);
    lines.push("", "Slowest routes:", ...slow.map(row));
    lines.push("", failing.length ? "Routes with the most 5xx responses:" : "No route answered with a 5xx in this period.", ...failing.map(row));
  }
  if (b.gaps.length) lines.push("", "Not available:", ...b.gaps.map((g) => `- ${g}`));
  lines.push(
    "",
    "Percentiles are the median of the period's samples; a comparison shows that a figure moved, not why.",
  );
  return lines.join("\n");
}
