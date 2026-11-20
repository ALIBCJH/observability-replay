import { App } from "@modelcontextprotocol/ext-apps";
import { playEntrance } from "./motion.js";
import type { AppCard, ScorecardBundle, Severity, Status } from "../src/scorecard.js";

/**
 * The scorecard page: every application in one list, worst first, and a detail
 * section for the selected one. It prints only values from the bundle.
 */

type Samples = (number | null)[];
type Child = Node | string | null | undefined | false;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children.filter((c): c is Node | string => !!c));
  return el;
}

let B: ScorecardBundle | null = null;
let selected: string | null = null;

// ---------- formatting ----------

const clock = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16);
const NONE = "no data";

const fmt = {
  latency: (v: number | null) =>
    v === null ? NONE : v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`,
  ratio: (v: number | null) =>
    v === null ? NONE : v > 0 && v < 0.0005 ? `${(v * 100).toFixed(3)}%` : `${(v * 100).toFixed(v < 0.1 ? 2 : 1)}%`,
  rate: (v: number | null) => (v === null ? NONE : `${v.toFixed(1)} req/s`),
  percent: (v: number | null) => (v === null ? NONE : `${Math.round(v * 100)}%`),
  cores: (v: number | null) => (v === null ? NONE : `${v.toFixed(2)} cores`),
  bytes: (v: number | null) => {
    if (v === null) return NONE;
    const mi = v / (1024 * 1024);
    return mi >= 1024 ? `${(mi / 1024).toFixed(2)} GiB` : `${Math.round(mi)} MiB`;
  },
  count: (v: number | null) => (v === null ? NONE : v.toLocaleString("en-US")),
};

const STATUS_WORD: Record<Status, string> = {
  crit: "Needs attention",
  warn: "Watch",
  ok: "Healthy",
  nodata: "No data",
};
const SEVERITY_WORD: Record<Severity, string> = { crit: "Critical", warn: "Warning", info: "Note" };

function last(s: Samples | undefined): number | null {
  if (!s) return null;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = s[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

// ---------- small drawing helpers ----------

const SVG = "http://www.w3.org/2000/svg";

/** Line and area paths for samples; a null sample breaks the line. */
function paths(samples: Samples, x: (i: number) => number, y: (v: number) => number, floor: number) {
  let line = "";
  let area = "";
  let start = -1;
  const close = (end: number) => {
    if (start >= 0) area += `L${x(end).toFixed(1)} ${floor}L${x(start).toFixed(1)} ${floor}Z`;
    start = -1;
  };
  samples.forEach((v, i) => {
    if (v === null || v === undefined) {
      close(i - 1);
      return;
    }
    const pt = `${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    line += `${start < 0 ? "M" : "L"}${pt}`;
    area += `${start < 0 ? "M" : "L"}${pt}`;
    if (start < 0) start = i;
  });
  close(samples.length - 1);
  return { line, area };
}

// ---------- summary ----------

/** One sentence above the list: how many applications need a look. */
function renderSummary() {
  const b = B!;
  const n = (s: Status) => b.apps.filter((a) => a.status === s).length;
  const crit = n("crit");
  const warn = n("warn");
  const text =
    crit > 0
      ? `${crit} of ${b.apps.length} ${crit === 1 ? "needs" : "need"} attention`
      : warn > 0
        ? `${warn} of ${b.apps.length} to watch`
        : `All ${b.apps.length} healthy`;
  $("summary").replaceChildren(h("span", { class: `tag ${crit ? "crit" : warn ? "warn" : "ok"}` }, text), "Select an application for its charts.");
}

// ---------- fleet list ----------

function cell(label: string, value: string, level: "" | "bad" | "elevated"): HTMLElement {
  return h("span", level ? { class: level } : {}, h("span", { class: "cell-label" }, label), value);
}

