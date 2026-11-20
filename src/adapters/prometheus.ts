import {
  stepsIn,
  type AlertEvent,
  type ResourceSeries,
  type ChangeEvent,
  type Samples,
  type ServiceGraphSeries,
  type ServiceRef,
  type SourceQuery,
  type TimeRange,
} from "../model.js";
import type { Adapter, Sourced } from "./types.js";

/**
 * Anything that speaks the Prometheus HTTP API: Prometheus, Thanos, Mimir,
 * VictoriaMetrics, and the managed Prometheus services.
 *
 * The service graph comes from the metrics that the OpenTelemetry Collector's
 * servicegraph connector and Tempo's metrics-generator both emit
 * (`traces_service_graph_request_*`, labelled `client` and `server`).
 */
export interface PrometheusOptions {
  /** Base URL, e.g. http://localhost:9090 (Mimir: include the /prometheus prefix). */
  url: string;
  bearerToken?: string;
  /** Metric name prefix. Default `traces_service_graph_request`. */
  graphPrefix?: string;
  /** Server-side latency histogram, without `_bucket`. Default `<prefix>_server_seconds`. */
  latencyHistogram?: string;
  /** Extra label matchers added to every graph query, e.g. `cluster="prod"`. */
  matchers?: string;
  /** Set false to skip the kube-state-metrics rollout lookup. */
  changes?: boolean;
  /** Set false if cAdvisor and kube-state-metrics are not scraped. */
  resources?: boolean;
  /**
   * Label on the container metrics whose value equals the service id used in
   * the service graph. Default `container`.
   */
  workloadLabel?: string;
  /**
   * Extra label matchers added to every container and rollout query, e.g.
   * `namespace="shop"`, so only your own workloads are scored and not the
   * cluster's system pods.
   */
  workloadMatchers?: string;
  fetchImpl?: typeof fetch;
}

interface PromSeries {
  metric: Record<string, string>;
  values?: [number, string][];
  value?: [number, string];
}

