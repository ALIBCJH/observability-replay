import type { Adapter } from "./adapters/types.js";
import type { Samples, TimeRange, Ts } from "./model.js";
import { clock } from "./replay.js";
import { buildScorecards, fmt, type AppCard, type ScorecardBundle } from "./scorecard.js";

/**
 * The benchmark: one fixed standard for a healthy system, the same on every
 * cloud and backend. What is measured, the bars, and how the grade is worked
 * out are all defined here and cannot be configured, so that two results are
 * always comparable. A change to any of them is a new version.
 */
export const STANDARD = { id: "observability-benchmark", version: "1.0" } as const;

/** The objectives the benchmark scores against. Fixed, unlike OBS_SLO_*. */
export const BENCHMARK_SLO = { availability: 0.999, latencyP95: 0.5 };

export type Area = "availability" | "latency" | "resources" | "stability" | "changes" | "resilience";
export type Outcome = "pass" | "warn" | "fail" | "not measured";

export interface CheckDef {
  id: string;
  area: Area;
  title: string;
  /** A two-word column heading for tables. */
  short: string;
  /** The bar, in words, exactly as it is applied. */
  bar: string;
  /** "app" checks run once per application; "system" checks once per test run. */
  scope: "app" | "system";
}

export const CHECKS: CheckDef[] = [
  { id: "availability.success", short: "Success", area: "availability", scope: "app", title: "Requests succeed", bar: "pass at 99.9% or more, warn at 99% or more" },
  { id: "latency.p95", short: "p95 latency", area: "latency", scope: "app", title: "p95 latency stays under 500 ms", bar: "pass if over 500 ms for at most 1% of the window, warn at most 10%" },
  { id: "resources.memory_limit_set", short: "Memory limit", area: "resources", scope: "app", title: "A memory limit is set", bar: "pass if set" },
  { id: "resources.cpu_request_set", short: "CPU request", area: "resources", scope: "app", title: "A CPU request is set", bar: "pass if set" },
  { id: "resources.memory_headroom", short: "Memory room", area: "resources", scope: "app", title: "Memory stays clear of its limit", bar: "pass at a peak of 80% or less, warn at 90% or less" },
  { id: "resources.cpu_throttling", short: "Throttling", area: "resources", scope: "app", title: "CPU is not throttled", bar: "pass at 5% of periods or less, warn at 25% or less" },
  { id: "stability.restarts", short: "Restarts", area: "stability", scope: "app", title: "Containers do not restart", bar: "pass at 0, warn at 1 or 2" },
  { id: "changes.safe", short: "Deploys", area: "changes", scope: "app", title: "Deploys do not make things worse", bar: "pass if no deploy regressed, warn if one did and was followed by another, fail if it is still live" },
  { id: "resilience.steady_success", short: "Steady success", area: "resilience", scope: "system", title: "Requests succeed under steady load", bar: "pass at 99.9% or more, warn at 99% or more" },
  { id: "resilience.steady_latency", short: "Steady p95", area: "resilience", scope: "system", title: "p95 latency under steady load", bar: "pass at 500 ms or less, warn at 1 s or less" },
  { id: "resilience.recovery", short: "Recovery", area: "resilience", scope: "system", title: "Recovers after a failure", bar: "pass within 60 s of the fault being removed, warn within 300 s" },
  { id: "resilience.detected", short: "Detected", area: "resilience", scope: "system", title: "The failure is visible in monitoring", bar: "pass if the backend shows errors while the fault is in place" },
];

/** The fixed shape of an active test. Only the target and the fault differ. */
export const TEST_PHASES = { steadySeconds: 60, faultSeconds: 30, recoveryLimitSeconds: 300, recoveredAfter: 10 };

export interface CheckResult {
  id: string;
  outcome: Outcome;
  /** What was measured, in words. */
  detail: string;
}

export interface AppResult {
  id: string;
  checks: CheckResult[];
}

/** What the load generator saw during an active test. */
export interface TestObservation {
  plan: string;
  target: string;
  ratePerSecond: number;
  fault: string;
  startedAt: Ts;
  faultAt: Ts;
  restoredAt: Ts;
  endedAt: Ts;
  /** `failures` counts failed requests by HTTP status or kind of error. */
  steady: { sent: number; ok: number; p95: number | null; failures?: Record<string, number> };
  duringFault: { sent: number; ok: number; failures?: Record<string, number> };
  /** Seconds from the fault being removed to requests succeeding again; null if they never did. */
  recoverySeconds: number | null;
}

