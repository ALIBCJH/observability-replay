import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_SCENARIO_SECONDS, DemoAdapter } from "../src/adapters/demo.js";
import { stepsIn } from "../src/model.js";
import { resolveRange } from "../src/replay.js";
import {
  DEFAULT_SLO,
  SCORECARD_MAX_FRAMES,
  buildScorecards,
  sloFromEnv,
  summarizeScorecards,
} from "../src/scorecard.js";

const NOW = 1_800_000_000;
const range = resolveRange(60, NOW, NOW, SCORECARD_MAX_FRAMES);
const incident = () => new DemoAdapter(range.end - DEMO_SCENARIO_SECONDS);

test("scorecards use a bounded number of frames", () => {
  assert.ok(stepsIn(range) <= SCORECARD_MAX_FRAMES + 1);
  assert.equal(range.step, 30);
});

test("apps are ranked worst first and healthy ones stay healthy", async () => {
  const b = await buildScorecards(incident(), range);
  assert.equal(b.apps.length, 8);
  const status = Object.fromEntries(b.apps.map((a) => [a.id, a.status]));
  assert.equal(status.payments, "crit");
  assert.equal(status.checkout, "crit");
  assert.equal(status.cart, "ok");
  assert.equal(status["orders-db"], "ok");
  const firstOk = b.apps.findIndex((a) => a.status === "ok");
  assert.ok(b.apps.slice(firstOk).every((a) => a.status === "ok"));
});

test("error ratio is weighted by traffic and compared with the budget", async () => {
  const b = await buildScorecards(incident(), range);
  const pay = b.apps.find((a) => a.id === "payments")!;
  const s = pay.series;
  let total = 0;
  let failed = 0;
  s.rate.forEach((r, i) => {
    total += r!;
    failed += r! * s.errorRatio[i]!;
  });
  assert.ok(Math.abs(pay.performance.errorRatio! - failed / total) < 1e-12);
  assert.ok(Math.abs(pay.performance.burnRate! - pay.performance.errorRatio! / 0.001) < 1e-9);
  assert.equal(pay.usage.total, Math.round(total * range.step));
});

test("a deploy that made things worse is flagged, and the rollback is seen to fix it", async () => {
  const b = await buildScorecards(incident(), range);
  const pay = b.apps.find((a) => a.id === "payments")!;
  assert.deepEqual(pay.changes.map((c) => [c.kind, c.verdict]), [
    ["deploy", "regressed"],
    ["rollback", "improved"],
  ]);
  assert.ok(pay.changes[0]!.p95After! > 5 * pay.changes[0]!.p95Before!);
  const finding = pay.findings.find((f) => f.text.startsWith("After the deploy"))!;
  // Rolled back since, so it is no longer the live problem.
  assert.equal(finding.severity, "warn");
  assert.match(finding.text, /a rollback followed/);
  // Another service's deploy is never pinned on checkout.
  assert.deepEqual(b.apps.find((a) => a.id === "checkout")!.changes, []);
});

test("a regression with nothing rolled out since is critical", async () => {
  // Window ends 14 minutes into the scenario: after the deploy, before the rollback.
  const early = resolveRange(30, NOW, NOW, SCORECARD_MAX_FRAMES);
  const b = await buildScorecards(new DemoAdapter(early.end - 14 * 60), early);
  const pay = b.apps.find((a) => a.id === "payments")!;
  const finding = pay.findings.find((f) => f.text.startsWith("After the deploy"))!;
  assert.equal(finding.severity, "crit");
  assert.match(finding.text, /nothing has been rolled out since/);
});

test("resource findings: throttling, a leak with restarts, and over-provisioning", async () => {
  const b = await buildScorecards(incident(), range);
  const of = (id: string) => b.apps.find((a) => a.id === id)!;
  const texts = (id: string) => of(id).findings.map((f) => f.text).join("\n");

  assert.match(texts("payments"), /CPU was throttled/);
  assert.ok(of("payments").resources!.throttledPeak! > 0.4);

  assert.ok(of("inventory").resources!.restarts > 0);
  assert.ok(of("inventory").resources!.memPeakOfLimit! > 0.9);
  assert.match(texts("inventory"), /check for a memory leak/);

  assert.match(texts("cart"), /request could be lowered/);
  // Advice to lower a request is a note; it does not make the app unhealthy.
  assert.equal(of("cart").status, "ok");
  assert.ok(of("cart").findings.every((f) => f.severity === "info"));
});

test("a quiet hour produces no warnings", async () => {
  // The scenario starts far in the future, on a whole number of inventory's
  // 18-minute leak cycles after this window opens, so the window covers the
  // low part of one cycle: no incident, no restart, memory well under its limit.
  const quiet = resolveRange(10, NOW, NOW);
  const b = await buildScorecards(new DemoAdapter(quiet.start + 100_000 * 18 * 60), quiet);
  for (const a of b.apps) {
    assert.ok(a.findings.every((f) => f.severity === "info"), `${a.id}: ${JSON.stringify(a.findings)}`);
    assert.equal(a.status, "ok");
  }
});

test("objectives come from the environment, with safe defaults", () => {
  assert.deepEqual(sloFromEnv({}), DEFAULT_SLO);
  assert.deepEqual(sloFromEnv({ OBS_SLO_AVAILABILITY: "99.5", OBS_SLO_P95_MS: "250" }), {
    availability: 0.995,
    latencyP95: 0.25,
  });
  assert.deepEqual(sloFromEnv({ OBS_SLO_AVAILABILITY: "150", OBS_SLO_P95_MS: "-1" }), DEFAULT_SLO);
});

test("a looser objective changes the verdict, not the data", async () => {
  const strict = await buildScorecards(incident(), range, DEFAULT_SLO);
  const loose = await buildScorecards(incident(), range, { availability: 0.5, latencyP95: 10 });
  const pick = (b: typeof strict) => b.apps.find((a) => a.id === "web-gateway")!;
  assert.equal(pick(strict).performance.errorRatio, pick(loose).performance.errorRatio);
  assert.equal(pick(strict).status, "crit");
  assert.equal(pick(loose).status, "ok");
});

test("the text summary names the worst apps and can be limited to one", async () => {
  const b = await buildScorecards(incident(), range);
  const all = summarizeScorecards(b);
  assert.match(all, /payments \[gcp\]: NEEDS ATTENTION/);
  assert.match(all, /cart \[aws\]: healthy/);
  const one = summarizeScorecards(b, "cart");
  assert.match(one, /cart \[aws\]/);
  assert.doesNotMatch(one, /payments \[gcp\]/);
  assert.match(summarizeScorecards(b, "nope"), /No application named "nope"/);
});

test("a workload with no request data still gets a card, scored on resources", async () => {
  const demo = incident();
  // The same backend with tracing absent: resources and changes, no graph.
  const untraced = {
    name: "untraced",
    capabilities: demo.capabilities,
    alerts: (r: typeof range) => demo.alerts(r),
    changes: (r: typeof range) => demo.changes(r),
    resources: (r: typeof range) => demo.resources(r),
    serviceGraph: async (r: typeof range) => ({
      data: { range: r, services: [], serviceSeries: [], edgeSeries: [] },
      queries: [],
    }),
  };
  const b = await buildScorecards(untraced, range);
  assert.ok(b.apps.length > 0);
  const inv = b.apps.find((a) => a.id === "inventory")!;
  assert.equal(inv.usage.total, null);
  assert.equal(inv.performance.errorRatio, null);
  assert.ok(inv.resources!.restarts > 0);
  assert.notEqual(inv.status, "nodata");
  assert.match(summarizeScorecards(b), /no request data/);
});
