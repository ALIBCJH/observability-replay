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