function renderRows() {
  const b = B!;
  const budget = 1 - b.slo.availability;
  $("rows").replaceChildren(
    ...b.apps.map((a) => {
      const p = a.performance;
      const burn = p.burnRate ?? 0;
      const row = h(
        "button",
        { class: "row", type: "button", "aria-pressed": String(a.id === selected), "data-app": a.id, "data-status": a.status },
        h(
          "span",
          {},
          h("span", { class: "name" }, a.id, a.status === "ok" ? null : h("span", { class: `tag ${a.status}` }, STATUS_WORD[a.status])),
          a.findings[0] && a.status !== "ok" ? h("span", { class: "top-finding" }, a.findings[0].text) : null,
        ),
        cell("Requests", fmt.rate(a.usage.now), ""),
        cell("p95 latency", fmt.latency(p.p95Now), p.p95Now !== null && p.p95Now > b.slo.latencyP95 ? "bad" : ""),
        cell("Errors", fmt.ratio(p.errorRatio), p.errorRatio !== null && p.errorRatio > budget ? (burn >= 14.4 ? "bad" : "elevated") : ""),
      );
      // Choosing the open application again closes it.
      row.addEventListener("click", () => select(a.id === selected ? null : a.id, true));
      return row;
    }),
  );
}

// ---------- detail ----------

interface ChartSpec {
  title: string;
  samples: Samples;
  format: (v: number | null) => string;
  /** Name of the color token for this series. */
  series: string;
  ref?: { value: number | null; label: string };
}

let chartSeq = 0;

function chart(spec: ChartSpec, a: AppCard): HTMLElement {
  const b = B!;
  const W = 300;
  const H = 96;
  const n = spec.samples.length;
  const vals = spec.samples.filter((v): v is number => v !== null);
  const top = Math.max(...vals, spec.ref?.value ?? 0, 1e-9) * 1.15;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - 1 - (v / top) * (H - 4);
  const p = paths(spec.samples, x, y, H);
  const grad = `g${++chartSeq}`;

  const frameOf = (ts: number) => (ts - b.range.start) / b.range.step;
  const changeX = a.changes.map((c) => x(frameOf(c.at)));
  const refY = spec.ref && spec.ref.value !== null ? y(spec.ref.value) : null;

  const value = h("span", { class: "chart-value" }, spec.format(last(spec.samples)));
  const when = h("span", { class: "chart-when" }, "Latest");
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${spec.title} over the window`);
  svg.innerHTML =
    `<defs><linearGradient id="${grad}" x1="0" x2="0" y1="0" y2="1">` +
    `<stop offset="0" stop-color="var(--series)" stop-opacity="0.32"/><stop offset="1" stop-color="var(--series)" stop-opacity="0"/></linearGradient></defs>` +
    [0.25, 0.5, 0.75].map((f) => `<line class="grid" x1="0" x2="${W}" y1="${(H * f).toFixed(1)}" y2="${(H * f).toFixed(1)}"/>`).join("") +
    `<line class="grid" x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}"/>` +
    changeX.map((cx) => `<line class="chg" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="0" y2="${H}"/>`).join("") +
    `<path class="area" d="${p.area}" fill="url(#${grad})"/><path class="line" d="${p.line}"/>` +
    (refY === null ? "" : `<line class="ref" x1="0" x2="${W}" y1="${refY.toFixed(1)}" y2="${refY.toFixed(1)}"/>`) +
    `<line class="cursor" x1="0" x2="0" y1="0" y2="${H}"/>`;
  const cursor = svg.querySelector<SVGLineElement>(".cursor")!;

  // Hover or drag to read the sample at any moment.
  const readAt = (ev: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.round(((ev.clientX - r.left) / r.width) * (n - 1))));
    const v = spec.samples[i] ?? null;
    value.textContent = spec.format(v);
    when.textContent = `${clock(b.range.start + i * b.range.step)} UTC`;
    cursor.setAttribute("x1", x(i).toFixed(1));
    cursor.setAttribute("x2", x(i).toFixed(1));
    cursor.style.opacity = "0.6";
  };
  svg.addEventListener("pointermove", readAt);
  svg.addEventListener("pointerdown", readAt);
  svg.addEventListener("pointerleave", () => {
    value.textContent = spec.format(last(spec.samples));
    when.textContent = "Latest";
    cursor.style.opacity = "0";
  });

  const plot = h("div", { class: "plot" }, svg as unknown as Node);
  for (const cx of changeX) {
    const m = h("span", { class: "chg-mark", "aria-hidden": "true" });
    m.style.left = `${(cx / W) * 100}%`;
    plot.append(m);
  }
  if (refY !== null) {
    const label = h("span", { class: `ref-label${refY < 18 ? " below" : ""}` }, spec.ref!.label);
    label.style.top = `${(refY / H) * 100}%`;
    plot.append(label);
  }

  const box = h(
    "div",
    { class: "chart" },
    h(
      "div",
      { class: "chart-head" },
      h("div", {}, h("span", { class: "chart-title" }, h("i"), spec.title), when),
      value,
    ),
    plot,
    h("div", { class: "chart-foot" }, h("span", {}, clock(b.range.start)), h("span", {}, `${clock(b.range.end)} UTC`)),
  );
  box.style.setProperty("--series", `var(--${spec.series})`);
  return box;
}

