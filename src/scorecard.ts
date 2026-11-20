import type { Adapter, Capabilities } from "./adapters/types.js";
import {
  stepsIn,
  tsAt,
  type ChangeEvent,
  type ResourceSeries,
  type Samples,
  type ServiceSeries,
  type SourceQuery,
  type TimeRange,
  type Ts,
} from "./model.js";
import { clock } from "./replay.js";

/**
 * The application scorecard: one fixed set of measures per application,
 * defined once here so they mean the same thing on every cloud and backend.
 */

/** Scorecards use fewer, wider frames than a replay. */
export const SCORECARD_MAX_FRAMES = 120;

export interface Slo {
  /** Target share of successful requests, e.g. 0.999. */
  availability: number;
  /** p95 latency objective in seconds. */
  latencyP95: number;
}

export const DEFAULT_SLO: Slo = { availability: 0.999, latencyP95: 0.5 };

export function sloFromEnv(env: NodeJS.ProcessEnv = process.env): Slo {
  const pct = Number(env.OBS_SLO_AVAILABILITY ?? "");
  const ms = Number(env.OBS_SLO_P95_MS ?? "");
  return {
    availability: pct > 0 && pct < 100 ? pct / 100 : DEFAULT_SLO.availability,
    latencyP95: ms > 0 ? ms / 1000 : DEFAULT_SLO.latencyP95,
  };
}

export type Severity = "crit" | "warn" | "info";
export type Status = "crit" | "warn" | "ok" | "nodata";

export interface Finding {
  severity: Severity;
  text: string;
}

/** How an application's signals moved across one deploy or rollback. */
export interface ChangeEffect {
  at: Ts;
  kind: ChangeEvent["kind"];
  description: string;
  p95Before: number | null;
  p95After: number | null;
  errBefore: number | null;
  errAfter: number | null;
  verdict: "regressed" | "improved" | "no clear change" | "not enough data";
}

export interface AppCard {
  id: string;
  cloud?: string;
  cluster?: string;
  kind?: string;
  status: Status;
  usage: {
    now: number | null;
    peak: number | null;
    mean: number | null;
    /** Requests served in the window. */
    total: number | null;
  };
  performance: {
    p95Now: number | null;
    p95Worst: number | null;
    /** Failed requests over all requests in the window. */
    errorRatio: number | null;
    /** errorRatio divided by the error budget; 1 means exactly on budget. */
    burnRate: number | null;
    /** Minutes of the window with p95 above the objective. */
    minutesOverLatency: number | null;
  };
  resources: null | {
    /** Mean CPU used as a share of CPU requested. */
    cpuOfRequest: number | null;
    cpuPeakOfRequest: number | null;
    throttledPeak: number | null;
    memNow: number | null;
    memPeakOfLimit: number | null;
    restarts: number;
    replicas: number | null;
  };
  changes: ChangeEffect[];
  findings: Finding[];
  calls: string[];
  calledBy: string[];
  series: {
    rate: Samples;
    latencyP95: Samples;
    errorRatio: Samples;
    cpuUsage?: Samples;
    cpuRequest?: Samples;
    memUsage?: Samples;
    memLimit?: Samples;
  };
}

export interface ScorecardBundle {
  version: 1;
  kind: "scorecards";
  backend: string;
  capabilities: Capabilities;
  range: TimeRange;
  slo: Slo;
  apps: AppCard[];
  focus?: string;
  queries: SourceQuery[];
}

// ---------- small numeric helpers ----------

const nums = (s: Samples) => s.filter((v): v is number => v !== null && v !== undefined);
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const max = (v: number[]) => (v.length ? Math.max(...v) : null);

