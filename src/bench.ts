#!/usr/bin/env node
/**
 * Run the benchmark from a terminal.
 *
 *   node dist/bench.js observe [--minutes 30]
 *   node dist/bench.js test --plan benchmark/plans/example.local.json
 *   node dist/bench.js report results/example-run.json
 *
 * The first two save the result as JSON and as a report page (default
 * results/<name>-<time>.json and .html); all three accept --out <file> and
 * --compare <an earlier result file>. The backend comes from the same
 * OBS_* variables as the MCP server.
 *
 * `observe` only reads. `test` sends real requests to the plan's target and
 * runs the plan's fault commands, so use it on a test system, never on one
 * that serves customers.
 */
import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { adapterFromEnv } from "./adapters/index.js";
import {
  TEST_PHASES,
  compareBenchmarks,
  runBenchmark,
  summarizeBenchmark,
  type BenchmarkResult,
  type TestObservation,
} from "./benchmark.js";
import { MAX_WINDOW_MINUTES, MIN_WINDOW_MINUTES, resolveRange } from "./replay.js";
import { SCORECARD_MAX_FRAMES } from "./scorecard.js";

/** The report page, built next to this file, with one result inlined. */
async function writeReport(file: string, result: BenchmarkResult, previous?: BenchmarkResult): Promise<void> {
  const template = await readFile(fileURLToPath(new URL("./benchmark.html", import.meta.url)), "utf-8");
  const data = JSON.stringify({ kind: "benchmark-report", result, previous }).replace(/</g, "\\u003c");
  await writeFile(file, template.replace("/*DATA*/null", () => data));
}

const sh = promisify(exec);
const now = () => Date.now() / 1000;
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

/** What differs from one system to the next. Everything else is fixed. */
export interface Plan {
  name: string;
  load: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /** Requests per second, sent on a fixed clock whether or not earlier ones have answered. */
    ratePerSecond: number;
  };
  fault: {
    description: string;
    /** Shell command that breaks something. */
    inject: string;
    /** Shell command that puts it back. */
    restore: string;
  };
  /** Optional shell command run once at the end, e.g. to clear test data. */
  cleanup?: string;
}

interface Sent {
  at: number;
  ok: boolean;
  seconds: number;
  /** The HTTP status, or the kind of error when there was no response. */
  what: string;
}

/** How many requests ended each way, e.g. { "502": 12, "timeout": 3 }. */
function failures(sent: Sent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sent) if (!s.ok) out[s.what] = (out[s.what] ?? 0) + 1;
  return out;
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
}

