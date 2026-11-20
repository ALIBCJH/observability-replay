#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { adapterFromEnv, type Adapter } from "./adapters/index.js";
import {
  MAX_WINDOW_MINUTES,
  MIN_WINDOW_MINUTES,
  buildReplay,
  clock,
  formatValue,
  resolveRange,
  summarize,
} from "./replay.js";
import { runBenchmark, summarizeBenchmark } from "./benchmark.js";
import {
  SCORECARD_MAX_FRAMES,
  buildScorecards,
  sloFromEnv,
  summarizeScorecards,
  type Slo,
} from "./scorecard.js";

const VIEW_URI = "ui://observability/replay.html";
const VIEW_FILE = fileURLToPath(new URL("./replay.html", import.meta.url));
const APPS_URI = "ui://observability/apps.html";
const APPS_FILE = fileURLToPath(new URL("./apps.html", import.meta.url));
const BENCH_URI = "ui://observability/benchmark.html";
const BENCH_FILE = fileURLToPath(new URL("./benchmark.html", import.meta.url));

const windowShape = {
  minutes: z
    .number()
    .min(MIN_WINDOW_MINUTES)
    .max(MAX_WINDOW_MINUTES)
    .default(30)
    .describe(`Length of the window in minutes (${MIN_WINDOW_MINUTES} to ${MAX_WINDOW_MINUTES}).`),
  end: z
    .string()
    .optional()
    .describe("End of the window as an ISO 8601 time. Defaults to now."),
};