function last(s: Samples): number | null {
  for (let i = s.length - 1; i >= 0; i--) {
    const v = s[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** Element-wise a/b, null where either side is missing or b is zero. */
function divide(a: Samples, b: Samples): Samples {
  return a.map((x, i) => {
    const y = b[i];
    return x === null || x === undefined || y === null || y === undefined || y === 0 ? null : x / y;
  });
}

/** Failed over total requests between two frame indexes, weighted by traffic. */
function weightedErrors(s: ServiceSeries, from: number, to: number): number | null {
  let total = 0;
  let failed = 0;
  for (let i = from; i < to; i++) {
    const r = s.rate[i];
    const e = s.errorRatio[i];
    if (r === null || r === undefined || e === null || e === undefined) continue;
    total += r;
    failed += r * e;
  }
  return total > 0 ? failed / total : null;
}

export const fmt = {
  latency: (v: number | null) =>
    v === null ? "no data" : v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`,
  ratio: (v: number | null) =>
    v === null ? "no data" : v > 0 && v < 0.0005 ? `${(v * 100).toFixed(3)}%` : `${(v * 100).toFixed(v < 0.1 ? 2 : 1)}%`,
  rate: (v: number | null) => (v === null ? "no data" : `${v.toFixed(1)} req/s`),
  percent: (v: number | null) => (v === null ? "no data" : `${Math.round(v * 100)}%`),
  times: (v: number) => (v >= 10 ? `${Math.round(v)}×` : `${v.toFixed(1)}×`),
};

// ---------- building a card ----------

/** A change needs this many samples on each side before it is judged. */
const MIN_SIDE = 4;

function changeEffects(
  s: ServiceSeries,
  changes: ChangeEvent[],
  range: TimeRange,
): ChangeEffect[] {
  const n = stepsIn(range);
  const frameOf = (ts: Ts) => Math.min(n, Math.max(0, Math.round((ts - range.start) / range.step)));
  const mine = changes.filter((c) => c.service === s.service).sort((a, b) => a.at - b.at);
  return mine.map((c, i) => {
    // Compare the stretch since the previous change with the stretch up to
    // the next one, so each change is judged on its own.
    const from = i === 0 ? 0 : frameOf(mine[i - 1]!.at);
    const at = frameOf(c.at);
    const to = i === mine.length - 1 ? n : frameOf(mine[i + 1]!.at);
    const p95Before = mean(nums(s.latencyP95.slice(from, at)));
    const p95After = mean(nums(s.latencyP95.slice(at, to)));
    const errBefore = weightedErrors(s, from, at);
    const errAfter = weightedErrors(s, at, to);
    let verdict: ChangeEffect["verdict"] = "no clear change";
    if (at - from < MIN_SIDE || to - at < MIN_SIDE || p95Before === null || p95After === null) {
      verdict = "not enough data";
    } else {
      const slower = p95After > Math.max(2 * p95Before, p95Before + 0.1);
      const faster = p95Before > Math.max(2 * p95After, p95After + 0.1);
      const eb = errBefore ?? 0;
      const ea = errAfter ?? 0;
      const moreErrors = ea > Math.max(3 * eb, eb + 0.02);
      const fewerErrors = eb > Math.max(3 * ea, ea + 0.02);
      if (slower || moreErrors) verdict = "regressed";
      else if (faster || fewerErrors) verdict = "improved";
    }
    return {
      at: c.at,
      kind: c.kind,
      description: c.description,
      p95Before,
      p95After,
      errBefore,
      errAfter,
      verdict,
    };
  });
}

function buildCard(
  s: ServiceSeries,
  res: ResourceSeries | undefined,
  changes: ChangeEvent[],
  range: TimeRange,
  slo: Slo,
): Omit<AppCard, "id" | "cloud" | "cluster" | "kind" | "calls" | "calledBy"> {
  const minutes = Math.round((range.end - range.start) / 60);
  const rates = nums(s.rate);
  const findings: Finding[] = [];

  const errorRatio = weightedErrors(s, 0, s.rate.length);
  const budget = 1 - slo.availability;
  const burnRate = errorRatio === null ? null : errorRatio / budget;
  const over = s.latencyP95.filter((v) => v !== null && v !== undefined && v > slo.latencyP95).length;
  const minutesOverLatency = nums(s.latencyP95).length ? (over * range.step) / 60 : null;

  if (burnRate !== null && burnRate >= 1) {
    findings.push({
      severity: burnRate >= 14.4 ? "crit" : "warn",
      text:
        `${fmt.ratio(errorRatio)} of requests failed over the last ${minutes} min, ` +
        `${fmt.times(burnRate)} the ${fmt.ratio(budget)} error budget.`,
    });
  }
  if (minutesOverLatency !== null && minutesOverLatency >= 1) {
    findings.push({
      severity: minutesOverLatency >= minutes / 10 ? "warn" : "info",
      text:
        `p95 latency was above the ${fmt.latency(slo.latencyP95)} objective for ` +
        `${Math.round(minutesOverLatency)} of ${minutes} min (worst ${fmt.latency(max(nums(s.latencyP95)))}).`,
    });
  }

  const effects = changeEffects(s, changes, range);
  effects.forEach((e, i) => {
    if (e.verdict !== "regressed") return;
    const later = effects[i + 1];
    const slower =
      e.p95Before !== null && e.p95After !== null && e.p95After > Math.max(2 * e.p95Before, e.p95Before + 0.1);
    const what = slower
      ? `p95 latency went from ${fmt.latency(e.p95Before)} to ${fmt.latency(e.p95After)}`
      : `errors went from ${fmt.ratio(e.errBefore)} to ${fmt.ratio(e.errAfter)}`;
    findings.push({
      // Still live if nothing has been rolled out since.
      severity: later ? "warn" : "crit",
      text:
        `After the ${e.kind} at ${clock(e.at)} UTC (${e.description}), ${what}` +
        (later ? `; a ${later.kind} followed at ${clock(later.at)}.` : "; nothing has been rolled out since."),
    });
  });

  let resources: AppCard["resources"] = null;
  if (res) {
    const cpuShare = nums(divide(res.cpuUsage, res.cpuRequest));
    const memShare = nums(divide(res.memUsage, res.memLimit));
    const restarts = nums(res.restarts).reduce((a, b) => a + b, 0);
    resources = {
      cpuOfRequest: mean(cpuShare),
      cpuPeakOfRequest: max(cpuShare),
      throttledPeak: max(nums(res.cpuThrottled)),
      memNow: last(res.memUsage),
      memPeakOfLimit: max(memShare),
      restarts: Math.round(restarts),
      replicas: last(res.replicas),
    };
    const r = resources;
    if (r.restarts > 0) {
      const nearLimit = r.memPeakOfLimit !== null && r.memPeakOfLimit >= 0.9;
      findings.push({
        severity: r.restarts >= 3 ? "crit" : "warn",
        text:
          `${r.restarts} container restart${r.restarts === 1 ? "" : "s"} in the last ${minutes} min` +
          (nearLimit
            ? `, with memory peaking at ${fmt.percent(r.memPeakOfLimit)} of its limit: check for a memory leak.`
            : "."),
      });
    } else if (r.memPeakOfLimit !== null && r.memPeakOfLimit >= 0.9) {
      findings.push({
        severity: "warn",
        text: `Memory peaked at ${fmt.percent(r.memPeakOfLimit)} of its limit; it will be killed if it reaches 100%.`,
      });
    }
    if (r.throttledPeak !== null && r.throttledPeak >= 0.25) {
      findings.push({
        severity: "warn",
        text: `CPU was throttled in up to ${fmt.percent(r.throttledPeak)} of periods, which adds latency: it is hitting its CPU limit.`,
      });
    }
    if (r.cpuOfRequest !== null && r.cpuPeakOfRequest !== null && r.cpuPeakOfRequest < 0.25) {
      findings.push({
        severity: "info",
        text: `Uses ${fmt.percent(r.cpuOfRequest)} of the CPU it requests (peak ${fmt.percent(r.cpuPeakOfRequest)}): the request could be lowered.`,
      });
    }
  }

  const order: Record<Severity, number> = { crit: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const hasSignals = rates.length > 0 || nums(s.latencyP95).length > 0;
  const status: Status = findings.some((f) => f.severity === "crit")
    ? "crit"
    : findings.some((f) => f.severity === "warn")
      ? "warn"
      : hasSignals || resources
        ? "ok"
        : "nodata";

  return {
    status,
    usage: {
      now: last(s.rate),
      peak: max(rates),
      mean: mean(rates),
      total: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) * range.step) : null,
    },
    performance: {
      p95Now: last(s.latencyP95),
      p95Worst: max(nums(s.latencyP95)),
      errorRatio,
      burnRate,
      minutesOverLatency,
    },
    resources,
    changes: effects,
    findings,
    series: {
      rate: s.rate,
      latencyP95: s.latencyP95,
      errorRatio: s.errorRatio,
      ...(res
        ? { cpuUsage: res.cpuUsage, cpuRequest: res.cpuRequest, memUsage: res.memUsage, memLimit: res.memLimit }
        : {}),
    },
  };
}

export async function buildScorecards(
  adapter: Adapter,
  range: TimeRange,
  slo: Slo = DEFAULT_SLO,
  focus?: string,
): Promise<ScorecardBundle> {
  if (!adapter.capabilities.serviceGraph) {
    throw new Error(`Backend "${adapter.name}" has no request data to score applications on.`);
  }
  const none = { data: [], queries: [] };
  const [graph, changes, resources] = await Promise.all([
    adapter.serviceGraph(range),
    adapter.capabilities.changes ? adapter.changes(range) : none,
    adapter.capabilities.resources ? adapter.resources(range) : none,
  ]);
  const resBy = new Map((resources.data as ResourceSeries[]).map((r) => [r.service, r]));
  const rank: Record<Status, number> = { crit: 0, warn: 1, ok: 2, nodata: 3 };

  const apps: AppCard[] = graph.data.serviceSeries.map((s) => {
    const ref = graph.data.services.find((x) => x.id === s.service);
    return {
      id: s.service,
      cloud: ref?.cloud,
      cluster: ref?.cluster,
      kind: ref?.kind,
      calls: graph.data.edgeSeries.filter((e) => e.from === s.service).map((e) => e.to),
      calledBy: graph.data.edgeSeries.filter((e) => e.to === s.service).map((e) => e.from),
      ...buildCard(s, resBy.get(s.service), changes.data as ChangeEvent[], range, slo),
    };
  });
  // A workload that runs but appears in no trace (nothing instrumented, or it
  // serves no requests) still has a card, scored on its resources alone.
  const seen = new Set(apps.map((a) => a.id));
  const blank = (): Samples => new Array(stepsIn(range)).fill(null);
  for (const r of resources.data as ResourceSeries[]) {
    if (seen.has(r.service)) continue;
    const s: ServiceSeries = { service: r.service, rate: blank(), errorRatio: blank(), latencyP95: blank() };
    apps.push({
      id: r.service,
      calls: [],
      calledBy: [],
      ...buildCard(s, r, changes.data as ChangeEvent[], range, slo),
    });
  }
  // A node that only makes calls and has no data of its own (the "user" a
  // tracing backend puts in front of the entry point) is not an application.
  for (let i = apps.length - 1; i >= 0; i--) {
    const a = apps[i]!;
    if (a.status === "nodata" && a.calledBy.length === 0) apps.splice(i, 1);
  }
  // Worst first, then by how fast the error budget is burning.
  apps.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (b.performance.burnRate ?? 0) - (a.performance.burnRate ?? 0) ||
      a.id.localeCompare(b.id),
  );

  return {
    version: 1,
    kind: "scorecards",
    backend: adapter.name,
    capabilities: adapter.capabilities,
    range,
    slo,
    apps,
    focus: focus && apps.some((a) => a.id === focus) ? focus : undefined,
    queries: [...graph.queries, ...resources.queries, ...changes.queries],
  };
}

const STATUS_WORD: Record<Status, string> = {
  crit: "NEEDS ATTENTION",
  warn: "WATCH",
  ok: "healthy",
  nodata: "no data",
};

/** The text the model reads. */
export function summarizeScorecards(b: ScorecardBundle, only?: string): string {
  const r = b.range;
  const minutes = Math.round((r.end - r.start) / 60);
  const lines = [
    `Application scorecards for the last ${minutes} min (to ${clock(r.end)} UTC), backend "${b.backend}". ` +
      `Objectives: ${fmt.ratio(b.slo.availability)} of requests succeed, p95 under ${fmt.latency(b.slo.latencyP95)}.`,
  ];
  if (!b.capabilities.resources) lines.push("This backend has no CPU or memory data.");
  if (b.apps.length > 0 && b.apps.every((a) => a.usage.total === null)) {
    lines.push(
      "The backend returned no request data (no service graph from traces), so applications are scored on resources only.",
    );
  }
  const apps = only ? b.apps.filter((a) => a.id === only) : b.apps;
  if (apps.length === 0) lines.push(only ? `No application named "${only}".` : "No applications found.");
  for (const a of apps) {
    const where = a.cloud ? ` [${a.cloud}]` : "";
    const res = a.resources
      ? `, CPU ${fmt.percent(a.resources.cpuOfRequest)} of request, memory peak ${fmt.percent(a.resources.memPeakOfLimit)} of limit`
      : "";
    lines.push(
      "",
      `${a.id}${where}: ${STATUS_WORD[a.status]}`,
      `  now ${fmt.rate(a.usage.now)}, p95 ${fmt.latency(a.performance.p95Now)}, ` +
        `errors over window ${fmt.ratio(a.performance.errorRatio)}${res}`,
      ...a.findings.map((f) => `  - [${f.severity}] ${f.text}`),
    );
  }
  return lines.join("\n");
}
