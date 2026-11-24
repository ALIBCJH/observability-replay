import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { DemoAdapter } from "../src/adapters/demo.js";
import { liveServer } from "../src/live.js";

async function withServer(refreshSeconds: number, run: (base: string) => Promise<void>) {
  const server = liveServer(new DemoAdapter(Date.now() / 1000 - 1800), {
    port: 0,
    minutes: 15,
    refreshSeconds,
    viewDir: new URL("../dist/", import.meta.url),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test("live pages carry the backend's data and the applications page re-reads it", async () => {
  await withServer(5, async (base) => {
    const page = await (await fetch(`${base}/apps-preview.html`)).text();
    assert.match(page, /"kind":"scorecards"/);
    assert.match(page, /window\.__LIVE__=\{"url":"apps\.json","seconds":5\}/);

    const data = (await (await fetch(`${base}/apps.json`)).json()) as { kind: string; apps: unknown[] };
    assert.equal(data.kind, "scorecards");
    assert.ok(data.apps.length > 0);

    assert.match(await (await fetch(`${base}/preview.html`)).text(), /window\.__REPLAY__ = \{/);
    assert.match(await (await fetch(`${base}/benchmark-preview.html`)).text(), /"kind":"benchmark-report"/);

    const root = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/apps-preview.html");
  });
});

test("live pages are read-only and serve nothing else", async () => {
  await withServer(0, async (base) => {
    assert.equal((await fetch(`${base}/apps.json`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
    assert.doesNotMatch(await (await fetch(`${base}/apps-preview.html`)).text(), /__LIVE__=/);
  });
});

test("the performance page serves any of the six periods and refuses anything else", async () => {
  await withServer(5, async (base) => {
    const page = await (await fetch(`${base}/performance-preview.html?range=6h`)).text();
    assert.match(page, /"kind":"performance"/);
    assert.match(page, /"rangeKey":"6h"/);
    assert.match(page, /window\.__LIVE__=\{"url":"performance\.json","seconds":5\}/);

    const day = (await (await fetch(`${base}/performance.json?range=24h`)).json()) as { rangeKey: string; services: unknown[] };
    assert.equal(day.rangeKey, "24h");
    assert.ok(day.services.length > 0);
    // With no range, the last hour.
    assert.equal(((await (await fetch(`${base}/performance.json`)).json()) as { rangeKey: string }).rangeKey, "1h");

    const bad = await fetch(`${base}/performance.json?range=${encodeURIComponent("1h<script>")}`);
    assert.equal(bad.status, 400);
    assert.doesNotMatch(await bad.text(), /<script>.*<script>/);
  });
});

test("the backend is read once for readers who ask for the same period together", async () => {
  let reads = 0;
  const demo = new DemoAdapter(Date.now() / 1000 - 1800);
  const counting = new Proxy(demo, {
    get(target, prop, receiver) {
      if (prop === "latency") reads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const server = liveServer(counting, { port: 0, minutes: 15, refreshSeconds: 5, viewDir: new URL("../dist/", import.meta.url) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await Promise.all([1, 2, 3].map(() => fetch(`${base}/performance.json?range=1h`).then((r) => r.text())));
    assert.equal(reads, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
