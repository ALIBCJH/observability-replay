import {
  stepsIn,
  tsAt,
  type AlertEvent,
  type ChangeEvent,
  type EdgeRef,
  type EndpointSeries,
  type LatencySeries,
  type ResourceSeries,
  type ServiceGraphSeries,
  type ServiceRef,
  type TimeRange,
  type Ts,
} from "../model.js";
import type { Adapter, Sourced } from "./types.js";

/**
 * A scripted incident, so the tool works with no backend at all.
 *
 * Story (minutes from the scenario start, T0):
 *   8   payments v2.4.1 is deployed
 *   8+  payments latency climbs, then checkout starts timing out
 *   11  errors reach the gateway; the payments queue drains
 *   19  payments is rolled back
 *   22  everything is back to baseline
 *
 * Values are a pure function of time, so every query over the same range
 * returns the same numbers.
 */

const SERVICES: ServiceRef[] = [
  { id: "web-gateway", cloud: "aws", cluster: "eks-prod", kind: "service" },
  { id: "checkout", cloud: "aws", cluster: "eks-prod", kind: "service" },
  { id: "cart", cloud: "aws", cluster: "eks-prod", kind: "service" },
  { id: "orders-db", cloud: "aws", cluster: "eks-prod", kind: "database" },
  { id: "payments", cloud: "gcp", cluster: "gke-prod", kind: "service" },
  { id: "payments-queue", cloud: "gcp", cluster: "gke-prod", kind: "queue" },
  { id: "inventory", cloud: "digitalocean", cluster: "doks-prod", kind: "service" },
  { id: "notifications", cloud: "alibaba", cluster: "ack-prod", kind: "service" },
];

/** Edge and the share of the caller's traffic it carries. */
const EDGES: (EdgeRef & { share: number })[] = [
  { from: "web-gateway", to: "checkout", share: 0.35 },
  { from: "web-gateway", to: "cart", share: 0.65 },
  { from: "checkout", to: "payments", share: 1 },
  { from: "checkout", to: "inventory", share: 1 },
  { from: "checkout", to: "orders-db", share: 1 },
  { from: "payments", to: "payments-queue", share: 1 },
  { from: "payments-queue", to: "notifications", share: 1 },
];

const BASE_LATENCY: Record<string, number> = {
  "web-gateway": 0.18,
  checkout: 0.14,
  cart: 0.04,
  "orders-db": 0.012,
  payments: 0.12,
  "payments-queue": 0.008,
  inventory: 0.05,
  notifications: 0.09,
};

const MIN = 60;
const DEPLOY_AT = 8 * MIN;
const ROLLBACK_AT = 19 * MIN;
const RECOVERED_AT = 22 * MIN;
export const DEMO_SCENARIO_SECONDS = 30 * MIN;