export class PrometheusAdapter implements Adapter {
  readonly name = "prometheus";
  readonly capabilities;
  private readonly base: string;
  private readonly prefix: string;
  private readonly histogram: string;
  private readonly sel: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: PrometheusOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.prefix = opts.graphPrefix ?? "traces_service_graph_request";
    this.histogram = opts.latencyHistogram ?? `${this.prefix}_server_seconds`;
    this.sel = opts.matchers ? `{${opts.matchers}}` : "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.capabilities = {
      serviceGraph: true,
      alerts: true,
      changes: opts.changes !== false,
      resources: opts.resources !== false,
    };
  }

  private async api(path: string, params: Record<string, string>): Promise<PromSeries[]> {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (this.opts.bearerToken) headers.authorization = `Bearer ${this.opts.bearerToken}`;
    const res = await this.fetchImpl(`${this.base}/api/v1/${path}`, {
      method: "POST",
      headers,
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => null)) as {
      status?: string;
      error?: string;
      data?: { result?: PromSeries[] };
    } | null;
    if (!res.ok || body?.status !== "success") {
      const why = body?.error ?? `HTTP ${res.status}`;
      throw new Error(`Prometheus ${path} failed: ${why} (query: ${params.query})`);
    }
    return body.data?.result ?? [];
  }

  private rangeQuery(query: string, range: TimeRange): Promise<PromSeries[]> {
    return this.api("query_range", {
      query,
      start: String(range.start),
      end: String(range.end),
      step: String(range.step),
    });
  }

  /** Place a series' samples onto the range's step grid. */
  private align(series: PromSeries, range: TimeRange): Samples {
    const out: Samples = new Array(stepsIn(range)).fill(null);
    for (const [ts, raw] of series.values ?? []) {
      const i = Math.round((ts - range.start) / range.step);
      const v = Number(raw);
      if (i >= 0 && i < out.length && Number.isFinite(v)) out[i] = v;
    }
    return out;
  }

  async serviceGraph(range: TimeRange): Promise<Sourced<ServiceGraphSeries>> {
    // The rate window must span at least a few scrapes, whatever the step.
    const w = `${Math.max(2 * range.step, 60)}s`;
    const qTotal = `sum by (client, server) (rate(${this.prefix}_total${this.sel}[${w}]))`;
    const qFailed = `sum by (client, server) (rate(${this.prefix}_failed_total${this.sel}[${w}]))`;
    // An edge to or from something that sends no spans of its own (an outside
    // API, a database, the "user" in front of the entry point) is marked
    // connection_type="virtual_node", and the side that sent nothing is timed
    // as zero. So: the server's own timing where the server is real, and the
    // caller's timing where only the caller is.
    const m = this.opts.matchers ? `,${this.opts.matchers}` : "";
    const real = (h: string) =>
      `rate(${h}_bucket{connection_type=""${m}}[${w}]) or rate(${h}_bucket{client="user"${m}}[${w}])`;
    const qP95 = `histogram_quantile(0.95, sum by (server, le) (${real(this.histogram)}))`;
    const qP95Client = `histogram_quantile(0.95, sum by (server, le) (rate(${this.prefix}_client_seconds_bucket{connection_type="virtual_node",client!="user"${m}}[${w}])))`;
    const queries: SourceQuery[] = [
      { purpose: "Request rate per edge", language: "PromQL", query: qTotal },
      { purpose: "Failed request rate per edge", language: "PromQL", query: qFailed },
      { purpose: "Server-side p95 latency per service", language: "PromQL", query: qP95 },
      { purpose: "p95 latency of calls to services that send no spans, as their callers saw it", language: "PromQL", query: qP95Client },
    ];
    const [total, failed, p95, p95Client] = await Promise.all([
      this.rangeQuery(qTotal, range),
      this.rangeQuery(qFailed, range),
      this.rangeQuery(qP95, range),
      this.rangeQuery(qP95Client, range),
    ]);

    const n = stepsIn(range);
    const key = (m: Record<string, string>) => `${m.client}\u0000${m.server}`;
    const failedBy = new Map(failed.map((s) => [key(s.metric), this.align(s, range)]));

    const ids = new Set<string>();
    const edges = total
      .filter((s) => s.metric.client && s.metric.server)
      .map((s) => {
        const rate = this.align(s, range);
        const fail = failedBy.get(key(s.metric));
        ids.add(s.metric.client!);
        ids.add(s.metric.server!);
        return { from: s.metric.client!, to: s.metric.server!, rate, fail };
      });

    const edgeSeries = edges.map((e) => ({
      from: e.from,
      to: e.to,
      rate: e.rate,
      errorRatio: e.rate.map((r, i) => ratio(e.fail?.[i] ?? (r === null ? null : 0), r)),
    }));

    const p95By = new Map(p95Client.map((s) => [s.metric.server, this.align(s, range)]));
    for (const s of p95) p95By.set(s.metric.server, this.align(s, range));
    const services: ServiceRef[] = [...ids].sort().map((id) => ({ id }));
    const serviceSeries = services.map(({ id }) => {
      // A service's own signals are what its callers saw: the sum of inbound
      // edges. A pure caller (nothing calls it) has no inbound view.
      const inbound = edges.filter((e) => e.to === id);
      const rate: Samples = new Array(n).fill(null);
      const fail: Samples = new Array(n).fill(null);
      for (const e of inbound) {
        for (let i = 0; i < n; i++) {
          const r = e.rate[i];
          if (r === null || r === undefined) continue;
          rate[i] = (rate[i] ?? 0) + r;
          fail[i] = (fail[i] ?? 0) + (e.fail?.[i] ?? 0);
        }
      }
      return {
        service: id,
        rate,
        errorRatio: rate.map((r, i) => ratio(fail[i] ?? null, r)),
        latencyP95: p95By.get(id) ?? new Array(n).fill(null),
      };
    });

    return { data: { range, services, serviceSeries, edgeSeries }, queries };
  }

  async alerts(range: TimeRange): Promise<Sourced<AlertEvent[]>> {
    const query = `ALERTS{alertstate="firing"}`;
    const result = await this.rangeQuery(query, range);
    const events: AlertEvent[] = [];
    for (const s of result) {
      const present = this.align(s, range).map((v) => v !== null);
      // Each unbroken run of samples is one firing period.
      for (let i = 0; i < present.length; i++) {
        if (!present[i] || present[i - 1]) continue;
        let j = i;
        while (present[j + 1]) j++;
        events.push({
          name: s.metric.alertname ?? "alert",
          severity: s.metric.severity,
          service: s.metric.service ?? s.metric.service_name ?? s.metric.server ?? s.metric.job,
          startsAt: range.start + i * range.step,
          endsAt: j === present.length - 1 ? undefined : range.start + (j + 1) * range.step,
        });
      }
    }
    events.sort((a, b) => a.startsAt - b.startsAt);
    return {
      data: events,
      queries: [{ purpose: "Alerts firing in the range", language: "PromQL", query }],
    };
  }

  async resources(range: TimeRange): Promise<Sourced<ResourceSeries[]>> {
    if (!this.capabilities.resources) return { data: [], queries: [] };
    const l = this.opts.workloadLabel ?? "container";
    const w = `${Math.max(2 * range.step, 60)}s`;
    // cAdvisor reports a pod-level series with an empty container label and a
    // "POD" pause container; both would double-count.
    const m = this.opts.workloadMatchers ? `,${this.opts.workloadMatchers}` : "";
    const c = `{${l}!="",${l}!="POD"${m}}`;
    // kube-state-metrics series carry the same namespace and container labels.
    const k = this.opts.workloadMatchers ? `{${this.opts.workloadMatchers}}` : "";
    const specs: [keyof Omit<ResourceSeries, "service">, string, string][] = [
      ["cpuUsage", "CPU used (cores)", `sum by (${l}) (rate(container_cpu_usage_seconds_total${c}[${w}]))`],
      ["cpuRequest", "CPU requested (cores)", `sum by (${l}) (kube_pod_container_resource_requests{resource="cpu"${m}})`],
      [
        "cpuThrottled",
        "Share of CPU periods throttled",
        `sum by (${l}) (rate(container_cpu_cfs_throttled_periods_total${c}[${w}])) / sum by (${l}) (rate(container_cpu_cfs_periods_total${c}[${w}]))`,
      ],
      [
        "memUsage",
        "Memory in use (bytes)",
        // cAdvisor keeps reporting a container for minutes after its pod is
        // gone, while its limit disappears at once. Counting only pods that
        // still exist keeps usage and limit about the same set of pods, so a
        // rollout does not look like a memory spike.
        `sum by (${l}) (container_memory_working_set_bytes${c} and on (namespace, pod) kube_pod_info)`,
      ],
      ["memLimit", "Memory limit (bytes)", `sum by (${l}) (kube_pod_container_resource_limits{resource="memory"${m}})`],
      ["restarts", "Container restarts per step", `sum by (${l}) (increase(kube_pod_container_status_restarts_total${k}[${range.step}s]))`],
      ["replicas", "Running containers", `count by (${l}) (kube_pod_container_status_running${k} == 1)`],
    ];
    const results = await Promise.all(specs.map(([, , q]) => this.rangeQuery(q, range)));
    const n = stepsIn(range);
    const by = new Map<string, ResourceSeries>();
    const blank = (): Samples => new Array(n).fill(null);
    results.forEach((result, i) => {
      const field = specs[i]![0];
      for (const s of result) {
        const id = s.metric[l];
        if (!id) continue;
        if (!by.has(id)) {
          by.set(id, {
            service: id,
            cpuUsage: blank(),
            cpuRequest: blank(),
            cpuThrottled: blank(),
            memUsage: blank(),
            memLimit: blank(),
            restarts: blank(),
            replicas: blank(),
          });
        }
        by.get(id)![field] = this.align(s, range);
      }
    });
    return {
      data: [...by.values()].sort((a, b) => a.service.localeCompare(b.service)),
      queries: specs.map(([, purpose, query]) => ({ purpose, language: "PromQL", query })),
    };
  }

  async changes(range: TimeRange): Promise<Sourced<ChangeEvent[]>> {
    if (!this.capabilities.changes) return { data: [], queries: [] };
    // A new ReplicaSet means a new pod template was rolled out. A rollback
    // reuses an old ReplicaSet, so this view does not see rollbacks.
    const rs = `kube_replicaset_created${this.opts.workloadMatchers ? `{${this.opts.workloadMatchers}}` : ""}`;
    const query = `${rs} > ${range.start} and ${rs} <= ${range.end}`;
    const result = await this.api("query", { query, time: String(range.end) });
    const events: ChangeEvent[] = result.flatMap((s) => {
      const at = Number(s.value?.[1]);
      const rs = s.metric.replicaset;
      if (!Number.isFinite(at) || !rs) return [];
      const deployment = rs.replace(/-[a-z0-9]{5,10}$/, "");
      const ns = s.metric.namespace ? `${s.metric.namespace}/` : "";
      return [
        {
          at,
          service: deployment,
          kind: "deploy" as const,
          description: `new ReplicaSet ${ns}${rs}`,
        },
      ];
    });
    events.sort((a, b) => a.at - b.at);
    return {
      data: events,
      queries: [
        { purpose: "Rollouts (new ReplicaSets) in the range", language: "PromQL", query },
      ],
    };
  }
}

function ratio(part: number | null, whole: number | null | undefined): number | null {
  if (whole === null || whole === undefined || part === null) return null;
  if (whole === 0) return 0;
  return Math.min(1, part / whole);
}
