import type {
  AlertEvent,
  ChangeEvent,
  EndpointSeries,
  LatencySeries,
  ResourceSeries,
  ServiceGraphSeries,
  SourceQuery,
  TimeRange,
} from "../model.js";

/** What a backend can supply. The tools and the view degrade on a `false`. */
export interface Capabilities {
  serviceGraph: boolean;
  alerts: boolean;
  changes: boolean;
  /** CPU, memory, restarts and replicas per workload. */
  resources: boolean;
  /** Mean, p50, p90 and p99 latency per service. */
  latencyDetail: boolean;
  /** Per-route request, 4xx, 5xx and latency series. */
  endpoints: boolean;
}

export interface Sourced<T> {
  data: T;
  /** The native queries that produced `data`. */
  queries: SourceQuery[];
}

/**
 * One implementation per observability backend. Callers state intent (a time
 * range); the adapter writes the native queries.
 */
export interface Adapter {
  readonly name: string;
  readonly capabilities: Capabilities;
  serviceGraph(range: TimeRange): Promise<Sourced<ServiceGraphSeries>>;
  alerts(range: TimeRange): Promise<Sourced<AlertEvent[]>>;
  changes(range: TimeRange): Promise<Sourced<ChangeEvent[]>>;
  resources(range: TimeRange): Promise<Sourced<ResourceSeries[]>>;
  latency(range: TimeRange): Promise<Sourced<LatencySeries[]>>;
  endpoints(range: TimeRange): Promise<Sourced<EndpointSeries[]>>;
}