function smooth(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/** 0 at rest, 1 at full impact, for an effect that lags the deploy by `lag`. */
function impact(s: number, lag: number): number {
  const rise = smooth((s - DEPLOY_AT - lag) / (2 * MIN));
  const fall = smooth((s - ROLLBACK_AT - lag / 2) / (RECOVERED_AT - ROLLBACK_AT));
  return rise * (1 - fall);
}

/** Deterministic noise in [-1, 1] from a string key and a time. */
function noise(key: string, t: Ts): number {
  let h = 2166136261;
  const str = `${key}:${Math.floor(t / 15)}`;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

function jitter(key: string, t: Ts, amount: number): number {
  return 1 + noise(key, t) * amount;
}

interface Point {
  rate: number;
  errorRatio: number;
  latencyP95: number;
}

/** Inbound signals of one service at scenario time `s` (wall time `t`). */
function servicePoint(id: string, s: number, t: Ts): Point {
  const gatewayRate = 240 * jitter("gw-rate", t, 0.04);
  const pay = impact(s, 0);
  const chk = impact(s, 75);
  const gw = impact(s, 150);
  const base = BASE_LATENCY[id]!;
  const lat = (extra: number) => (base + extra) * jitter(`${id}-lat`, t, 0.06);
  const checkoutRate = gatewayRate * 0.35;
  // Checkout calls that fail never reach the downstream services.
  const checkoutOk = 1 - 0.36 * chk;

  switch (id) {
    case "web-gateway":
      return { rate: gatewayRate, errorRatio: 0.0002 + 0.125 * gw, latencyP95: lat(1.4 * gw) };
    case "checkout":
      return { rate: checkoutRate, errorRatio: 0.0003 + 0.36 * chk, latencyP95: lat(2.6 * chk) };
    case "cart":
      return { rate: gatewayRate * 0.65, errorRatio: 0.0001, latencyP95: lat(0) };
    case "payments":
      return { rate: checkoutRate, errorRatio: 0.0004 + 0.22 * pay, latencyP95: lat(1.9 * pay) };
    case "inventory":
      return { rate: checkoutRate * checkoutOk, errorRatio: 0.0002, latencyP95: lat(0) };
    case "orders-db":
      return { rate: checkoutRate * checkoutOk, errorRatio: 0.00005, latencyP95: lat(0) };
    case "payments-queue":
      return { rate: checkoutRate * (1 - 0.6 * pay), errorRatio: 0.00005, latencyP95: lat(0) };
    case "notifications":
      return { rate: checkoutRate * (1 - 0.6 * chk), errorRatio: 0.0001, latencyP95: lat(0) };
    default:
      return { rate: 0, errorRatio: 0, latencyP95: 0 };
  }
}

const MI = 1024 * 1024;
/** Inventory leaks memory until it is restarted, on a cycle of this length. */
const LEAK_CYCLE = 18 * MIN;

interface ResourcePoint {
  cpuUsage: number;
  cpuRequest: number;
  cpuThrottled: number;
  memUsage: number;
  memLimit: number;
  replicas: number;
}

/**
 * Resource use of one workload. Three stories are scripted alongside the
 * incident: payments runs into its CPU limit while it is failing, cart is
 * heavily over-provisioned, and inventory leaks memory until it restarts.
 */
function resourcePoint(id: string, s: number, t: Ts): ResourcePoint {
  const pay = impact(s, 0);
  const chk = impact(s, 75);
  const j = (amount: number) => jitter(`${id}-res`, t, amount);
  const p = (cpu: number, req: number, mem: number, limit: number, replicas: number, thr = 0) => ({
    cpuUsage: cpu * j(0.05),
    cpuRequest: req,
    cpuThrottled: Math.max(0, thr),
    memUsage: mem * MI * j(0.01),
    memLimit: limit * MI,
    replicas,
  });
  switch (id) {
    case "web-gateway":
      return p(0.9, 2, 600, 1024, 4);
    case "checkout":
      return p(0.8 + 0.5 * chk, 1.5, 700 + 60 * chk, 1024, 3);
    case "cart":
      return p(0.45, 4, 300, 2048, 4);
    case "orders-db":
      return p(0.7, 2, 3100, 4096, 1);
    case "payments":
      return p(0.55 + 0.63 * pay, 1, 500 + 280 * pay, 1024, 3, 0.01 + 0.44 * pay);
    case "payments-queue":
      return p(0.1, 0.5, 180, 512, 1);
    case "inventory": {
      const phase = (((s % LEAK_CYCLE) + LEAK_CYCLE) % LEAK_CYCLE) / LEAK_CYCLE;
      return p(0.3, 0.5, 290 + 210 * phase, 512, 2);
    }
    case "notifications":
      return p(0.2, 0.5, 220, 512, 2);
    default:
      return p(0, 0, 0, 0, 0);
  }
}

/**
 * Scripted routes per service: the share of the service's requests each one
 * takes, how its p95 compares with the service's, the share of the service's
 * failures it carries, and a steady share of client errors (4xx).
 */
const ENDPOINTS: Record<string, { endpoint: string; share: number; slow: number; fails: number; clientErr: number }[]> = {
  "web-gateway": [
    { endpoint: "GET /", share: 0.4, slow: 0.5, fails: 0, clientErr: 0.002 },
    { endpoint: "GET /cart", share: 0.25, slow: 0.6, fails: 0, clientErr: 0.004 },
    { endpoint: "POST /checkout", share: 0.35, slow: 1, fails: 1, clientErr: 0.011 },
  ],
  checkout: [
    { endpoint: "POST /checkout", share: 0.7, slow: 1, fails: 0.9, clientErr: 0.012 },
    { endpoint: "GET /checkout/{id}", share: 0.3, slow: 0.4, fails: 0.1, clientErr: 0.03 },
  ],
  cart: [
    { endpoint: "GET /cart/{id}", share: 0.6, slow: 0.8, fails: 0.5, clientErr: 0.021 },
    { endpoint: "POST /cart/{id}/items", share: 0.3, slow: 1, fails: 0.5, clientErr: 0.008 },
    { endpoint: "DELETE /cart/{id}/items/{item}", share: 0.1, slow: 0.9, fails: 0, clientErr: 0.005 },
  ],
  payments: [
    { endpoint: "POST /payments", share: 0.8, slow: 1, fails: 0.95, clientErr: 0.006 },
    { endpoint: "GET /payments/{id}", share: 0.2, slow: 0.3, fails: 0.05, clientErr: 0.015 },
  ],
  inventory: [
    { endpoint: "GET /stock/{sku}", share: 0.75, slow: 0.9, fails: 0.6, clientErr: 0.018 },
    { endpoint: "POST /stock/reserve", share: 0.25, slow: 1, fails: 0.4, clientErr: 0.004 },
  ],
  notifications: [{ endpoint: "POST /notify", share: 1, slow: 1, fails: 1, clientErr: 0.002 }],
};

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export class DemoAdapter implements Adapter {
  readonly name = "demo";
  readonly capabilities = {
    serviceGraph: true,
    alerts: true,
    changes: true,
    resources: true,
    latencyDetail: true,
    endpoints: true,
  };

  /** Wall-clock time at which the scripted incident begins. */
  constructor(private readonly t0: Ts) {}

  private note(purpose: string) {
    return [
      {
        purpose,
        language: "none",
        query: "Scripted demo data (src/adapters/demo.ts); no backend was queried.",
      },
    ];
  }

  async serviceGraph(range: TimeRange): Promise<Sourced<ServiceGraphSeries>> {
    const n = stepsIn(range);
    const serviceSeries = SERVICES.map((svc) => {
      const pts = Array.from({ length: n }, (_, i) => {
        const t = tsAt(range, i);
        return servicePoint(svc.id, t - this.t0, t);
      });
      return {
        service: svc.id,
        rate: pts.map((p) => round(p.rate, 2)),
        errorRatio: pts.map((p) => round(p.errorRatio, 5)),
        latencyP95: pts.map((p) => round(p.latencyP95, 4)),
      };
    });
    const byId = new Map(serviceSeries.map((s) => [s.service, s]));
    // An edge carries its target's inbound traffic and failures, scaled by the
    // share of the caller's traffic that goes down it.
    const edgeSeries = EDGES.map((e) => {
      const target = byId.get(e.to)!;
      const inboundShare =
        e.share / EDGES.filter((x) => x.to === e.to).reduce((a, x) => a + x.share, 0);
      return {
        from: e.from,
        to: e.to,
        rate: target.rate.map((r) => round((r ?? 0) * inboundShare, 2)),
        errorRatio: target.errorRatio,
      };
    });
    return {
      data: { range, services: SERVICES, serviceSeries, edgeSeries },
      queries: this.note("Service graph, request rate, error ratio and p95 latency"),
    };
  }

  async resources(range: TimeRange): Promise<Sourced<ResourceSeries[]>> {
    const n = stepsIn(range);
    const data = SERVICES.map((svc) => {
      const pts = Array.from({ length: n }, (_, i) => {
        const t = tsAt(range, i);
        return resourcePoint(svc.id, t - this.t0, t);
      });
      // Inventory restarts each time its leak cycle wraps round.
      const cycle = (i: number) => Math.floor((tsAt(range, i) - this.t0) / LEAK_CYCLE);
      return {
        service: svc.id,
        cpuUsage: pts.map((p) => round(p.cpuUsage, 3)),
        cpuRequest: pts.map((p) => p.cpuRequest),
        cpuThrottled: pts.map((p) => round(p.cpuThrottled, 3)),
        memUsage: pts.map((p) => Math.round(p.memUsage)),
        memLimit: pts.map((p) => p.memLimit),
        restarts: pts.map((_, i) =>
          svc.id === "inventory" && i > 0 && cycle(i) !== cycle(i - 1) ? 2 : 0,
        ),
        replicas: pts.map((p) => p.replicas),
      };
    });
    return { data, queries: this.note("CPU, memory, restarts and replicas per workload") };
  }

  async latency(range: TimeRange): Promise<Sourced<LatencySeries[]>> {
    const n = stepsIn(range);
    const data = SERVICES.map((svc) => {
      // The rest of the distribution keeps a fixed shape around the p95.
      const p95 = Array.from({ length: n }, (_, i) => {
        const t = tsAt(range, i);
        return servicePoint(svc.id, t - this.t0, t).latencyP95;
      });
      const scaled = (f: number) => p95.map((v) => round(v * f, 4));
      return { service: svc.id, mean: scaled(0.52), p50: scaled(0.44), p90: scaled(0.84), p99: scaled(1.55) };
    });
    return { data, queries: this.note("Mean, p50, p90 and p99 latency per service") };
  }

  async endpoints(range: TimeRange): Promise<Sourced<EndpointSeries[]>> {
    const n = stepsIn(range);
    const data: EndpointSeries[] = [];
    for (const [service, routes] of Object.entries(ENDPOINTS)) {
      const pts = Array.from({ length: n }, (_, i) => {
        const t = tsAt(range, i);
        return servicePoint(service, t - this.t0, t);
      });
      for (const r of routes) {
        data.push({
          service,
          endpoint: r.endpoint,
          rate: pts.map((p) => round(p.rate * r.share, 3)),
          rate4xx: pts.map((p) => round(p.rate * r.share * r.clientErr, 4)),
          // The route's part of the service's failed requests.
          rate5xx: pts.map((p) => round(p.rate * p.errorRatio * r.fails, 4)),
          latencyP95: pts.map((p) => round(p.latencyP95 * r.slow, 4)),
        });
      }
    }
    return { data, queries: this.note("Requests, 4xx, 5xx and p95 latency per route") };
  }

  async alerts(range: TimeRange): Promise<Sourced<AlertEvent[]>> {
    const all: AlertEvent[] = [
      {
        name: "PaymentsHighLatency",
        severity: "warning",
        service: "payments",
        startsAt: this.t0 + DEPLOY_AT + 150,
        endsAt: this.t0 + ROLLBACK_AT + 120,
        summary: "payments p95 latency above 1s for 1m",
      },
      {
        name: "CheckoutErrorBudgetBurn",
        severity: "critical",
        service: "checkout",
        startsAt: this.t0 + DEPLOY_AT + 225,
        endsAt: this.t0 + ROLLBACK_AT + 165,
        summary: "checkout error ratio above 10% for 1m",
      },
    ];
    return {
      data: all.filter((a) => a.startsAt <= range.end && (a.endsAt ?? Infinity) >= range.start),
      queries: this.note("Alerts firing in the range"),
    };
  }

  async changes(range: TimeRange): Promise<Sourced<ChangeEvent[]>> {
    const all: ChangeEvent[] = [
      {
        at: this.t0 + DEPLOY_AT,
        service: "payments",
        kind: "deploy",
        description: "payments v2.4.0 -> v2.4.1",
      },
      {
        at: this.t0 + ROLLBACK_AT,
        service: "payments",
        kind: "rollback",
        description: "payments v2.4.1 -> v2.4.0",
      },
    ];
    return {
      data: all.filter((c) => c.at >= range.start && c.at <= range.end),
      queries: this.note("Deploys and rollbacks in the range"),
    };
  }
}
