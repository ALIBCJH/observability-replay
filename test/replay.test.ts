import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_SCENARIO_SECONDS, DemoAdapter } from "../src/adapters/demo.js";
import { stepsIn } from "../src/model.js";
import { MAX_FRAMES, buildReplay, findOnsets, resolveRange, summarize } from "../src/replay.js";

const NOW = 1_800_000_000;

test("resolveRange clamps the window and aligns to the step", () => {
  const r = resolveRange(30, undefined, NOW + 7);
  assert.equal(r.step, 15);
  assert.equal(r.end % r.step, 0);
  assert.equal(r.end - r.start, 30 * 60);

  const huge = resolveRange(100_000, undefined, NOW);
  assert.equal(huge.end - huge.start, 360 * 60);
  assert.ok(stepsIn(huge) <= MAX_FRAMES + 1);

  const tiny = resolveRange(0, undefined, NOW);
  assert.equal(tiny.end - tiny.start, 5 * 60);
});

test("resolveRange never reaches into the future", () => {
  const r = resolveRange(30, NOW + 3600, NOW);
  assert.ok(r.end <= NOW);
});

test("the demo incident is deterministic", async () => {
  const range = resolveRange(30, NOW, NOW);
  const a = await new DemoAdapter(range.start).serviceGraph(range);
  const b = await new DemoAdapter(range.start).serviceGraph(range);
  assert.deepEqual(a.data, b.data);
});

test("replay finds the incident and orders it from origin outwards", async () => {
  const range = resolveRange(30, NOW, NOW);
  const adapter = new DemoAdapter(range.end - DEMO_SCENARIO_SECONDS);
  const bundle = await buildReplay(adapter, range, "payments");

  assert.equal(bundle.services.length, 8);
  assert.equal(bundle.edgeSeries.length, 7);
  for (const s of bundle.serviceSeries) assert.equal(s.rate.length, stepsIn(range));

  const firstOf = (service: string) => bundle.onsets.find((o) => o.service === service)?.at;
  assert.equal(bundle.onsets[0]?.service, "payments");
  assert.ok(firstOf("payments")! < firstOf("checkout")!);
  assert.ok(firstOf("checkout")! < firstOf("web-gateway")!);
  // The fault starts with the deploy, never before it.
  assert.ok(firstOf("payments")! >= bundle.changes[0]!.at);
  // Services off the failing path stay quiet.
  assert.equal(firstOf("cart"), undefined);
  assert.equal(firstOf("orders-db"), undefined);
  // Starved downstream services show up as a drop in traffic.
  assert.ok(bundle.onsets.some((o) => o.service === "notifications" && o.signal === "rate_drop"));

  assert.deepEqual(bundle.changes.map((c) => c.kind), ["deploy", "rollback"]);
  assert.equal(bundle.alerts.length, 2);
  assert.equal(bundle.focus, "payments");

  const text = summarize(bundle);
  assert.match(text, /1\. \d\d:\d\d:\d\d payments/);
  assert.match(text, /not proven cause/);
});

test("an unknown focus service is dropped, not passed to the view", async () => {
  const range = resolveRange(30, NOW, NOW);
  const bundle = await buildReplay(new DemoAdapter(range.start), range, "nope");
  assert.equal(bundle.focus, undefined);
});

test("a quiet window reports nothing off baseline", async () => {
  const range = resolveRange(30, NOW, NOW);
  // Scenario starts a day later, so this window is all baseline.
  const bundle = await buildReplay(new DemoAdapter(NOW + 86_400), range);
  assert.deepEqual(bundle.onsets, []);
  assert.deepEqual(bundle.alerts, []);
  assert.deepEqual(bundle.changes, []);
  assert.match(summarize(bundle), /No signal left its baseline/);
});

test("errors on a service with no samples at the start of the window are still an onset", () => {
  const r = { start: 0, end: 15 * 19, step: 15 };
  const quiet = new Array(20).fill(null);
  const errors = [...new Array(12).fill(null), 0.6, 0.6, 0.6, 0.6, 0, 0, 0, 0];
  const [onset] = findOnsets([{ service: "api", rate: quiet, latencyP95: quiet, errorRatio: errors }], r);
  assert.equal(onset?.signal, "error_ratio");
  assert.equal(onset?.at, 12 * 15);
  assert.equal(onset?.baseline, 0);
});
