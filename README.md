# Observability replay

An MCP server that gives an agent two views over any observability backend:

- **Application scorecards:** how each application is doing, worst first, with
  the same measures on every cloud: request volume, p95 latency, error ratio
  against the error budget, CPU and memory used against what it requested,
  restarts, and whether its last deploy made things better or worse.
- **Incident replay:** the service map animated over a time window, with traffic
  flowing between services, errors and latency spreading, and deploys and alerts
  marked on a timeline you can scrub.

It is built to be backend-agnostic. The agent and the view only see a neutral
model; one adapter per observability tool translates into it.

## Try it in one command

Needs Node 20 or newer.

```bash
npx observability-replay live
```

Then open http://127.0.0.1:8766/. With no backend configured it plays a
scripted incident, so you can see all three pages before connecting anything.

## Try it from a checkout

Needs Node 20 or newer (`nvm use` picks 22).

```bash
npm ci
npm run build
xdg-open dist/apps-preview.html        # scorecards
xdg-open dist/preview.html             # incident replay
xdg-open dist/benchmark-preview.html   # benchmark report
```

On macOS use `open` instead of `xdg-open`; on Windows, open the files from
the file explorer.

The preview plays a scripted incident: a bad `payments` deploy on GCP slows
payments, makes `checkout` on AWS time out, and reaches the gateway, until a
rollback. Add `#at=0.4` to the replay URL to open paused 40% of the way
through, or `#app=inventory` to the scorecards URL to open one application.
The demo also scripts three resource stories: `payments` hits its CPU limit
while failing, `inventory` leaks memory until it restarts, and `cart` uses a
tenth of the CPU it requests.

## Use it from an MCP client

```json
{
  "mcpServers": {
    "observability": {
      "command": "npx",
      "args": ["-y", "observability-replay"],
      "env": { "OBS_BACKEND": "demo" }
    }
  }
}
```

From a checkout, use `"command": "node"` with
`"args": ["/absolute/path/to/observability-replay/dist/server.js"]` instead.

The animated view appears in clients that support MCP Apps. In other clients the
tools still work and return text.

| Tool | What it returns |
| --- | --- |
| `application_scorecards` | The scorecard page, plus each application's status and findings as text |
| `incident_replay` | The animated replay, plus a text summary of what left baseline and in what order |
| `get_service_graph` | Services, calls, and each one's latest rate, error ratio and p95 latency |
| `list_alerts` | Alerts that fired in the window |
| `recent_changes` | Deploys and rollbacks in the window |
| `benchmark` | The benchmark report page, plus the grade and each check that needs a look as text |
| `describe_backend` | Which backend is connected and what it can supply |

Every tool is read-only. Windows are limited to 5 to 360 minutes and at most 240
frames, so no request can pull an unbounded amount of history.

## Connect Prometheus

Works with anything that speaks the Prometheus HTTP API (Prometheus, Thanos,
Mimir, VictoriaMetrics, managed Prometheus).

| Variable | Meaning |
| --- | --- |
| `OBS_BACKEND=prometheus` | Select the adapter |
| `OBS_PROM_URL` | Base URL, e.g. `http://localhost:9090` |
| `OBS_PROM_TOKEN` | Optional bearer token |
| `OBS_PROM_MATCHERS` | Optional label matchers for every graph query, e.g. `cluster="prod"` |
| `OBS_PROM_GRAPH_PREFIX` | Metric prefix, default `traces_service_graph_request` |
| `OBS_PROM_LATENCY_HISTOGRAM` | Latency histogram without `_bucket`, default `<prefix>_server_seconds` |
| `OBS_PROM_CHANGES=off` | Skip the rollout lookup if kube-state-metrics is not scraped |
| `OBS_PROM_RESOURCES=off` | Skip CPU and memory if cAdvisor and kube-state-metrics are not scraped |
| `OBS_PROM_WORKLOAD_LABEL` | Label on container metrics that equals the service name, default `container` |
| `OBS_PROM_WORKLOAD_MATCHERS` | Optional label matchers for every container and rollout query, e.g. `namespace="shop"`, so system pods are not scored |

The service graph is read from the `traces_service_graph_request_*` metrics that
the OpenTelemetry Collector's servicegraph connector and Tempo's
metrics-generator emit. Rollouts are read from kube-state-metrics
(`kube_replicaset_created`); a rollback reuses an old ReplicaSet, so rollbacks
are not seen. CPU, memory, throttling, restarts and replicas come from cAdvisor
and kube-state-metrics, joined to a service by name: the container name must
equal the service name in the traces, or set `OBS_PROM_WORKLOAD_LABEL`. A workload
that has container metrics but appears in no trace still gets a scorecard,
scored on its resources alone.