function parseEnd(end?: string): number | undefined {
  if (!end) return undefined;
  const ms = Date.parse(end);
  if (Number.isNaN(ms)) throw new Error(`"end" is not a valid ISO 8601 time: ${end}`);
  return ms / 1000;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function last(samples: (number | null)[]): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const v = samples[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

export function createServer(adapter: Adapter, slo: Slo = sloFromEnv()): McpServer {
  const server = new McpServer({ name: "observability-replay", version: "0.1.0" });

  server.registerTool(
    "describe_backend",
    {
      title: "Describe backend",
      description:
        "Which observability backend is connected and what it can supply (service graph, alerts, changes).",
      annotations: { readOnlyHint: true },
    },
    async () =>
      text(
        `Backend: ${adapter.name}\n` +
          Object.entries(adapter.capabilities)
            .map(([k, v]) => `- ${k}: ${v ? "yes" : "no"}`)
            .join("\n"),
      ),
  );

  server.registerTool(
    "get_service_graph",
    {
      title: "Service graph",
      description:
        "Services, the calls between them, and each service's latest request rate, error ratio and p95 latency. Text only; use incident_replay to see it move over time.",
      inputSchema: windowShape,
      annotations: { readOnlyHint: true },
    },
    async ({ minutes, end }) => {
      const range = resolveRange(minutes, parseEnd(end));
      const { data, queries } = await adapter.serviceGraph(range);
      const fmt = (sig: "latency_p95" | "error_ratio" | "rate_drop", v: number | null) =>
        v === null ? "no data" : formatValue(sig, v);
      const lines = [`Service graph at ${clock(range.end)} UTC (backend "${adapter.name}"):`, ""];
      for (const s of data.serviceSeries) {
        const ref = data.services.find((x) => x.id === s.service);
        const where = ref?.cloud ? ` [${ref.cloud}${ref.cluster ? `/${ref.cluster}` : ""}]` : "";
        lines.push(
          `- ${s.service}${where}: ${fmt("rate_drop", last(s.rate))}, ` +
            `errors ${fmt("error_ratio", last(s.errorRatio))}, p95 ${fmt("latency_p95", last(s.latencyP95))}`,
        );
      }
      lines.push("", "Calls:");
      for (const e of data.edgeSeries) {
        lines.push(
          `- ${e.from} -> ${e.to}: ${fmt("rate_drop", last(e.rate))}, errors ${fmt("error_ratio", last(e.errorRatio))}`,
        );
      }
      lines.push("", "Queries run:", ...queries.map((q) => `- ${q.purpose}: ${q.query}`));
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "list_alerts",
    {
      title: "Alerts",
      description: "Alerts that fired in the window, across every cluster the backend sees.",
      inputSchema: windowShape,
      annotations: { readOnlyHint: true },
    },
    async ({ minutes, end }) => {
      if (!adapter.capabilities.alerts) return text(`Backend "${adapter.name}" cannot report alerts.`);
      const range = resolveRange(minutes, parseEnd(end));
      const { data } = await adapter.alerts(range);
      if (data.length === 0) return text("No alerts fired in this window.");
      return text(
        data
          .map(
            (a) =>
              `- ${clock(a.startsAt)} ${a.name}${a.severity ? ` [${a.severity}]` : ""}` +
              `${a.service ? ` on ${a.service}` : ""}, ` +
              `${a.endsAt ? `until ${clock(a.endsAt)}` : "still firing"}` +
              `${a.summary ? `: ${a.summary}` : ""}`,
          )
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "recent_changes",
    {
      title: "Recent changes",
      description:
        "Deploys and rollbacks in the window. Most incidents follow a change, so check this early.",
      inputSchema: windowShape,
      annotations: { readOnlyHint: true },
    },
    async ({ minutes, end }) => {
      if (!adapter.capabilities.changes) return text(`Backend "${adapter.name}" cannot report changes.`);
      const range = resolveRange(minutes, parseEnd(end));
      const { data } = await adapter.changes(range);
      if (data.length === 0) return text("No changes recorded in this window.");
      return text(
        data
          .map((c) => `- ${clock(c.at)} ${c.kind}${c.service ? ` ${c.service}` : ""}: ${c.description}`)
          .join("\n"),
      );
    },
  );

  registerAppTool(
    server,
    "incident_replay",
    {
      title: "Incident replay",
      description:
        "Show an animated replay of the service map over a time window: traffic flowing between services, errors and latency spreading, with deploys and alerts marked on a scrubbable timeline. Returns a short text summary of what left baseline and in what order. Every number drawn comes from the backend.",
      inputSchema: {
        ...windowShape,
        focus: z
          .string()
          .optional()
          .describe("Service id to select when the replay opens, e.g. the one that looks like the origin."),
      },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: VIEW_URI } },
    },
    async ({ minutes, end, focus }) => {
      const range = resolveRange(minutes, parseEnd(end));
      const bundle = await buildReplay(adapter, range, focus);
      return {
        content: [{ type: "text" as const, text: summarize(bundle) }],
        structuredContent: bundle as unknown as Record<string, unknown>,
      };
    },
  );

  registerAppResource(
    server,
    "Incident replay view",
    VIEW_URI,
    { description: "Animated service-map replay." },
    async () => ({
      contents: [
        { uri: VIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(VIEW_FILE, "utf-8") },
      ],
    }),
  );

  registerAppTool(
    server,
    "application_scorecards",
    {
      title: "Application scorecards",
      description:
        "How each application is doing, worst first: request volume, p95 latency, error ratio against the error budget, CPU and memory used against what it requested, restarts, and whether its last deploy made it better or worse. Shows a fleet list with a detail page per application, and returns the findings as text. Pass `app` to open one application.",
      inputSchema: {
        minutes: z
          .number()
          .min(MIN_WINDOW_MINUTES)
          .max(MAX_WINDOW_MINUTES)
          .default(60)
          .describe(`Length of the window in minutes (${MIN_WINDOW_MINUTES} to ${MAX_WINDOW_MINUTES}).`),
        end: windowShape.end,
        app: z.string().optional().describe("Application id to open and to limit the text summary to."),
      },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: APPS_URI } },
    },
    async ({ minutes, end, app }) => {
      const range = resolveRange(minutes, parseEnd(end), undefined, SCORECARD_MAX_FRAMES);
      const bundle = await buildScorecards(adapter, range, slo, app);
      return {
        content: [{ type: "text" as const, text: summarizeScorecards(bundle, app) }],
        structuredContent: bundle as unknown as Record<string, unknown>,
      };
    },
  );

  registerAppTool(
    server,
    "benchmark",
    {
      title: "Benchmark",
      description:
        "Grade the system against the fixed benchmark standard: availability, latency, resource settings and headroom, restarts and deploy safety, per application, with an overall grade from A to F. The bars are the same for every system and cannot be changed, so results are comparable across clouds. Read-only: it scores what happened in the window. Shows the report page and returns the same findings as text.",
      inputSchema: {
        minutes: z
          .number()
          .min(MIN_WINDOW_MINUTES)
          .max(MAX_WINDOW_MINUTES)
          .default(60)
          .describe(`Length of the window in minutes (${MIN_WINDOW_MINUTES} to ${MAX_WINDOW_MINUTES}).`),
        end: windowShape.end,
      },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: BENCH_URI } },
    },
    async ({ minutes, end }) => {
      const range = resolveRange(minutes, parseEnd(end), undefined, SCORECARD_MAX_FRAMES);
      const result = await runBenchmark(adapter, range);
      return {
        content: [{ type: "text" as const, text: summarizeBenchmark(result) }],
        structuredContent: { kind: "benchmark-report", result } as unknown as Record<string, unknown>,
      };
    },
  );

  registerAppResource(
    server,
    "Benchmark report view",
    BENCH_URI,
    { description: "The grade, what to fix, and every application against every check." },
    async () => ({
      contents: [
        { uri: BENCH_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(BENCH_FILE, "utf-8") },
      ],
    }),
  );

  registerAppResource(
    server,
    "Application scorecards view",
    APPS_URI,
    { description: "Fleet list and per-application scorecard." },
    async () => ({
      contents: [
        { uri: APPS_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(APPS_FILE, "utf-8") },
      ],
    }),
  );

  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const adapter = adapterFromEnv();
  await createServer(adapter).connect(new StdioServerTransport());
  // stdout carries the protocol, so anything for a human goes to stderr.
  console.error(`observability-replay ready (backend: ${adapter.name})`);
}
