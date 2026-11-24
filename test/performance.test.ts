import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_SCENARIO_SECONDS, DemoAdapter } from "../src/adapters/demo.js";
import type { Adapter } from "../src/adapters/types.js";
import { stepsIn } from "../src/model.js";
import {
  PERFORMANCE_MAX_FRAMES,
  PERFORMANCE_RANGES,
  buildPerformance,
  change,
  isRangeKey,
  performanceRange,
  previousRange,
  summarizePerformance,
} from "../src/performance.js";

const NOW = 1_800_000_000;
/** The scripted incident ends at NOW, so the last hour holds it and the hour before is quiet. */
const demo = () => new DemoAdapter(NOW - DEMO_SCENARIO_SECONDS);

test("every period is bounded, step-aligned and followed by its previous period", () => {
  for (const key of PERFORMANCE_RANGES) {
    const r = performanceRange(key, NOW + 7);
    assert.ok(stepsIn(r) <= PERFORMANCE_MAX_FRAMES + 1, `${key} has ${stepsIn(r)} samples`);
    assert.equal(r.end % r.step, 0);
    assert.equal(r.step % 15, 0);
    assert.ok(r.end <= NOW + 7);
    const p = previousRange(r);
    assert.equal(p.end, r.start);
    assert.equal(p.end - p.start, r.end - r.start);
    assert.equal(p.step, r.step);
  }
  assert.equal(performanceRange("30d", NOW).end - performanceRange("30d", NOW).start, 30 * 86400);
  assert.equal(isRangeKey("7d"), true);
  assert.equal(isRangeKey("8d"), false);
  assert.equal(isRangeKey(60), false);
});

test("figures are computed from the samples, against the period before", async () => {
  const b = await buildPerformance(demo(), "1h", undefined, NOW);
  assert.equal(b.kind, "performance");
  assert.equal(b.simulated, true);
  assert.equal(b.services[0]!.id, "web-gateway", "busiest first");

  const pay = b.services.find((s) => s.id === "payments")!;
  // Requests are the rate samples times the step, nothing else.
  const expected = Math.round(pay.series.rate.reduce<number>((a, v) => a + (v ?? 0), 0) * b.range.step);
  assert.equal(pay.requests.now, expected);
  // The incident is in this hour and not in the one before.
  assert.ok(pay.errorRatio.now! > 0.02);
  assert.ok(pay.errorRatio.before! < 0.001);
  assert.ok(pay.p95Worst! > 1.5);
  assert.ok(pay.p50.now! < pay.p90.now! && pay.p90.now! < pay.p95.now! * 1.01 && pay.p95.now! < pay.p99.now!);
  assert.ok(pay.cpu!.now! > pay.cpu!.before!);
  assert.equal(pay.series.rateBefore.length, pay.series.rate.length);

  // Traffic itself did not change, so the comparison says so.
  const gw = b.services.find((s) => s.id === "web-gateway")!;
  assert.ok(Math.abs(change(gw.requests)!) < 0.03);

  // All services together: the sum of the services, and failures weighted by traffic.
  const sum = b.services.reduce((a, s) => a + (s.requests.now ?? 0), 0);
  assert.ok(Math.abs(b.totals.requests.now! - sum) <= b.services.length);
  assert.ok(b.totals.errorRatio.now! > b.totals.errorRatio.before!);
});

test("routes carry their share of the service, their errors by class and their latency", async () => {
  const b = await buildPerformance(demo(), "1h", undefined, NOW);
  const routes = b.endpoints.filter((e) => e.service === "payments");
  assert.deepEqual(routes.map((e) => e.endpoint).sort(), ["GET /payments/{id}", "POST /payments"]);
  assert.ok(Math.abs(routes.reduce((a, e) => a + e.share!, 0) - 1) < 1e-6);
  const post = routes.find((e) => e.endpoint === "POST /payments")!;
  assert.ok(post.ratio5xx! > 0.02, "the failing route shows its 5xx");
  assert.ok(post.ratio4xx! > 0 && post.ratio4xx! < 0.01);
  assert.ok(post.p95Worst! > post.p95!);
  // A database has no HTTP routes, and none are made up for it.
  assert.equal(b.endpoints.filter((e) => e.service === "orders-db").length, 0);
});