During development, the adapter queries were exercised against a live Prometheus 3.16
with kube-state-metrics 2.20 and the OpenTelemetry Collector 0.165 service
graph connector, on a k3d cluster running a traced application: the service
graph, an outage found by both views, CPU, memory, replicas and rollouts.
Alerts are read from `ALERTS` but no alert fired during those live runs.
These are development observations, not a compatibility guarantee; the included
tests use fixtures and a local mock server.

Two things the live runs taught, both handled:

- **A failure counter is born non-zero.** The first failures on an edge
  create the series already at, say, 12, and `rate()` sees no increase.
  Run Prometheus with `--enable-feature=created-timestamp-zero-ingestion`
  and have the exporter send creation times (the Collector's
  `enable_open_metrics: true`), or the start of an incident is lost.
- **Memory looks like it spikes during a rollout** if usage is summed over
  pods that are already gone. Usage is counted only for pods that
  kube-state-metrics still lists.

### A Prometheus for a local cluster

`deploy/monitoring/monitoring.yaml` puts Prometheus, kube-state-metrics and
an OpenTelemetry Collector in their own `monitoring` namespace. Prometheus
scrapes each kubelet's cAdvisor. Applications send spans to the Collector
(`http://otel-collector.monitoring.svc:4318`, OTLP over HTTP); it turns them
into the service graph metrics and stores no traces. Its filter lists the
span sources and paths to leave out of the graph (SDK-level spans that
repeat a network call, readiness probes); adjust it to your application.

```bash
kubectl apply -f deploy/monitoring/monitoring.yaml
export OBS_BACKEND=prometheus
export OBS_PROM_URL=http://127.0.0.1:9090
export OBS_PROM_WORKLOAD_MATCHERS='namespace="example"'   # your applications' namespace
npm start
```

In a separate terminal, run `kubectl -n monitoring port-forward svc/prometheus
9090:9090`. The manifest is for a disposable local cluster: it uses a NodePort,
unauthenticated endpoints, cluster-wide read access, and local storage. Do not
expose it to the public internet. The optional `deploy/monitoring/prom-url.sh
<k3d-node-container>` helper prints the NodePort URL on hosts that can reach
Docker container addresses.

## Watch a backend live

`npx observability-replay live` (or `npm run live` in a checkout) serves the three pages on the connected backend's own data,
on this machine only (`127.0.0.1`), so you can leave the applications page
open while something happens: a deploy, a load test, a pod being killed.

```bash
npm run build
export OBS_BACKEND=prometheus OBS_PROM_URL=http://127.0.0.1:9090
npm run live -- --minutes 15 --refresh 10     # then open http://127.0.0.1:8766/
```

Each page load reads the backend again, and the applications page re-reads
every `--refresh` seconds (0 turns that off) and keeps the open application
selected. `--minutes` is the window each page covers and `--port` changes the
port. The pages are read-only and have no sign-in, which is why they are bound
to the loopback address; do not put them behind a public proxy.

## What the scorecard measures

Objectives are set once for the whole fleet: `OBS_SLO_AVAILABILITY` (percent,
default 99.9) and `OBS_SLO_P95_MS` (default 500).

| Measure | Definition |
| --- | --- |
| Errors | Failed requests over all requests in the window, weighted by traffic |
| Burn rate | Errors divided by the error budget (100% minus the availability objective); 1× is exactly on budget, 14.4× or more is critical |
| Latency | Minutes of the window with p95 above the objective |
| CPU of request | CPU used divided by CPU requested, mean and peak |
| CPU throttled | Peak share of CPU periods throttled; 25% or more is a warning |
| Memory of limit | Peak memory in use divided by the memory limit; 90% or more is a warning |
| Restarts | Container restarts in the window; three or more is critical |
| Change effect | p95 and errors between the previous change and this one, against between this one and the next; "regressed" means p95 more than doubled (and +100 ms) or errors more than tripled (and +2 points) |

A regression is critical while nothing has been rolled out since, and a warning
once a later deploy or rollback has followed it. Advice to lower an oversized
CPU request is a note and never makes an application unhealthy. Cost is not
measured yet.

## The benchmark

One fixed standard for a healthy system, the same on every cloud and backend.
What is measured, the bars and the grading are defined in `src/benchmark.ts`
and cannot be configured, so two results are always comparable; changing any
of them makes a new version of the standard (now 1.0).