function fact(label: string, value: string, small?: string): HTMLElement {
  return h("div", {}, h("dt", {}, label), h("dd", {}, value, small ? h("small", {}, ` ${small}`) : null));
}

function renderDetail() {
  const b = B!;
  const a = b.apps.find((x) => x.id === selected);
  const box = $("detail");
  box.hidden = !a;
  if (!a) return;
  const minutes = Math.round((b.range.end - b.range.start) / 60);
  const where = [a.kind, a.cloud, a.cluster].filter(Boolean).join(" · ");
  const s = a.series;

  const charts: ChartSpec[] = [
    { title: "Requests", samples: s.rate, format: fmt.rate, series: "accent" },
    {
      title: "p95 latency",
      samples: s.latencyP95,
      format: fmt.latency,
      series: "violet",
      ref: { value: b.slo.latencyP95, label: `objective ${fmt.latency(b.slo.latencyP95)}` },
    },
    {
      title: "Error ratio",
      samples: s.errorRatio,
      format: fmt.ratio,
      series: "crit",
      ref: { value: 1 - b.slo.availability, label: `budget ${fmt.ratio(1 - b.slo.availability)}` },
    },
  ];
  if (s.cpuUsage) {
    const req = last(s.cpuRequest);
    charts.push({
      title: "CPU",
      samples: s.cpuUsage,
      format: fmt.cores,
      series: "cyan",
      ref: { value: req, label: `requested ${fmt.cores(req)}` },
    });
  }
  if (s.memUsage) {
    const limit = last(s.memLimit);
    charts.push({
      title: "Memory",
      samples: s.memUsage,
      format: fmt.bytes,
      series: "pink",
      ref: { value: limit, label: `limit ${fmt.bytes(limit)}` },
    });
  }

  const deps = (label: string, ids: string[]) =>
    h(
      "div",
      { class: "flow-group" },
      h("span", { class: "muted" }, label),
      ...(ids.length
        ? ids.map((id) => {
            const other = b.apps.find((x) => x.id === id);
            const chip = h(
              "button",
              { class: "dep", type: "button" },
              h("i", other ? { class: other.status } : {}),
              id,
              other && other.status !== "ok" ? h("small", {}, STATUS_WORD[other.status]) : null,
            );
            chip.addEventListener("click", () => select(id, true));
            return chip;
          })
        : [h("span", { class: "none" }, "Nothing")]),
    );

  const r = a.resources;
  const more = h(
    "details",
    { class: "more" },
    h("summary", {}, "More detail"),
    h("h3", {}, "Totals"),
    h(
      "dl",
      { class: "facts" },
      fact("Requests served", fmt.count(a.usage.total)),
      fact("Peak rate", fmt.rate(a.usage.peak)),
      fact("Worst p95", fmt.latency(a.performance.p95Worst)),
      ...(r
        ? [
            fact("CPU of request", fmt.percent(r.cpuOfRequest), `peak ${fmt.percent(r.cpuPeakOfRequest)}`),
            fact("CPU throttled, peak", fmt.percent(r.throttledPeak)),
            fact("Memory of limit, peak", fmt.percent(r.memPeakOfLimit)),
            fact("Restarts", String(r.restarts)),
            fact("Replicas", r.replicas === null ? NONE : String(r.replicas)),
          ]
        : [fact("CPU and memory", "Not available", "from this backend")]),
    ),
    h("h3", {}, "Changes in the window"),
    a.changes.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            {},
            h("thead", {}, h("tr", {}, ...["Time (UTC)", "Change", "p95 before → after", "Errors before → after", "Effect"].map((t) => h("th", {}, t)))),
            h(
              "tbody",
              {},
              ...a.changes.map((c) =>
                h(
                  "tr",
                  {},
                  h("td", {}, clock(c.at)),
                  h("td", {}, `${c.kind}: ${c.description}`),
                  h("td", {}, `${fmt.latency(c.p95Before)} → ${fmt.latency(c.p95After)}`),
                  h("td", {}, `${fmt.ratio(c.errBefore)} → ${fmt.ratio(c.errAfter)}`),
                  h("td", { class: c.verdict === "regressed" ? "bad" : "" }, c.verdict),
                ),
              ),
            ),
          ),
        )
      : h("p", { class: "muted" }, b.capabilities.changes ? "No deploys or rollbacks in this window." : "This backend cannot report deploys."),
    h("h3", {}, "Dependencies"),
    h(
      "div",
      { class: "flow" },
      deps("Called by", a.calledBy),
      h("span", { class: "flow-arrow", "aria-hidden": "true" }, "→"),
      h("span", { class: "flow-self" }, a.id),
      h("span", { class: "flow-arrow", "aria-hidden": "true" }, "→"),
      deps("Calls", a.calls),
    ),
  );

  box.replaceChildren(
    h("h2", {}, a.id, h("span", { class: `tag ${a.status}` }, STATUS_WORD[a.status])),
    h("p", { class: "muted" }, `${where}${where ? " · " : ""}last ${minutes} min`),
    h(
      "ul",
      { class: "findings" },
      ...a.findings.map((f) => h("li", { class: f.severity }, h("span", { class: `tag ${f.severity}` }, SEVERITY_WORD[f.severity]), h("span", {}, f.text))),
    ),
    h("div", { class: "charts" }, ...charts.map((c) => chart(c, a))),
    more,
  );
}