export interface BenchmarkResult {
  standard: typeof STANDARD;
  mode: "observe" | "test";
  backend: string;
  range: TimeRange;
  apps: AppResult[];
  system: CheckResult[];
  areas: { area: Area; score: number | null; pass: number; warn: number; fail: number; notMeasured: number }[];
  /** 0 to 100 over the checks that could be measured; null if too few were. */
  score: number | null;
  grade: "A" | "B" | "C" | "D" | "F" | "insufficient data";
  /** Share of checks that could be measured. */
  coverage: number;
  /** Set when a failed check held the grade down; says which. */
  cappedBy?: string;
  test?: TestObservation;
}

/**
 * Failing one of these holds the grade at C or below, however good the rest
 * is: a system that drops requests, or does not come back after a failure,
 * is not a B.
 */
export const CAPPING_CHECKS = ["availability.success", "resilience.recovery"];

/** A grade needs at least this share of the checks to have been measured. */
export const MIN_COVERAGE = 0.5;

const has = (s: Samples | undefined) => !!s && s.some((v) => v !== null && v !== undefined);

function bar(value: number, pass: number, warn: number): Outcome {
  return value <= pass ? "pass" : value <= warn ? "warn" : "fail";
}

/** Score one application against every per-application check. */
export function checkApp(a: AppCard, range: TimeRange, mode: "observe" | "test"): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (id: string, outcome: Outcome, detail: string) => out.push({ id, outcome, detail });
  const minutes = (range.end - range.start) / 60;
  const p = a.performance;

  if (mode === "test") {
    // The test breaks the system on purpose, so the window's request figures
    // say nothing about its normal health. Resilience checks cover them.
    add("availability.success", "not measured", "a fault was injected in this window");
    add("latency.p95", "not measured", "a fault was injected in this window");
  } else {
    if (p.errorRatio === null) add("availability.success", "not measured", "no request data");
    else add("availability.success", bar(p.errorRatio, 0.001, 0.01), `${fmt.ratio(1 - p.errorRatio)} of requests succeeded`);
    if (p.minutesOverLatency === null) add("latency.p95", "not measured", "no latency data");
    else {
      const share = p.minutesOverLatency / minutes;
      add("latency.p95", bar(share, 0.01, 0.1), `over 500 ms for ${fmt.percent(share)} of the window (worst ${fmt.latency(p.p95Worst)})`);
    }
  }

  const r = a.resources;
  const none = "no container metrics";
  if (!r) {
    for (const id of ["resources.memory_limit_set", "resources.cpu_request_set", "resources.memory_headroom", "resources.cpu_throttling", "stability.restarts"]) {
      add(id, "not measured", none);
    }
  } else {
    if (!has(a.series.memUsage)) add("resources.memory_limit_set", "not measured", "no memory data");
    else add("resources.memory_limit_set", has(a.series.memLimit) ? "pass" : "fail", has(a.series.memLimit) ? "set" : "no memory limit is set");
    if (!has(a.series.cpuUsage)) add("resources.cpu_request_set", "not measured", "no CPU data");
    else add("resources.cpu_request_set", has(a.series.cpuRequest) ? "pass" : "fail", has(a.series.cpuRequest) ? "set" : "no CPU request is set");
    if (r.memPeakOfLimit === null) add("resources.memory_headroom", "not measured", "no memory limit to compare with");
    else add("resources.memory_headroom", bar(r.memPeakOfLimit, 0.8, 0.9), `peaked at ${fmt.percent(r.memPeakOfLimit)} of its limit`);
    if (r.throttledPeak === null) add("resources.cpu_throttling", "not measured", "no throttling data (no CPU limit, or not reported)");
    else add("resources.cpu_throttling", bar(r.throttledPeak, 0.05, 0.25), `throttled in up to ${fmt.percent(r.throttledPeak)} of periods`);
    add("stability.restarts", bar(r.restarts, 0, 2), `${r.restarts} restart${r.restarts === 1 ? "" : "s"}`);
  }

  const judged = a.changes.filter((c) => c.verdict !== "not enough data");
  if (judged.length === 0) add("changes.safe", "not measured", a.changes.length ? "deploys too recent to judge" : "no deploys in the window");
  else {
    const regressed = a.changes.filter((c) => c.verdict === "regressed");
    const live = a.changes.at(-1)?.verdict === "regressed";
    add(
      "changes.safe",
      regressed.length === 0 ? "pass" : live ? "fail" : "warn",
      regressed.length === 0
        ? `${judged.length} deploy${judged.length === 1 ? "" : "s"} judged, none regressed`
        : live
          ? "the latest deploy regressed and nothing has followed it"
          : "a deploy regressed and was followed by another",
    );
  }
  return out;
}