/** Steady load, then the fault, then watch until requests succeed again. */
export async function runTest(plan: Plan, log: (line: string) => void = () => {}): Promise<TestObservation> {
  const sent: Sent[] = [];
  const pending = new Set<Promise<void>>();
  const fire = () => {
    const at = now();
    const p = fetch(plan.load.url, {
      method: plan.load.method ?? "GET",
      headers: plan.load.headers,
      body: plan.load.body,
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (res) => {
        await res.arrayBuffer();
        return { ok: res.ok, what: String(res.status) };
      })
      .catch((e: Error) => ({ ok: false, what: e.name === "TimeoutError" ? "timeout" : "no response" }))
      .then(({ ok, what }) => {
        sent.push({ at, ok, seconds: now() - at, what });
        pending.delete(p);
      });
    pending.add(p);
  };
  const timer = setInterval(fire, 1000 / plan.load.ratePerSecond);
  const startedAt = now();
  let faultAt = startedAt;
  let restoredAt = startedAt;
  let recoverySeconds: number | null = null;
  try {
    log(`steady load for ${TEST_PHASES.steadySeconds} s`);
    await sleep(TEST_PHASES.steadySeconds);
    log(`injecting fault: ${plan.fault.description}`);
    faultAt = now();
    await sh(plan.fault.inject);
    await sleep(TEST_PHASES.faultSeconds);
  } finally {
    // Whatever happened above, the fault is removed.
    log("removing fault");
    await sh(plan.fault.restore);
    restoredAt = now();
  }
  try {
    // Recovered: the first request after the fault was removed that begins
    // an unbroken run of successes.
    while (now() - restoredAt < TEST_PHASES.recoveryLimitSeconds) {
      await sleep(1);
      const after = sent.filter((s) => s.at >= restoredAt).sort((a, b) => a.at - b.at);
      let run = 0;
      for (let i = after.length - 1; i >= 0 && after[i]!.ok; i--) run++;
      if (run >= TEST_PHASES.recoveredAfter) {
        recoverySeconds = Math.max(0, after[after.length - run]!.at - restoredAt);
        break;
      }
    }
  } finally {
    clearInterval(timer);
    await Promise.all(pending);
    if (plan.cleanup) await sh(plan.cleanup).catch((e) => log(`cleanup failed: ${e.message}`));
  }
  // Steady means answered before the fault began: a request still in
  // flight when it started belongs to the fault.
  const steady = sent.filter((s) => s.at + s.seconds < faultAt);
  const during = sent.filter((s) => s.at + s.seconds >= faultAt && s.at < restoredAt);
  return {
    plan: plan.name,
    target: plan.load.url,
    ratePerSecond: plan.load.ratePerSecond,
    fault: plan.fault.description,
    startedAt,
    faultAt,
    restoredAt,
    endedAt: now(),
    steady: { sent: steady.length, ok: steady.filter((s) => s.ok).length, p95: p95(steady.filter((s) => s.ok).map((s) => s.seconds)), failures: failures(steady) },
    duringFault: { sent: during.length, ok: during.filter((s) => s.ok).length, failures: failures(during) },
    recoverySeconds,
  };
}

/** How long to wait after a test for the backend to have scraped it. */
const SETTLE_SECONDS = 45;

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const arg = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const load = async (file: string) => JSON.parse(await readFile(file, "utf-8")) as BenchmarkResult;
  if (mode === "report") {
    // Redraw the report page for a result that was saved earlier.
    const file = rest[0];
    if (!file || file.startsWith("--")) throw new Error("report needs a saved result file");
    const out = arg("out") ?? file.replace(/\.json$/, "") + ".html";
    await writeReport(out, await load(file), arg("compare") ? await load(arg("compare")!) : undefined);
    console.error(`report: ${out}`);
    return;
  }
  if (mode !== "observe" && mode !== "test") {
    console.error(
      "usage: bench observe [--minutes N] | bench test --plan <file> | bench report <result.json>   [--out <file>] [--compare <file>]",
    );
    process.exit(2);
  }
  const adapter = adapterFromEnv();
  const log = (line: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

  let result: BenchmarkResult;
  let name = "observe";
  if (mode === "observe") {
    const minutes = Number(arg("minutes") ?? 30);
    result = await runBenchmark(adapter, resolveRange(minutes, undefined, undefined, SCORECARD_MAX_FRAMES));
  } else {
    const file = arg("plan");
    if (!file) throw new Error("test needs --plan <file>");
    const plan = JSON.parse(await readFile(file, "utf-8")) as Plan;
    name = plan.name;
    const seen = await runTest(plan, log);
    log(`waiting ${SETTLE_SECONDS} s for the backend to catch up`);
    await sleep(SETTLE_SECONDS);
    const minutes = Math.min(
      MAX_WINDOW_MINUTES,
      Math.max(MIN_WINDOW_MINUTES, Math.ceil((now() - seen.startedAt) / 60) + 1),
    );
    result = await runBenchmark(adapter, resolveRange(minutes, undefined, undefined, SCORECARD_MAX_FRAMES), seen);
  }

  console.log(summarizeBenchmark(result));
  const previous = arg("compare") ? await load(arg("compare")!) : undefined;
  if (previous) console.log("\n" + compareBenchmarks(previous, result));
  const stamp = new Date(result.range.end * 1000).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const out = arg("out") ?? `results/${name}-${stamp}.json`;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2));
  const page = out.replace(/\.json$/, "") + ".html";
  await writeReport(page, result, previous);
  console.error(`\nsaved: ${out}\nreport: ${page}`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