| Area | Check | Pass | Warn |
| --- | --- | --- | --- |
| Availability | Requests succeed | 99.9% or more | 99% or more |
| Latency | p95 stays under 500 ms | over for at most 1% of the window | at most 10% |
| Resources | A memory limit is set | set | |
| Resources | A CPU request is set | set | |
| Resources | Memory stays clear of its limit | peak 80% or less | 90% or less |
| Resources | CPU is not throttled | 5% of periods or less | 25% or less |
| Stability | Containers do not restart | 0 | 1 or 2 |
| Changes | Deploys do not make things worse | none regressed | one did, and was followed |
| Resilience | Requests succeed under steady load | 99.9% or more | 99% or more |
| Resilience | p95 latency under steady load | 500 ms or less | 1 s or less |
| Resilience | Recovers after a failure | within 60 s | within 300 s |
| Resilience | The failure is visible in monitoring | the backend shows errors | |

The first eight are scored per application, the resilience four once per
test. A pass is 1 point, a warn half, a fail none. Each area's score is the
share of points over the checks that could be measured, and the overall score
is the mean of the areas, so a system with many applications is not graded
mostly on its resource settings. A is 90 or more, B 75, C 60, D 40. Two rules
keep the grade honest: a check that could not be measured counts neither way,
and no grade is given if fewer than half could be measured; and a failed
"requests succeed" or "recovers after a failure" check holds the grade at C.

For an active test, first follow [the plan setup](benchmark/plans/README.md)
and create `benchmark/plans/example.local.json`. Only run plans you have reviewed:
their fault and cleanup fields execute shell commands with your permissions.

Two ways to run it, both reading the backend from the same `OBS_*` variables:

```bash
npm run benchmark -- observe --minutes 30
npm run benchmark -- test --plan benchmark/plans/example.local.json --compare results/earlier.json
```

- **Observe** only reads: it grades what the system did in the window. It is
  also the `benchmark` MCP tool.
- **Test** is active, so point it at a test system only. It sends a steady
  load for 60 s, runs the plan's fault command, removes the fault after 30 s,
  and watches for up to 300 s until ten requests in a row succeed again. The
  timings are fixed by the standard; a plan supplies only the URL to load, the
  rate, and the two shell commands that break something and put it back. In
  test mode the per-application availability and latency checks are left out,
  because the window was broken on purpose.

Each run is saved under `results/` as JSON and as a report page (one
self-contained HTML file that opens in any browser, light or dark, and prints).
The page leads with the grade, then the score by area, what to fix with the
widest problems first, the test timeline, and every application against every
check. `--compare` adds what changed since an earlier result. To redraw the
page for a saved result:

```bash
npm run benchmark -- report results/example-run.json --compare results/earlier.json
```

`dist/benchmark-preview.html` is the same page on the scripted demo incident.

## How it is put together

```
src/model.ts            the neutral model (services, edges, samples, alerts, changes)
src/adapters/types.ts   the Adapter interface and its capability flags
src/adapters/demo.ts    scripted incident
src/adapters/prometheus.ts
src/replay.ts           bounded time ranges, baseline/onset detection, the bundle, the text summary
src/scorecard.ts        the scorecard definitions, findings and text summary
src/benchmark.ts        the benchmark standard, its checks, scoring and comparison
src/bench.ts            the benchmark command line: observe, and the active test
src/server.ts           the MCP tools and the view resources
view/                   the three pages, each bundled into one HTML file
```

Three rules the code holds to:

- **The agent never draws the data.** It chooses the window and the focus; the
  adapter runs the queries; the view draws only what came back. Motion is
  interpolated between samples, but every printed number is a real sample.
- **Every view shows its source queries**, in the backend's own language, so a
  number can be checked in the source tool.
- **A gap stays a gap.** Missing samples are drawn as "no data", never filled.

"Off baseline" means beyond 3× the median of the first fifth of the window
(with a floor of +100 ms latency or +2 points of error ratio). A service with
no samples at the start of the window has its errors judged against zero. An incident
already under way when the window opens will therefore not be detected; widen
the window.

## Adding a backend

Implement `Adapter` from `src/adapters/types.ts`, set its capability flags
honestly, and register it in `src/adapters/index.ts`. Nothing else changes.

## Tests

```bash
npm test
```

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and pull requests, and
[SECURITY.md](SECURITY.md) for the security model and vulnerability reporting.
Saved reports contain backend data; `results/` and local benchmark plans are
excluded from Git. Review any report before sharing it.

## License

Licensed under the [Apache License 2.0](LICENSE).