/** Score what the load generator saw, plus whether the backend saw the fault. */
export function checkTest(t: TestObservation, cards: ScorecardBundle): CheckResult[] {
  const out: CheckResult[] = [];
  const failed = t.steady.sent ? 1 - t.steady.ok / t.steady.sent : null;
  out.push(
    failed === null
      ? { id: "resilience.steady_success", outcome: "not measured", detail: "no requests were sent" }
      : { id: "resilience.steady_success", outcome: bar(failed, 0.001, 0.01), detail: `${t.steady.ok} of ${t.steady.sent} requests succeeded before the fault${how(t.steady.failures)}` },
  );
  out.push(
    t.steady.p95 === null
      ? { id: "resilience.steady_latency", outcome: "not measured", detail: "no successful requests to time" }
      : { id: "resilience.steady_latency", outcome: bar(t.steady.p95, 0.5, 1), detail: `p95 ${fmt.latency(t.steady.p95)} before the fault` },
  );
  out.push(
    t.recoverySeconds === null
      ? { id: "resilience.recovery", outcome: "fail", detail: `did not recover within ${TEST_PHASES.recoveryLimitSeconds} s of the fault being removed` }
      : { id: "resilience.recovery", outcome: bar(t.recoverySeconds, 60, 300), detail: `requests succeeded again ${Math.round(t.recoverySeconds)} s after the fault was removed` },
  );

  // Did monitoring see it? Any service whose error ratio rose while the
  // fault was in place, allowing a minute for the metrics to catch up.
  const { range } = cards;
  const from = Math.max(0, Math.floor((t.faultAt - range.start) / range.step));
  const to = Math.ceil((t.restoredAt + 60 - range.start) / range.step);
  const saw = cards.apps.filter((a) => a.series.errorRatio.slice(from, to + 1).some((v) => v !== null && v !== undefined && v > 0.02));
  const affected = t.duringFault.sent > 0 && t.duringFault.ok < t.duringFault.sent;
  out.push(
    saw.length > 0
      ? { id: "resilience.detected", outcome: "pass", detail: `the backend shows errors on ${saw.map((a) => a.id).join(", ")} during the fault` }
      : cards.apps.every((a) => a.performance.errorRatio === null)
        ? { id: "resilience.detected", outcome: "not measured", detail: "the backend has no request data" }
        : { id: "resilience.detected", outcome: "fail", detail: affected ? "requests failed during the fault but the backend shows no errors" : "the backend shows no errors during the fault" },
  );
  return out;
}

/** " (failed: 12 with 502, 3 with timeout)", or nothing when none failed. */
function how(failures?: Record<string, number>): string {
  const parts = Object.entries(failures ?? {}).map(([what, n]) => `${n} with ${what}`);
  return parts.length ? ` (failed: ${parts.join(", ")})` : "";
}

const POINTS: Record<Outcome, number | null> = { pass: 1, warn: 0.5, fail: 0, "not measured": null };

function grade(score: number): BenchmarkResult["grade"] {
  return score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
}

/** Turn check results into area scores, a score, a grade and a coverage. */
export function score(
  apps: AppResult[],
  system: CheckResult[],
): Pick<BenchmarkResult, "areas" | "score" | "grade" | "coverage" | "cappedBy"> {
  const all = [...apps.flatMap((a) => a.checks), ...system];
  const areaOf = new Map(CHECKS.map((c) => [c.id, c.area]));
  const areas = (["availability", "latency", "resources", "stability", "changes", "resilience"] as Area[]).map((area) => {
    const mine = all.filter((c) => areaOf.get(c.id) === area);
    const pts = mine.map((c) => POINTS[c.outcome]).filter((v): v is number => v !== null);
    const count = (o: Outcome) => mine.filter((c) => c.outcome === o).length;
    return {
      area,
      score: pts.length ? Math.round((100 * pts.reduce((a, b) => a + b, 0)) / pts.length) : null,
      pass: count("pass"),
      warn: count("warn"),
      fail: count("fail"),
      notMeasured: count("not measured"),
    };
  });
  // Every area that could be measured counts the same, so a system with many
  // applications is not graded mostly on its resource settings.
  const scored = areas.filter((a) => a.score !== null);
  const measured = all.filter((c) => c.outcome !== "not measured").length;
  const coverage = all.length ? measured / all.length : 0;
  const total = scored.length ? Math.round(scored.reduce((a, b) => a + b.score!, 0) / scored.length) : null;
  const enough = total !== null && coverage >= MIN_COVERAGE;
  if (!enough) return { areas, score: null, grade: "insufficient data", coverage };
  const earned = grade(total);
  const failed = all.find((c) => CAPPING_CHECKS.includes(c.id) && c.outcome === "fail");
  const capped = failed !== undefined && (earned === "A" || earned === "B");
  return {
    areas,
    score: total,
    grade: capped ? "C" : earned,
    coverage,
    ...(capped ? { cappedBy: failed.id } : {}),
  };
}

