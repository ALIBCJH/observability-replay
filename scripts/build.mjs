// Builds dist/server.js and dist/lib.js, the two single-file views
// (dist/replay.html, dist/apps.html), the benchmark report (dist/benchmark.html),
// and a preview of each with the demo incident inlined (dist/preview.html,
// dist/apps-preview.html, dist/benchmark-preview.html).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const p = (rel) => fileURLToPath(new URL(rel, root));

await mkdir(p("dist"), { recursive: true });

// Keep dependency licenses with the standalone HTML when it is shared.
const thirdPartyNotices = await readFile(p("THIRD_PARTY_NOTICES.txt"), "utf-8");

// Server and library: our code only, dependencies stay in node_modules.
await build({
  entryPoints: [p("src/server.ts"), p("src/lib.ts"), p("src/bench.ts"), p("src/live.ts")],
  outdir: p("dist"),
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node20",
});

// A view is one self-contained HTML file, because a host loads it in a
// sandboxed iframe that cannot fetch anything else.
async function buildView(name, cssFiles) {
  const js = await build({
    entryPoints: [p(`view/${name}.ts`)],
    bundle: true,
    minify: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    write: false,
  });
  const script = js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const css = (await Promise.all(cssFiles.map((f) => readFile(p(`view/${f}`), "utf-8")))).join("\n");
  const template = await readFile(p(`view/${name}.html`), "utf-8");
  // Function replacers, so `$` sequences in the code are not treated specially.
  const notices = thirdPartyNotices.replace(/<\/script/gi, "<\\/script");
  const html = template.replace("/*CSS*/", () => css).replace("/*JS*/", () => script)
    .replace("</body>", () => `<script type="text/plain" id="third-party-notices">${notices}</script>\n</body>`);
  await writeFile(p(`dist/${name}.html`), html);
  return html;
}

const replayHtml = await buildView("replay", ["base.css", "replay.css", "motion.css"]);
const appsHtml = await buildView("apps", ["base.css", "apps.css", "motion.css"]);
const benchHtml = await buildView("benchmark", ["base.css", "benchmark.css", "motion.css"]);

// Previews: the same pages with the demo incident's data inlined. Both use
// one scenario start, so the two pages tell the same story.
const lib = await import(new URL("dist/lib.js", root).href);
const now = Math.floor(Date.now() / 1000);
const replayRange = lib.resolveRange(30, now, now);
const adapter = new lib.DemoAdapter(replayRange.end - lib.DEMO_SCENARIO_SECONDS);
const inline = (html, data) =>
  html.replace("/*DATA*/null", () => JSON.stringify(data).replace(/</g, "\\u003c"));

await writeFile(p("dist/preview.html"), inline(replayHtml, await lib.buildReplay(adapter, replayRange)));
const cardRange = lib.resolveRange(60, now, now, lib.SCORECARD_MAX_FRAMES);
await writeFile(
  p("dist/apps-preview.html"),
  inline(appsHtml, await lib.buildScorecards(adapter, cardRange, lib.DEFAULT_SLO)),
);

await writeFile(
  p("dist/benchmark-preview.html"),
  inline(benchHtml, { kind: "benchmark-report", result: await lib.runBenchmark(adapter, cardRange) }),
);

console.log(
  `built: replay ${(replayHtml.length / 1024).toFixed(0)} KB, apps ${(appsHtml.length / 1024).toFixed(0)} KB; previews in ${p("dist")}`,
);