test("the text names simulated data, limits itself to one service and claims no cause", async () => {
  const b = await buildPerformance(demo(), "1h", "payments", NOW);
  assert.equal(b.focus, "payments");
  const text = summarizePerformance(b, "payments");
  assert.match(text, /SIMULATED demo data/);
  assert.match(text, /- payments \[gcp\]/);
  assert.doesNotMatch(text, /- cart/);
  assert.match(text, /Slowest routes:/);
  assert.match(text, /shows that a figure moved, not why/);
  assert.match(summarizePerformance(b, "nope"), /No service called "nope"/);
  assert.equal((await buildPerformance(demo(), "1h", "nope", NOW)).focus, undefined);
});

test("what cannot be read becomes a stated gap, never a made-up figure", async () => {
  const d = demo();
  const broken: Adapter = {
    name: "broken",
    capabilities: { ...d.capabilities, resources: false },
    serviceGraph: (r) => (r.end <= NOW - 3600 ? Promise.reject(new Error("retention exceeded")) : d.serviceGraph(r)),
    alerts: (r) => d.alerts(r),
    changes: (r) => d.changes(r),
    resources: (r) => d.resources(r),
    latency: () => Promise.reject(new Error("query timed out")),
    endpoints: async () => ({ data: [], queries: [] }),
  };
  const b = await buildPerformance(broken, "1h", undefined, NOW);
  assert.equal(b.simulated, false);
  const pay = b.services.find((s) => s.id === "payments")!;
  assert.ok(pay.requests.now! > 0);
  assert.equal(pay.requests.before, null);
  assert.equal(change(pay.requests), null);
  assert.equal(pay.p99.now, null);
  assert.equal(pay.latencyMean.now, null);
  assert.equal(pay.cpu, null);
  assert.equal(pay.series.p99, undefined);
  assert.ok(pay.series.rateBefore.every((v) => v === null));
  assert.equal(b.endpoints.length, 0);
  assert.equal(b.totals.requests.before, null);
  const gaps = b.gaps.join("\n");
  assert.match(gaps, /The previous period could not be read: retention exceeded/);
  assert.match(gaps, /Latency percentiles could not be read: query timed out/);
  assert.match(gaps, /no per-route metrics/);
  assert.match(gaps, /CPU and memory are switched off/);
  assert.match(summarizePerformance(b), /Not available:/);

  // The chosen period itself failing is an error, not an empty page.
  await assert.rejects(
    buildPerformance({ ...broken, serviceGraph: () => Promise.reject(new Error("connection refused")) }, "1h", undefined, NOW),
    /connection refused/,
  );
});

test("a service with no samples has null figures and sorts last", async () => {
  const d = demo();
  const quiet: Adapter = {
    name: "quiet",
    capabilities: d.capabilities,
    alerts: (r) => d.alerts(r),
    changes: (r) => d.changes(r),
    resources: (r) => d.resources(r),
    latency: (r) => d.latency(r),
    endpoints: (r) => d.endpoints(r),
    serviceGraph: async (r) => {
      const g = await d.serviceGraph(r);
      const n = stepsIn(r);
      g.data.services.push({ id: "idle" });
      g.data.serviceSeries.push({ service: "idle", rate: new Array(n).fill(null), errorRatio: new Array(n).fill(null), latencyP95: new Array(n).fill(null) });
      return g;
    },
  };
  const b = await buildPerformance(quiet, "15m", undefined, NOW);
  const idle = b.services.at(-1)!;
  assert.equal(idle.id, "idle");
  assert.equal(idle.requests.now, null);
  assert.equal(idle.errorRatio.now, null);
  assert.equal(idle.p95.now, null);
});
