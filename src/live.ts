import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { adapterFromEnv } from "./adapters/index.js";
import type { Adapter } from "./adapters/types.js";
import { runBenchmark } from "./benchmark.js";
import { isMain } from "./main.js";
import { buildPerformance, isRangeKey, performanceRange, type PerformanceBundle, type RangeKey } from "./performance.js";
import { buildReplay, resolveRange } from "./replay.js";
import { buildScorecards, SCORECARD_MAX_FRAMES, sloFromEnv } from "./scorecard.js";

/**
 * The three pages on the connected backend's own data, served on this machine
 * only. Each page load reads the backend again, and the applications page
 * re-reads on a timer, so it can be left open while something happens.
 * Read-only, like the MCP tools.
 */
export interface LiveOptions {
  port: number;
  /** Window each page covers. */
  minutes: number;
  /** Seconds between re-reads of the applications page; 0 turns it off. */
  refreshSeconds: number;
  /** Where the built pages are; defaults to this file's own directory (dist). */
  viewDir?: URL;
}

class BadRequest extends Error {}

const inline = (html: string, data: unknown, extra = "") =>
  html
    .replace("/*DATA*/null", () => JSON.stringify(data).replace(/</g, "\\u003c"))
    .replace("</head>", () => `${extra}</head>`);

export function liveServer(adapter: Adapter, opts: LiveOptions): Server {
  const page = (name: string) => readFile(fileURLToPath(new URL(`./${name}.html`, opts.viewDir ?? import.meta.url)), "utf-8");
  const cards = () =>
    buildScorecards(adapter, resolveRange(opts.minutes, undefined, undefined, SCORECARD_MAX_FRAMES), sloFromEnv());

  // One read per period is shared by everyone who asks within a step of it,
  // so an open page, or several, cannot make the backend run the same queries
  // over and over. A failed read is not kept.
  const held = new Map<RangeKey, { until: number; bundle: Promise<PerformanceBundle> }>();
  const performance = (key: RangeKey) => {
    const hit = held.get(key);
    if (hit && hit.until > Date.now()) return hit.bundle;
    const seconds = Math.min(300, Math.max(opts.refreshSeconds || 10, performanceRange(key).step / 2));
    const bundle = buildPerformance(adapter, key);
    held.set(key, { until: Date.now() + seconds * 1000, bundle });
    bundle.catch(() => held.delete(key));
    return bundle;
  };
  const rangeOf = (query: URLSearchParams): RangeKey => {
    const asked = query.get("range") ?? "1h";
    if (!isRangeKey(asked)) throw new BadRequest(`unknown range "${asked.slice(0, 20)}"`);
    return asked;
  };

  const routes: Record<string, (query: URLSearchParams) => Promise<{ type: string; body: string }>> = {
    "/performance-preview.html": async (query) => ({
      type: "text/html",
      body: inline(
        await page("performance"),
        await performance(rangeOf(query)),
        `<script>window.__LIVE__=${JSON.stringify({ url: "performance.json", seconds: opts.refreshSeconds })};</script>`,
      ),
    }),
    "/performance.json": async (query) => ({
      type: "application/json",
      body: JSON.stringify(await performance(rangeOf(query))),
    }),
    "/apps-preview.html": async () => ({
      type: "text/html",
      body: inline(
        await page("apps"),
        await cards(),
        opts.refreshSeconds > 0
          ? `<script>window.__LIVE__=${JSON.stringify({ url: "apps.json", seconds: opts.refreshSeconds })};</script>`
          : "",
      ),
    }),
    "/apps.json": async () => ({ type: "application/json", body: JSON.stringify(await cards()) }),
    "/preview.html": async () => ({
      type: "text/html",
      body: inline(await page("replay"), await buildReplay(adapter, resolveRange(opts.minutes))),
    }),
    "/benchmark-preview.html": async () => ({
      type: "text/html",
      body: inline(await page("benchmark"), {
        kind: "benchmark-report",
        result: await runBenchmark(adapter, resolveRange(opts.minutes, undefined, undefined, SCORECARD_MAX_FRAMES)),
      }),
    }),
  };

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    if (path === "/") {
      res.writeHead(302, { location: "/apps-preview.html" }).end();
      return;
    }
    const route = routes[path];
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    route(url.searchParams).then(
      ({ type, body }) => res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" }).end(body),
      (e: Error) =>
        e instanceof BadRequest
          ? res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(e.message)
          : res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end(`backend error: ${e.message}`),
    );
  });
}

export function main() {
  const arg = (name: string, fallback: number) => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i > 0 ? Number(process.argv[i + 1]) : NaN;
    return Number.isFinite(v) ? v : fallback;
  };
  const opts: LiveOptions = { port: arg("port", 8766), minutes: arg("minutes", 30), refreshSeconds: arg("refresh", 10) };
  const adapter = adapterFromEnv();
  // Loopback only: the pages show backend data and have no sign-in.
  liveServer(adapter, opts).listen(opts.port, "127.0.0.1", () => {
    console.error(`live pages: http://127.0.0.1:${opts.port}/  (last ${opts.minutes} min, re-read every ${opts.refreshSeconds} s)`);
  });
}

if (isMain(import.meta.url, "live")) main();