function select(id: string | null, scroll = false) {
  selected = id;
  for (const row of document.querySelectorAll<HTMLElement>("#rows .row")) {
    row.setAttribute("aria-pressed", String(row.dataset.app === id));
  }
  renderDetail();
  if (scroll && id) $("detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function prepare(b: ScorecardBundle) {
  B = b;
  playEntrance();
  const minutes = Math.round((b.range.end - b.range.start) / 60);
  const day = new Date(b.range.end * 1000).toISOString().slice(0, 10);
  $("meta").textContent = `Last ${minutes} min to ${clock(b.range.end)} UTC, ${day} · ${b.backend}`;
  $("meta").title = `Objectives: ${fmt.ratio(b.slo.availability)} success, p95 under ${fmt.latency(b.slo.latencyP95)}`;

  const empty = b.apps.length === 0;
  $("empty").hidden = !empty;
  $("empty").textContent = empty ? "The backend returned no applications for this window." : "";
  $("fleet").hidden = empty;
  $("summary").hidden = empty;
  $("queries").hidden = empty;
  if (empty) {
    $("detail").hidden = true;
    return;
  }

  selected = b.focus ?? null;
  renderSummary();
  renderRows();
  renderDetail();

  const dl = $("querylist");
  dl.replaceChildren();
  for (const q of b.queries) {
    dl.append(
      h("dt", {}, q.language === "none" ? q.purpose : `${q.purpose} (${q.language})`),
      h("dd", {}, h("code", {}, q.query)),
    );
  }
}

function setTheme(theme?: string) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
}

function isBundle(v: unknown): v is ScorecardBundle {
  const b = v as ScorecardBundle | null;
  return !!b && b.version === 1 && b.kind === "scorecards" && Array.isArray(b.apps);
}

const embedded = (window as unknown as { __SCORECARDS__?: unknown }).__SCORECARDS__;
if (isBundle(embedded)) {
  // Opened as a plain page with the data inlined.
  $("nav").hidden = false;
  prepare(embedded);
  const want = /[#&]app=([^&]+)/.exec(location.hash);
  if (want && embedded.apps.some((a) => a.id === decodeURIComponent(want[1]!))) {
    select(decodeURIComponent(want[1]!));
  }
} else {
  const app = new App({ name: "Application scorecards", version: "0.1.0" }, {});
  app.addEventListener("toolresult", (result) => {
    if (result.isError) {
      $("empty").hidden = false;
      $("empty").textContent = "The scorecard tool returned an error; see the conversation for details.";
    } else if (isBundle(result.structuredContent)) {
      prepare(result.structuredContent);
    }
  });
  app.addEventListener("hostcontextchanged", (ctx) => setTheme(ctx.theme));
  app
    .connect()
    .then(() => setTheme(app.getHostContext()?.theme))
    .catch(() => {
      $("empty").hidden = false;
      $("empty").textContent =
        "No data: open this view through the application_scorecards tool, or use the preview page.";
    });
}
