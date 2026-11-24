import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { PrometheusAdapter } from "../src/adapters/prometheus.js";
import type { TimeRange } from "../src/model.js";
import { buildPerformance } from "../src/performance.js";
import { buildReplay } from "../src/replay.js";
import { buildScorecards } from "../src/scorecard.js";

/** A stand-in for the Prometheus HTTP API that answers by query text. */
const range: TimeRange = { start: 1000, end: 1060, step: 15 }; // 5 samples
const seen: { path: string; query: string; auth?: string }[] = [];
let server: Server;
let url: string;

const matrix = (metric: Record<string, string>, values: (number | null)[]) => ({
  metric,
  values: values.flatMap((v, i) => (v === null ? [] : [[range.start + i * range.step, String(v)]])),
});

function answer(path: string, query: string): unknown[] | { error: string } {
  if (query.includes("boom")) return { error: "parse error: unexpected boom" };
  if (path.endsWith("/query")) {
    return [{ metric: { namespace: "shop", replicaset: "api-7d9f8c6b5" }, value: [range.end, "1030"] }];
  }
  // HTTP server metrics, per route. The 404 route never answered 5xx, so it
  // has no 5xx series at all.
  if (query.includes("http_server") || query.includes("my_http")) {
    const orders = { service_name: "api", http_request_method: "POST", http_route: "/orders" };
    const item = { service_name: "api", http_request_method: "GET", http_route: "/orders/{id}" };
    if (query.includes('=~"5.."')) return [matrix(orders, [0, 0, 2, 2, 0])];
    if (query.includes('=~"4.."')) return [matrix(orders, [0, 0, 0, 0, 0]), matrix(item, [1, 1, null, 1, 1])];
    if (query.includes("histogram_quantile")) return [matrix(orders, [0.2, 0.2, 1.5, 1.5, 0.2]), matrix(item, [0.05, 0.05, null, 0.05, 0.05])];
    return [
      matrix(orders, [4, 4, 4, 4, 4]),
      matrix(item, [6, 6, null, 6, 6]),
      // No route label: a request that matched nothing, not an endpoint.
      matrix({ service_name: "api", http_request_method: "GET" }, [1, 1, 1, 1, 1]),
    ];
  }
  if (query.includes("_seconds_sum")) return [matrix({ server: "api" }, [0.05, 0.05, 0.4, 0.4, 0.05])];
  // Container and kube-state-metrics queries, matched before the graph ones
  // because several of their names also end in `_total`.
  if (query.includes("container_cpu_cfs")) return [matrix({ container: "api" }, [0, 0, 0.4, 0.4, 0])];
  if (query.includes("container_cpu_usage")) return [matrix({ container: "api" }, [0.5, 0.5, 1, 1, 0.5])];
  if (query.includes('resource="cpu"')) return [matrix({ container: "api" }, [1, 1, 1, 1, 1])];
  if (query.includes("container_memory")) return [matrix({ container: "api" }, [100, 100, 190, 190, 100])];
  if (query.includes('resource="memory"')) return [matrix({ container: "api" }, [200, 200, 200, 200, 200])];
  if (query.includes("restarts_total")) return [matrix({ container: "api" }, [0, 0, 0, 1, 0])];
  if (query.includes("status_running")) return [matrix({ container: "api" }, [2, 2, 2, 2, 2])];
  if (query.includes("_failed_total")) {
    return [matrix({ client: "web", server: "api" }, [0, 0, 5, 5, 0])];
  }
  if (query.includes("_total")) {
    return [
      // The third sample of web->api is missing on purpose.
      matrix({ client: "web", server: "api" }, [10, 10, null, 10, 10]),
      matrix({ client: "api", server: "db" }, [20, 20, 20, 20, 20]),
    ];
  }
  if (query.includes("histogram_quantile")) {
    return [matrix({ server: "api" }, [0.1, 0.1, 0.9, 0.9, 0.1])];
  }
  if (query.includes("ALERTS")) {
    return [matrix({ alertname: "ApiErrors", severity: "critical", service: "api" }, [null, null, 1, 1, null])];
  }
  return [];
}

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const query = new URLSearchParams(body).get("query") ?? "";
      seen.push({ path: req.url ?? "", query, auth: req.headers.authorization });
      const result = answer(req.url ?? "", query);
      res.setHeader("content-type", "application/json");
      if (!Array.isArray(result)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ status: "error", error: result.error }));
        return;
      }
      res.end(JSON.stringify({ status: "success", data: { result } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
after(() => server.close());

test("service graph: edges, ratios, gaps and node roll-up", async () => {
  const { data, queries } = await new PrometheusAdapter({ url }).serviceGraph(range);
  assert.deepEqual(data.services.map((s) => s.id), ["api", "db", "web"]);

  const webApi = data.edgeSeries.find((e) => e.from === "web" && e.to === "api")!;
  assert.deepEqual(webApi.rate, [10, 10, null, 10, 10]);
  // A gap stays a gap: no ratio is invented where there was no rate.
  assert.deepEqual(webApi.errorRatio, [0, 0, null, 0.5, 0]);

  const api = data.serviceSeries.find((s) => s.service === "api")!;
  assert.deepEqual(api.rate, [10, 10, null, 10, 10]);
  assert.deepEqual(api.latencyP95, [0.1, 0.1, 0.9, 0.9, 0.1]);

  // web is only ever a caller, so it has no inbound view of its own.
  const web = data.serviceSeries.find((s) => s.service === "web")!;
  assert.deepEqual(web.rate, [null, null, null, null, null]);

  assert.equal(queries.length, 4);
  assert.ok(queries.every((q) => q.language === "PromQL"));
});

test("alerts become firing periods", async () => {
  const { data } = await new PrometheusAdapter({ url }).alerts(range);
  assert.deepEqual(data, [
    { name: "ApiErrors", severity: "critical", service: "api", startsAt: 1030, endsAt: 1060 },
  ]);
});

test("rollouts come from new ReplicaSets", async () => {
  const { data } = await new PrometheusAdapter({ url }).changes(range);
  assert.equal(data.length, 1);
  assert.equal(data[0]!.service, "api");
  assert.equal(data[0]!.at, 1030);
});

test("matchers, custom prefix and bearer token are applied", async () => {
  seen.length = 0;
  await new PrometheusAdapter({
    url,
    bearerToken: "s3cret",
    graphPrefix: "sg_request",
    matchers: 'cluster="prod"',
  }).serviceGraph(range);
  assert.ok(seen.every((s) => s.auth === "Bearer s3cret"));
  assert.ok(seen.some((s) => s.query.includes('sg_request_total{cluster="prod"}')));
  assert.ok(seen.some((s) => s.query.includes('sg_request_server_seconds_bucket{connection_type="",cluster="prod"}')));
});

test("a backend error is reported with Prometheus' own message", async () => {
  const adapter = new PrometheusAdapter({ url, graphPrefix: "boom" });
  await assert.rejects(adapter.serviceGraph(range), /parse error: unexpected boom/);
});

test("a full replay can be built on the Prometheus adapter", async () => {
  const bundle = await buildReplay(new PrometheusAdapter({ url }), range);
  assert.equal(bundle.backend, "prometheus");
  assert.equal(bundle.alerts.length, 1);
  assert.equal(bundle.changes.length, 1);
  assert.equal(bundle.queries.length, 6);
});

test("resources are read per workload and joined to the service by name", async () => {
  const { data, queries } = await new PrometheusAdapter({ url }).resources(range);
  assert.equal(data.length, 1);
  assert.deepEqual(data[0]!.cpuUsage, [0.5, 0.5, 1, 1, 0.5]);
  assert.deepEqual(data[0]!.memLimit, [200, 200, 200, 200, 200]);
  assert.deepEqual(data[0]!.restarts, [0, 0, 0, 1, 0]);
  assert.equal(queries.length, 7);

  const cards = await buildScorecards(new PrometheusAdapter({ url }), range);
  const api = cards.apps.find((a) => a.id === "api")!;
  assert.equal(api.resources?.restarts, 1);
  assert.equal(api.resources?.memPeakOfLimit, 0.95);
  // db appears in the graph but has no container metrics: no resources, no guess.
  assert.equal(cards.apps.find((a) => a.id === "db")!.resources, null);
});

test("resources can be switched off", async () => {
  const adapter = new PrometheusAdapter({ url, resources: false });
  assert.equal(adapter.capabilities.resources, false);
  const cards = await buildScorecards(adapter, range);
  assert.ok(cards.apps.every((a) => a.resources === null));
});

test("workload matchers scope the container and rollout queries, not the graph", async () => {
  seen.length = 0;
  const adapter = new PrometheusAdapter({ url, workloadMatchers: 'namespace="shop"' });
  await adapter.resources(range);
  await adapter.changes(range);
  await adapter.serviceGraph(range);
  const scoped = seen.filter((s) => /container_|kube_/.test(s.query));
  assert.equal(scoped.length, 8);
  for (const s of scoped) assert.match(s.query, /namespace="shop"/);
  for (const s of seen.filter((x) => x.query.includes("traces_service_graph"))) {
    assert.doesNotMatch(s.query, /namespace/);
  }
});

test("latency detail: mean and percentiles from the same histogram as the p95", async () => {
  seen.length = 0;
  const { data, queries } = await new PrometheusAdapter({ url, matchers: 'cluster="prod"' }).latency(range);
  assert.equal(queries.length, 4);
  const api = data.find((s) => s.service === "api")!;
  assert.deepEqual(api.mean, [0.05, 0.05, 0.4, 0.4, 0.05]);
  assert.deepEqual(api.p99, [0.1, 0.1, 0.9, 0.9, 0.1]);
  assert.ok(seen.some((s) => s.query.startsWith("histogram_quantile(0.5,")));
  assert.ok(seen.some((s) => s.query.startsWith("histogram_quantile(0.99,")));
  assert.ok(seen.every((s) => s.query.includes('cluster="prod"')));
});

test("endpoints: requests, 4xx, 5xx and p95 per route, with gaps kept", async () => {
  const { data, queries } = await new PrometheusAdapter({ url }).endpoints(range);
  assert.equal(queries.length, 4);
  assert.deepEqual(data.map((e) => e.endpoint), ["GET /orders/{id}", "POST /orders"]);
  const orders = data.find((e) => e.endpoint === "POST /orders")!;
  assert.equal(orders.service, "api");
  assert.deepEqual(orders.rate5xx, [0, 0, 2, 2, 0]);
  assert.deepEqual(orders.latencyP95, [0.2, 0.2, 1.5, 1.5, 0.2]);
  const item = data.find((e) => e.endpoint === "GET /orders/{id}")!;
  // No 5xx series means zero where the route had traffic, and still a gap where it had none.
  assert.deepEqual(item.rate5xx, [0, 0, null, 0, 0]);
  assert.deepEqual(item.rate4xx, [1, 1, null, 1, 1]);
});

test("endpoint metric and label names can be mapped, scoped or switched off", async () => {
  seen.length = 0;
  await new PrometheusAdapter({
    url,
    httpHistogram: "my_http_seconds",
    httpServiceLabel: "app",
    httpRouteLabel: "path",
    httpMethodLabel: "",
    httpStatusLabel: "code",
    httpMatchers: 'namespace="shop"',
  }).endpoints(range);
  assert.ok(seen.some((s) => s.query === 'sum by (app, path) (rate(my_http_seconds_count{code=~"5..",namespace="shop"}[60s]))'));
  assert.ok(seen.some((s) => s.query.includes('sum by (app, path, le) (rate(my_http_seconds_bucket{namespace="shop"}[60s]))')));

  const off = new PrometheusAdapter({ url, endpoints: false });
  assert.equal(off.capabilities.endpoints, false);
  seen.length = 0;
  assert.deepEqual((await off.endpoints(range)).data, []);
  assert.equal(seen.length, 0);
});

test("a performance report can be built on the Prometheus adapter", async () => {
  const b = await buildPerformance(new PrometheusAdapter({ url }), "15m", undefined, 1060);
  assert.equal(b.backend, "prometheus");
  assert.equal(b.simulated, false);
  assert.ok(b.services.some((s) => s.id === "api"));
  assert.ok(b.queries.every((q) => q.language === "PromQL"));
});
