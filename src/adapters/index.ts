import { DEMO_SCENARIO_SECONDS, DemoAdapter } from "./demo.js";
import { PrometheusAdapter } from "./prometheus.js";
import type { Adapter } from "./types.js";

export type { Adapter } from "./types.js";

/**
 * Pick the backend from the environment.
 *
 *   OBS_BACKEND=demo        (default) scripted incident, no backend needed
 *   OBS_BACKEND=prometheus  needs OBS_PROM_URL
 */
export function adapterFromEnv(env: NodeJS.ProcessEnv = process.env): Adapter {
  const backend = (env.OBS_BACKEND ?? "demo").toLowerCase();
  if (backend === "demo") {
    // By default the scripted incident ends as the server starts, so "the
    // last 30 minutes" always shows the whole story.
    const now = Math.floor(Date.now() / 1000);
    const t0 = env.OBS_DEMO_T0 ? Number(env.OBS_DEMO_T0) : now - DEMO_SCENARIO_SECONDS;
    if (!Number.isFinite(t0)) throw new Error("OBS_DEMO_T0 must be a unix time in seconds");
    return new DemoAdapter(t0);
  }
  if (backend === "prometheus") {
    if (!env.OBS_PROM_URL) throw new Error("OBS_BACKEND=prometheus needs OBS_PROM_URL");
    return new PrometheusAdapter({
      url: env.OBS_PROM_URL,
      bearerToken: env.OBS_PROM_TOKEN,
      graphPrefix: env.OBS_PROM_GRAPH_PREFIX,
      latencyHistogram: env.OBS_PROM_LATENCY_HISTOGRAM,
      matchers: env.OBS_PROM_MATCHERS,
      changes: env.OBS_PROM_CHANGES !== "off",
      resources: env.OBS_PROM_RESOURCES !== "off",
      workloadLabel: env.OBS_PROM_WORKLOAD_LABEL,
      workloadMatchers: env.OBS_PROM_WORKLOAD_MATCHERS,
      endpoints: env.OBS_PROM_ENDPOINTS !== "off",
      httpHistogram: env.OBS_PROM_HTTP_HISTOGRAM,
      httpServiceLabel: env.OBS_PROM_HTTP_SERVICE_LABEL,
      httpRouteLabel: env.OBS_PROM_HTTP_ROUTE_LABEL,
      httpMethodLabel: env.OBS_PROM_HTTP_METHOD_LABEL,
      httpStatusLabel: env.OBS_PROM_HTTP_STATUS_LABEL,
      httpMatchers: env.OBS_PROM_HTTP_MATCHERS,
    });
  }
  throw new Error(`Unknown OBS_BACKEND "${backend}" (expected demo or prometheus)`);
}
