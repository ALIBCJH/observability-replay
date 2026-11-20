import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_SCENARIO_SECONDS, DemoAdapter } from "../src/adapters/demo.js";
import {
  CHECKS,
  MIN_COVERAGE,
  compareBenchmarks,
  runBenchmark,
  score,
  summarizeBenchmark,
  type CheckResult,
  type TestObservation,
} from "../src/benchmark.js";
import { resolveRange } from "../src/replay.js";
import { SCORECARD_MAX_FRAMES } from "../src/scorecard.js";

const NOW = 1_800_000_000;
const range = resolveRange(60, NOW, NOW, SCORECARD_MAX_FRAMES);
const incident = () => new DemoAdapter(range.end - DEMO_SCENARIO_SECONDS);
const outcomeOf = (checks: CheckResult[], id: string) => checks.find((c) => c.id === id)!.outcome;

test("every application gets every per-application check, by id", async () => {
  const b = await runBenchmark(incident(), range);
  const ids = CHECKS.filter((c) => c.scope === "app").map((c) => c.id);
  for (const a of b.apps) assert.deepEqual(a.checks.map((c) => c.id), ids);
  assert.equal(b.mode, "observe");
  assert.deepEqual(b.system, []);
});

test("the scripted incident is graded on what it did", async () => {
  const b = await runBenchmark(incident(), range);
  const of = (id: string) => b.apps.find((a) => a.id === id)!.checks;
  assert.equal(outcomeOf(of("payments"), "availability.success"), "fail");
  assert.equal(outcomeOf(of("payments"), "resources.cpu_throttling"), "fail");
  // Regressed, then rolled back: no longer live.
  assert.equal(outcomeOf(of("payments"), "changes.safe"), "warn");
  assert.notEqual(outcomeOf(of("inventory"), "stability.restarts"), "pass");
  assert.equal(outcomeOf(of("cart"), "availability.success"), "pass");
  assert.ok(b.score !== null && b.score > 0 && b.score < 100);
  assert.match(summarizeBenchmark(b), /Grade: [A-F] \(\d+ of 100\)/);
});

test("areas weigh the same, and unmeasured checks count neither way", () => {
  const app = (outcomes: Record<string, CheckResult["outcome"]>) => ({
    id: "x",
    checks: Object.entries(outcomes).map(([id, outcome]) => ({ id, outcome, detail: "" })),
  });
  const s = score(
    [
      app({
        "availability.success": "fail",
        "resources.memory_limit_set": "pass",
        "resources.cpu_request_set": "pass",
        "resources.memory_headroom": "pass",
        "latency.p95": "not measured",
      }),
    ],
    [],
  );
  // availability 0, resources 100: the mean of the two areas, not of the four checks.
  assert.equal(s.score, 50);
  assert.equal(s.grade, "D");
  assert.equal(s.areas.find((a) => a.area === "latency")!.score, null);
  assert.equal(s.coverage, 4 / 5);
});

test("too little measured means no grade, not a good one", () => {
  const checks = [
    { id: "resources.memory_limit_set", outcome: "pass" as const, detail: "" },
    ...["availability.success", "latency.p95", "stability.restarts"].map((id) => ({ id, outcome: "not measured" as const, detail: "" })),
  ];
  const s = score([{ id: "x", checks }], []);
  assert.ok(s.coverage < MIN_COVERAGE);
  assert.equal(s.score, null);
  assert.equal(s.grade, "insufficient data");
});

test("a test run scores resilience and leaves the broken window's request figures out", async () => {
  const seen: TestObservation = {
    plan: "demo",
    target: "http://example.test/",
    ratePerSecond: 2,
    fault: "something scaled to zero",
    startedAt: range.end - 600,
    // The scripted incident is failing at this point of the window.
    faultAt: range.end - DEMO_SCENARIO_SECONDS + 12 * 60,
    restoredAt: range.end - DEMO_SCENARIO_SECONDS + 13 * 60,
    endedAt: range.end - 60,
    steady: { sent: 120, ok: 120, p95: 0.08 },
    duringFault: { sent: 60, ok: 10 },
    recoverySeconds: 90,
  };
  const b = await runBenchmark(incident(), range, seen);
  assert.equal(b.mode, "test");
  assert.equal(outcomeOf(b.system, "resilience.steady_success"), "pass");
  assert.equal(outcomeOf(b.system, "resilience.steady_latency"), "pass");
  assert.equal(outcomeOf(b.system, "resilience.recovery"), "warn");
  assert.equal(outcomeOf(b.system, "resilience.detected"), "pass");
  for (const a of b.apps) assert.equal(outcomeOf(a.checks, "availability.success"), "not measured");
  const never = await runBenchmark(incident(), range, { ...seen, recoverySeconds: null });
  assert.equal(outcomeOf(never.system, "resilience.recovery"), "fail");
});

test("two results are compared check by check", async () => {
  const bad = await runBenchmark(incident(), range);
  // A window that ends before the scripted incident starts.
  const calm = await runBenchmark(new DemoAdapter(range.end + 3600), range);
  const text = compareBenchmarks(bad, calm);
  assert.match(text, /payments: Requests succeed: fail -> pass/);
  assert.match(compareBenchmarks(calm, calm), /No check changed its outcome/);
});

test("a failed availability check holds the grade at C", () => {
  const checks = [
    { id: "availability.success", outcome: "fail" as const, detail: "" },
    ...["latency.p95", "resources.memory_limit_set", "stability.restarts", "changes.safe", "resilience.steady_success"].map((id) => ({
      id,
      outcome: "pass" as const,
      detail: "",
    })),
  ];
  const s = score([{ id: "x", checks }], []);
  assert.equal(s.score, 83);
  assert.equal(s.grade, "C");
  assert.equal(s.cappedBy, "availability.success");
});