/** Observe: score whatever the system did in the window. */
export async function runBenchmark(adapter: Adapter, range: TimeRange, test?: TestObservation): Promise<BenchmarkResult> {
  const cards = await buildScorecards(adapter, range, BENCHMARK_SLO);
  const mode = test ? "test" : "observe";
  const apps = cards.apps.map((a) => ({ id: a.id, checks: checkApp(a, range, mode) }));
  const system = test ? checkTest(test, cards) : [];
  return { standard: STANDARD, mode, backend: adapter.name, range, apps, system, ...score(apps, system), test };
}

const MARK: Record<Outcome, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", "not measured": " -- " };
const defOf = new Map(CHECKS.map((c) => [c.id, c]));

export function summarizeBenchmark(b: BenchmarkResult): string {
  const minutes = Math.round((b.range.end - b.range.start) / 60);
  const lines = [
    `Benchmark ${b.standard.id} v${b.standard.version}, ${b.mode} mode, backend "${b.backend}", ` +
      `${minutes} min to ${clock(b.range.end)} UTC.`,
    b.score === null
      ? `Grade: insufficient data (${fmt.percent(b.coverage)} of checks could be measured; ${fmt.percent(MIN_COVERAGE)} are needed).`
      : `Grade: ${b.grade} (${b.score} of 100). ${fmt.percent(b.coverage)} of checks could be measured.` +
        (b.cappedBy ? ` Held at C because a "${defOf.get(b.cappedBy)?.title ?? b.cappedBy}" check failed.` : ""),
    "",
    "By area:",
    ...b.areas.map(
      (a) =>
        `  ${a.area.padEnd(13)} ${a.score === null ? "not measured" : String(a.score).padStart(3) + " of 100"}` +
        (a.score === null ? "" : `  (${a.pass} pass, ${a.warn} warn, ${a.fail} fail${a.notMeasured ? `, ${a.notMeasured} not measured` : ""})`),
    ),
  ];
  const line = (c: CheckResult) => `  ${MARK[c.outcome]}  ${defOf.get(c.id)?.title ?? c.id}: ${c.detail}`;
  if (b.test) {
    const t = b.test;
    lines.push(
      "",
      `Test "${t.plan}": ${t.ratePerSecond} requests per second to ${t.target}; fault: ${t.fault}, ` +
        `in place ${clock(t.faultAt)} to ${clock(t.restoredAt)} UTC. ` +
        `During the fault ${t.duringFault.ok} of ${t.duringFault.sent} requests succeeded${how(t.duringFault.failures)}.`,
      ...b.system.map(line),
    );
  }
  for (const a of b.apps) {
    const shown = a.checks.filter((c) => c.outcome !== "pass" && c.outcome !== "not measured");
    const passed = a.checks.filter((c) => c.outcome === "pass").length;
    const skipped = a.checks.filter((c) => c.outcome === "not measured").length;
    lines.push("", `${a.id}: ${passed} pass, ${shown.length} to look at, ${skipped} not measured`, ...shown.map(line));
  }
  lines.push("", "Bars are fixed by the standard and are the same for every system. \"Not measured\" checks do not count for or against the grade.");
  return lines.join("\n");
}

/** What changed between an earlier result and this one. */
export function compareBenchmarks(before: BenchmarkResult, after: BenchmarkResult): string {
  const lines = [
    `Compared with the run ending ${clock(before.range.end)} UTC (backend "${before.backend}", ${before.mode} mode):`,
    `  grade ${before.grade} -> ${after.grade}` +
      (before.score !== null && after.score !== null ? `, score ${before.score} -> ${after.score}` : ""),
  ];
  if (before.standard.version !== after.standard.version) {
    lines.push(`  The two runs used different versions of the standard (${before.standard.version} and ${after.standard.version}); they are not directly comparable.`);
  }
  if (before.mode !== after.mode) lines.push("  The two runs used different modes, so different checks were measured.");
  const flat = (b: BenchmarkResult) =>
    new Map([...b.apps.flatMap((a) => a.checks.map((c) => [`${a.id}: ${defOf.get(c.id)?.title ?? c.id}`, c] as const)), ...b.system.map((c) => [defOf.get(c.id)?.title ?? c.id, c] as const)]);
  const was = flat(before);
  let moved = 0;
  for (const [key, now] of flat(after)) {
    const old = was.get(key);
    if (!old || old.outcome === now.outcome) continue;
    moved++;
    lines.push(`  ${key}: ${old.outcome} -> ${now.outcome} (${now.detail})`);
  }
  if (moved === 0) lines.push("  No check changed its outcome.");
  return lines.join("\n");
}
