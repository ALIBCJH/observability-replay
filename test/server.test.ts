import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/** Drives the built server over stdio, the way a real host would. */
const serverPath = fileURLToPath(new URL("../dist/server.js", import.meta.url));
let client: Client;

before(async () => {
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: { ...process.env, OBS_BACKEND: "demo" } as Record<string, string>,
      stderr: "ignore",
    }),
  );
});
after(() => client.close());

const textOf = (result: unknown) =>
  ((result as { content: { type: string; text?: string }[] }).content ?? [])
    .map((c) => c.text ?? "")
    .join("\n");

test("lists eight read-only tools, with each view tool linked to its page", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "application_scorecards",
      "benchmark",
      "describe_backend",
      "get_service_graph",
      "incident_replay",
      "list_alerts",
      "performance_analytics",
      "recent_changes",
    ],
  );
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  const replay = tools.find((t) => t.name === "incident_replay")!;
  const ui = (replay._meta as { ui?: { resourceUri?: string } }).ui;
  assert.equal(ui?.resourceUri, "ui://observability/replay.html");
  const cards = tools.find((t) => t.name === "application_scorecards")!;
  assert.equal(
    (cards._meta as { ui?: { resourceUri?: string } }).ui?.resourceUri,
    "ui://observability/apps.html",
  );
});

test("application_scorecards returns findings as text and cards for the view", async () => {
  const result = await client.callTool({ name: "application_scorecards", arguments: { minutes: 60 } });
  assert.notEqual(result.isError, true);
  const text = textOf(result);
  assert.match(text, /payments \[gcp\]: NEEDS ATTENTION/);
  assert.match(text, /cart \[aws\]: healthy/);
  const bundle = result.structuredContent as { kind: string; apps: { id: string }[] };
  assert.equal(bundle.kind, "scorecards");
  assert.equal(bundle.apps.length, 8);

  const one = await client.callTool({
    name: "application_scorecards",
    arguments: { minutes: 60, app: "inventory" },
  });
  assert.match(textOf(one), /inventory/);
  assert.doesNotMatch(textOf(one), /payments \[gcp\]/);
  assert.equal((one.structuredContent as { focus?: string }).focus, "inventory");

  const { contents } = await client.readResource({ uri: "ui://observability/apps.html" });
  assert.match((contents[0] as { text?: string }).text ?? "", /id="rows"/);
});

test("incident_replay returns a summary for the model and a bundle for the view", async () => {
  const result = await client.callTool({
    name: "incident_replay",
    arguments: { minutes: 30, focus: "payments" },
  });
  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /payments: p95 latency rose/);
  const bundle = result.structuredContent as { version: number; services: unknown[]; focus: string };
  assert.equal(bundle.version, 1);
  assert.equal(bundle.services.length, 8);
  assert.equal(bundle.focus, "payments");
});

test("the view resource is served as an MCP App page", async () => {
  const { contents } = await client.readResource({ uri: "ui://observability/replay.html" });
  const page = contents[0] as { mimeType?: string; text?: string };
  assert.equal(page.mimeType, "text/html;profile=mcp-app");
  assert.match(page.text ?? "", /<canvas id="map">/);
  // Self-contained: the sandbox cannot load anything else.
  assert.doesNotMatch(page.text ?? "", /<script[^>]+src=|<link[^>]+href=/);
});

test("the text tools answer", async () => {
  assert.match(textOf(await client.callTool({ name: "describe_backend", arguments: {} })), /Backend: demo/);
  assert.match(
    textOf(await client.callTool({ name: "get_service_graph", arguments: { minutes: 30 } })),
    /checkout -> payments/,
  );
  assert.match(
    textOf(await client.callTool({ name: "list_alerts", arguments: { minutes: 30 } })),
    /CheckoutErrorBudgetBurn/,
  );
  assert.match(
    textOf(await client.callTool({ name: "recent_changes", arguments: { minutes: 30 } })),
    /rollback payments/,
  );
});

test("a window beyond the limit is refused", async () => {
  const outcome = await client
    .callTool({ name: "incident_replay", arguments: { minutes: 100_000 } })
    .then((r) => (r.isError ? "error" : "ok"))
    .catch(() => "error");
  assert.equal(outcome, "error");
});

test("a bad end time is refused with a clear message", async () => {
  const result = await client
    .callTool({ name: "list_alerts", arguments: { minutes: 30, end: "yesterday-ish" } })
    .catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
  assert.equal(result.isError, true);
  assert.match(textOf(result), /not a valid ISO 8601 time/);
});

test("performance_analytics returns the period against the one before, as text and for the view", async () => {
  const result = await client.callTool({ name: "performance_analytics", arguments: { range: "1h", service: "payments" } });
  assert.notEqual(result.isError, true);
  const text = textOf(result);
  assert.match(text, /SIMULATED demo data/);
  assert.match(text, /- payments \[gcp\]: [\d,]+ requests/);
  assert.match(text, /payments POST \/payments/);
  assert.doesNotMatch(text, /- cart/);
  const bundle = result.structuredContent as { kind: string; rangeKey: string; focus?: string };
  assert.equal(bundle.kind, "performance");
  assert.equal(bundle.rangeKey, "1h");
  assert.equal(bundle.focus, "payments");

  const bad = await client.callTool({ name: "performance_analytics", arguments: { range: "90d" } });
  assert.equal(bad.isError, true);
});
