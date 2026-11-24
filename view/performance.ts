import { App } from "@modelcontextprotocol/ext-apps";
import { playEntrance } from "./motion.js";
import type {
  Compared,
  EndpointPerformance,
  PerformanceBundle,
  RangeKey,
  ServicePerformance,
} from "../src/performance.js";

/**
 * The performance page: one period, set beside the period before it, for
 * every service together or for one service and its routes. It prints only
 * values from the bundle, and says so where the bundle has none.
 */

type Samples = (number | null)[];
type Child = Node | string | null | undefined | false;

const RANGES: RangeKey[] = ["15m", "1h", "6h", "24h", "7d", "30d"];
const RANGE_WORDS: Record<RangeKey, string> = {
  "15m": "15 minutes",
  "1h": "hour",
  "6h": "6 hours",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children.filter((c): c is Node | string => !!c));
  return el;
}

let B: PerformanceBundle | null = null;
/** Null is every service together. */
let service: string | null = null;
let env = "";
let route: string | null = null;
let routeText = "";
let routeSort: { key: string; down: boolean } = { key: "requests", down: true };
/** How another period is fetched; null when this page has only the one it was given. */
let source: ((key: RangeKey) => Promise<PerformanceBundle>) | null = null;

// ---------- formatting ----------

const NONE = "no data";
const fmt = {
  latency: (v: number | null) => (v === null ? NONE : v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`),
  ratio: (v: number | null) =>
    v === null ? NONE : v > 0 && v < 0.0005 ? `${(v * 100).toFixed(3)}%` : `${(v * 100).toFixed(v < 0.1 ? 2 : 1)}%`,
  rate: (v: number | null) => (v === null ? NONE : `${v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)} req/s`),
  cores: (v: number | null) => (v === null ? NONE : `${v.toFixed(2)} cores`),
  bytes: (v: number | null) => {
    if (v === null) return NONE;
    const mi = v / (1024 * 1024);
    return mi >= 1024 ? `${(mi / 1024).toFixed(2)} GiB` : `${Math.round(mi)} MiB`;
  },
  count: (v: number | null) => {
    if (v === null) return NONE;
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)} bn`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)} M`;
    return v.toLocaleString("en-US");
  },
  share: (v: number | null) => (v === null ? NONE : `${Math.round(v * 100)}%`),
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A time in UTC; with the date when the period is longer than a day. */
function when(ts: number, long: boolean): string {
  const d = new Date(ts * 1000);
  const hm = d.toISOString().slice(11, 16);
  return long ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hm}` : hm;
}
const isLong = (b: PerformanceBundle) => b.range.end - b.range.start > 86400;

function last(s: Samples | undefined): number | null {
  if (!s) return null;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = s[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** Signed change against the previous period, or null where there is nothing to compare. */
function change(c: Compared): number | null {
  if (c.now === null || c.before === null || c.before === 0) return null;
  return (c.now - c.before) / c.before;
}

type Tone = "" | "ok" | "warn" | "crit";

/**
 * How a figure moved, in words. `worseWhenUp` is for latency, failures and
 * resource use; requests are neither good nor bad for moving.
 */
function moved(c: Compared, format: (v: number | null) => string, worseWhenUp: boolean, floor = 0): { text: string; tone: Tone } {
  if (c.before === null) return { text: "no earlier figure", tone: "" };
  if (c.now === null) return { text: `was ${format(c.before)}`, tone: "" };
  const d = change(c);
  // Too small to mean anything, or the earlier figure was zero: state it, do not rate it.
  if (d === null || Math.abs(c.now - c.before) <= floor || Math.abs(d) < 0.02) {
    return { text: d !== null && Math.abs(d) < 0.02 ? "about the same" : `was ${format(c.before)}`, tone: d === null && worseWhenUp && c.now > floor ? "warn" : "" };
  }
  const pct = Math.abs(d) >= 10 ? `${Math.round(Math.abs(d) + 1)}×` : `${(Math.abs(d) * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%`;
  const text = Math.abs(d) >= 10 ? `${d > 0 ? "up" : "down"} ${pct}, was ${format(c.before)}` : `${d > 0 ? "up" : "down"} ${pct}, was ${format(c.before)}`;
  if (!worseWhenUp) return { text, tone: "" };
  return { text, tone: d > 1 ? "crit" : d > 0.1 ? "warn" : d < -0.1 ? "ok" : "" };
}

// ---------- charts ----------

const SVG = "http://www.w3.org/2000/svg";

interface Line {
  name: string;
  samples: Samples;
  /** Name of a color token. */
  color: string;
  dashed?: boolean;
  /** Quieter than the chart's main line. */
  quiet?: boolean;
  area?: boolean;
  /** Written at the right-hand end of the line. */
  endLabel?: string;
}

interface ChartSpec {
  title: string;
  lines: Line[];
  format: (v: number | null) => string;
  ref?: { value: number | null; label: string };
  note?: string;
}

function linePath(samples: Samples, x: (i: number) => number, y: (v: number) => number, floor: number) {
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

let chartSeq = 0;

function chart(spec: ChartSpec): HTMLElement {
  const b = B!;
  const long = isLong(b);
  const W = 300;
  const H = 120;
  const main = spec.lines[0]!;
  const n = main.samples.length;
  const all = spec.lines.flatMap((l) => l.samples.filter((v): v is number => v !== null && v !== undefined));
  const empty = all.length === 0;
  const top = Math.max(...all, spec.ref?.value ?? 0, 1e-9) * 1.15;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - 1 - (v / top) * (H - 6);
  const grad = `pg${++chartSeq}`;
  const refY = spec.ref && spec.ref.value !== null ? y(spec.ref.value) : null;

  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${spec.title} over the period`);
  let marks = "";
  // Quiet lines first, so the main line is drawn over them.
  for (const l of [...spec.lines].reverse()) {
    const p = linePath(l.samples, x, y, H);
    const stroke = `var(--${l.color})`;
    if (l.area) {
      marks +=
        `<defs><linearGradient id="${grad}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${stroke}" stop-opacity="0.22"/>` +
        `<stop offset="1" stop-color="${stroke}" stop-opacity="0"/></linearGradient></defs><path d="${p.area}" fill="url(#${grad})"/>`;
    }
    marks += `<path class="line${l.dashed ? " dashed" : ""}${l.quiet ? " quiet" : ""}" d="${p.line}" stroke="${stroke}"/>`;
  }
  svg.innerHTML =
    [0.25, 0.5, 0.75].map((f) => `<line class="grid" x1="0" x2="${W}" y1="${(H * f).toFixed(1)}" y2="${(H * f).toFixed(1)}"/>`).join("") +
    `<line class="grid" x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}"/>` +
    marks +
    (refY === null ? "" : `<line class="ref" x1="0" x2="${W}" y1="${refY.toFixed(1)}" y2="${refY.toFixed(1)}"/>`) +
    `<line class="cursor" x1="0" x2="0" y1="0" y2="${H}"/>`;
  const cursor = svg.querySelector<SVGLineElement>(".cursor")!;

  const value = h("span", { class: "chart-value" }, spec.format(last(main.samples)));
  const stamp = h("span", { class: "chart-when" }, "Latest");
  const tip = h("div", { class: "tip", hidden: "" });
  const plot = h("div", { class: `plot${spec.lines.some((l) => l.endLabel) ? " labelled" : ""}` }, svg as unknown as Node, tip);

  // One readout for every line at the moment under the pointer.
  const readAt = (ev: PointerEvent) => {
    if (empty) return;
    const r = svg.getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.round(((ev.clientX - r.left) / r.width) * (n - 1))));
    value.textContent = spec.format(main.samples[i] ?? null);
    stamp.textContent = `${when(b.range.start + i * b.range.step, long)} UTC`;
    cursor.setAttribute("x1", x(i).toFixed(1));
    cursor.setAttribute("x2", x(i).toFixed(1));
    cursor.style.opacity = "0.6";
    if (spec.lines.length > 1) {
      tip.replaceChildren(
        ...spec.lines.map((l) => {
          const key = h("i", { class: l.dashed ? "dashed" : "" });
          key.style.borderTopColor = `var(--${l.color})`;
          return h("div", {}, key, h("b", {}, spec.format(l.samples[i] ?? null)), h("span", {}, l.name));
        }),
      );
      tip.hidden = false;
      const left = ((ev.clientX - r.left) / r.width) * 100;
      tip.style.left = left > 55 ? "" : `calc(${left}% + 12px)`;
      tip.style.right = left > 55 ? `calc(${100 - left}% + 12px)` : "";
    }
  };
  svg.addEventListener("pointermove", readAt);
  svg.addEventListener("pointerdown", readAt);
  svg.addEventListener("pointerleave", () => {
    value.textContent = spec.format(last(main.samples));
    stamp.textContent = "Latest";
    cursor.style.opacity = "0";
    tip.hidden = true;
  });

  if (empty) plot.append(h("span", { class: "nodata" }, "No data in this period"));
  if (refY !== null) {
    const label = h("span", { class: `ref-label${refY < 18 ? " below" : ""}` }, spec.ref!.label);
    label.style.top = `${(refY / H) * 100}%`;
    plot.append(label);
  }
  // Names at the line ends, moved apart where two lines finish close together.
  const ends = spec.lines
    .filter((l) => l.endLabel && last(l.samples) !== null)
    .map((l) => ({ l, at: y(last(l.samples)!) }))
    .sort((a, c) => a.at - c.at);
  for (let i = 1; i < ends.length; i++) ends[i]!.at = Math.max(ends[i]!.at, ends[i - 1]!.at + 13);
  const over = ends.length ? Math.max(0, ends[ends.length - 1]!.at - (H - 4)) : 0;
  for (const e of ends) {
    const tag = h("span", { class: "end-label" }, e.l.endLabel!);
    tag.style.top = `${((e.at - over) / H) * 100}%`;
    plot.append(tag);
  }

  const legend =
    spec.lines.length > 1
      ? h(
          "div",
          { class: "legend" },
          ...spec.lines.map((l) => {
            const key = h("i", { class: l.dashed ? "dashed" : "" });
            key.style.borderTopColor = `var(--${l.color})`;
            return h("span", {}, key, l.name);
          }),
        )
      : null;

  const dot = h("i");
  dot.style.background = `var(--${main.color})`;
  return h(
    "div",
    { class: "chart" },
    h("div", { class: "chart-head" }, h("div", {}, h("span", { class: "chart-title" }, dot, spec.title), stamp), value),
    plot,
    h("div", { class: "chart-foot" }, h("span", {}, when(b.range.start, long)), h("span", {}, `${when(b.range.end, long)} UTC`)),
    legend,
    spec.note ? h("p", { class: "chart-note" }, spec.note) : null,
  );
}

const before = (name: string, samples: Samples): Line => ({ name, samples, color: "faint", dashed: true, quiet: true });

function serviceCharts(s: ServicePerformance): ChartSpec[] {
  const x = s.series;
  const prev = `Previous ${RANGE_WORDS[B!.rangeKey]}`;
  const out: ChartSpec[] = [
    { title: "Requests", format: fmt.rate, lines: [{ name: "This period", samples: x.rate, color: "accent", area: true }, before(prev, x.rateBefore)] },
  ];
  if (x.p50 && x.p90 && x.p99) {
    // The percentiles are ordered by definition and never cross, so one color
    // and a name at each line's end tells them apart.
    out.push({
      title: "Latency",
      format: fmt.latency,
      lines: [
        { name: "p95", samples: x.latencyP95, color: "violet", endLabel: "p95" },
        { name: "p99", samples: x.p99, color: "violet", quiet: true, endLabel: "p99" },
        { name: "p90", samples: x.p90, color: "violet", quiet: true, endLabel: "p90" },
        { name: "p50", samples: x.p50, color: "violet", quiet: true, endLabel: "p50" },
        ...(x.latencyMean ? [{ name: "Mean", samples: x.latencyMean, color: "faint", dashed: true, quiet: true }] : []),
      ],
      note: "The headline figure is p95: 95 in every 100 requests were at least this fast.",
    });
  } else {
    out.push({
      title: "p95 latency",
      format: fmt.latency,
      lines: [{ name: "This period", samples: x.latencyP95, color: "violet", area: true }, before(prev, x.latencyP95Before)],
    });
  }
  out.push({
    title: "Failed requests",
    format: fmt.ratio,
    lines: [{ name: "This period", samples: x.errorRatio, color: "crit", area: true }, before(prev, x.errorRatioBefore)],
  });
  if (x.cpuUsage) {
    const req = last(x.cpuRequest);
    out.push({
      title: "CPU",
      format: fmt.cores,
      lines: [{ name: "Used", samples: x.cpuUsage, color: "cyan", area: true }],
      ref: { value: req, label: `requested ${fmt.cores(req)}` },
    });
  }
  if (x.memUsage) {
    const limit = last(x.memLimit);
    out.push({
      title: "Memory",
      format: fmt.bytes,
      lines: [{ name: "Used", samples: x.memUsage, color: "pink", area: true }],
      ref: { value: limit, label: `limit ${fmt.bytes(limit)}` },
    });
  }
  return out;
}

function routeCharts(e: EndpointPerformance): ChartSpec[] {
  const x = e.series;
  return [
    { title: "Requests", format: fmt.rate, lines: [{ name: "Requests", samples: x.rate, color: "accent", area: true }] },
    { title: "p95 latency", format: fmt.latency, lines: [{ name: "p95", samples: x.latencyP95, color: "violet", area: true }] },
    {
      title: "Error responses",
      format: fmt.rate,
      lines: [
        { name: "5xx, server errors", samples: x.rate5xx, color: "crit" },
        { name: "4xx, client errors", samples: x.rate4xx, color: "warn", dashed: true },
      ],
    },
  ];
}

// ---------- tiles and the sentence above them ----------

function tile(label: string, value: string, note: { text: string; tone: Tone } | string, sub?: string): HTMLElement {
  const n = typeof note === "string" ? { text: note, tone: "" as Tone } : note;
  return h(
    "div",
    { class: "tile surface" },
    h("span", { class: "k" }, label),
    h("span", { class: "v" }, value),
    sub ? h("span", { class: "s" }, sub) : null,
    n.text ? h("span", { class: `n ${n.tone}` }, n.text) : null,
  );
}

function shown(): ServicePerformance[] {
  return B!.services.filter((s) => !env || envOf(s) === env);
}
const envOf = (s: ServicePerformance) => [s.cloud, s.cluster].filter(Boolean).join(" · ");

/** One plain sentence or two: what happened in this period, in words anyone can read. */
function sentence(): string {
  const b = B!;
  const words = RANGE_WORDS[b.rangeKey];
  const s = service ? b.services.find((x) => x.id === service) : null;
  const requests = s ? s.requests : b.totals.requests;
  const errors = s ? s.errorRatio : b.totals.errorRatio;
  const who = s ? s.id : `${b.services.length} applications`;
  if (requests.now === null) return `${who}: no requests were recorded in the last ${words}.`;
  const d = change(requests);
  const traffic =
    d === null
      ? ""
      : Math.abs(d) < 0.02
        ? `, about the same as the ${words} before`
        : `, ${(Math.abs(d) * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}% ${d > 0 ? "more" : "fewer"} than the ${words} before`;
  let text = `${who} handled ${fmt.count(requests.now)} requests in the last ${words}${traffic}.`;
  if (errors.now !== null) {
    text += ` ${fmt.ratio(errors.now)} of them failed`;
    text += errors.before === null ? "." : ` (${fmt.ratio(errors.before)} before).`;
  }
  return text;
}

function renderTiles() {
  const b = B!;
  const s = service ? b.services.find((x) => x.id === service) : null;
  const tiles: HTMLElement[] = [];
  if (s) {
    tiles.push(
      tile("Requests", fmt.count(s.requests.now), moved(s.requests, fmt.count, false), `peak ${fmt.rate(s.ratePeak)}`),
      // "Typical" is the median of the period's p95 samples; the worst sample sits beside it.
      tile("p95 latency, typical", fmt.latency(s.p95.now), moved(s.p95, fmt.latency, true, 0.01), `worst ${fmt.latency(s.p95Worst)}`),
      tile("Failed requests", fmt.ratio(s.errorRatio.now), moved(s.errorRatio, fmt.ratio, true, 0.001)),
    );
    if (s.cpu) tiles.push(tile("CPU, mean", fmt.cores(s.cpu.now), moved(s.cpu, fmt.cores, true, 0.02)));
    if (s.memory) tiles.push(tile("Memory, mean", fmt.bytes(s.memory.now), moved(s.memory, fmt.bytes, true, 16 * 1048576)));
  }
  $("tiles").replaceChildren(...tiles);
}

// ---------- tables ----------

interface Column<T> {
  key: string;
  label: string;
  text: (row: T) => Child;
  /** What the column sorts by; text columns sort by their words. */
  sort: (row: T) => number | string | null;
  num?: boolean;
}

function table<T>(
  el: HTMLElement,
  cols: Column<T>[],
  rows: T[],
  state: { key: string; down: boolean },
  onSort: () => void,
  row: { id: (r: T) => string; selected: (r: T) => boolean; pick: (r: T) => void; label: (r: T) => string },
) {
  const col = cols.find((c) => c.key === state.key) ?? cols[0]!;
  const sorted = [...rows].sort((a, b) => {
    const x = col.sort(a);
    const y = col.sort(b);
    // Rows with no figure go last whichever way the column is sorted.
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const d = typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y)) : x - y;
    return state.down ? -d : d;
  });
  const head = h(
    "thead",
    {},
    h(
      "tr",
      {},
      ...cols.map((c) => {
        const active = c.key === state.key;
        const btn = h("button", { type: "button", class: "sort" }, c.label, active ? h("span", { "aria-hidden": "true" }, state.down ? " ↓" : " ↑") : null);
        btn.addEventListener("click", () => {
          state.down = active ? !state.down : c.num !== false;
          state.key = c.key;
          onSort();
        });
        return h("th", { class: c.num ? "num" : "", "aria-sort": active ? (state.down ? "descending" : "ascending") : "none" }, btn);
      }),
    ),
  );
  const body = h(
    "tbody",
    {},
    ...sorted.map((r) => {
      const tr = h(
        "tr",
        { tabindex: "0", role: "button", "aria-pressed": String(row.selected(r)), "aria-label": row.label(r), "data-id": row.id(r) },
        ...cols.map((c) => h("td", { class: c.num ? "num" : "" }, c.text(r))),
      );
      tr.addEventListener("click", () => row.pick(r));
      tr.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          row.pick(r);
        }
      });
      return tr;
    }),
  );
  el.replaceChildren(head, body);
}

const KIND_WORD: Record<string, string> = { service: "Service", database: "Database", queue: "Queue", external: "External" };

/** True when this page has an address of its own, so a card can open in a new tab. */
let standalone = false;
/** True when another period comes from the live server, not from data inlined in the file. */
let served = false;

/** The address of this page for a period and, optionally, one application. */
function address(key: RangeKey, id: string | null): string {
  const hash = [id ? `service=${encodeURIComponent(id)}` : "", served ? "" : `range=${key}`].filter(Boolean).join("&");
  return `${location.pathname}${served ? `?range=${key}` : ""}${hash ? `#${hash}` : ""}`;
}

function figure(label: string, value: string, note?: { text: string; tone: Tone }): HTMLElement {
  return h(
    "span",
    { class: "fig" },
    h("span", { class: "k" }, label),
    h("span", { class: "v" }, value),
    note && note.tone ? h("span", { class: `n ${note.tone}` }, note.text.split(",")[0]!) : null,
  );
}

/**
 * The first thing on the page: one card per application (a service, a
 * database, a queue), with its own figures. A card opens that application
 * in a new tab; inside a host, which has no tabs, it opens in place.
 */
function renderCards() {
  const b = B!;
  $("services").hidden = !!service;
  if (service) return;
  $("cards").replaceChildren(
    ...shown().map((s) => {
      const where = [KIND_WORD[s.kind ?? ""] ?? s.kind, envOf(s)].filter(Boolean).join(" · ");
      const resources = [s.cpu ? `CPU ${fmt.cores(s.cpu.now)}` : "", s.memory ? `Memory ${fmt.bytes(s.memory.now)}` : ""].filter(Boolean).join(" · ");
      const parts: Child[] = [
        h("span", { class: "app-head" }, h("span", { class: "name" }, s.id), where ? h("span", { class: "where" }, where) : null),
        h(
          "span",
          { class: "figs" },
          figure("Requests", fmt.count(s.requests.now)),
          figure("p95 latency", fmt.latency(s.p95.now), moved(s.p95, fmt.latency, true, 0.01)),
          figure("Failed", fmt.ratio(s.errorRatio.now), moved(s.errorRatio, fmt.ratio, true, 0.001)),
        ),
        h("span", { class: "app-foot" }, h("span", {}, resources || (b.capabilities.resources ? "No CPU or memory data" : "")), h("span", { class: "open" }, standalone ? "Open in new tab ↗" : "Open →")),
      ];
      if (standalone) {
        return h("a", { class: "app surface", href: address(b.rangeKey, s.id), target: "_blank", rel: "noopener", "aria-label": `Open ${s.id} in a new tab` }, ...parts);
      }
      const card = h("button", { class: "app surface", type: "button", "aria-label": `Open ${s.id}` }, ...parts);
      card.addEventListener("click", () => pickService(s.id));
      return card;
    }),
  );
}

const routeKey = (e: EndpointPerformance) => `${e.service} ${e.endpoint}`;

function renderRoutes() {
  const b = B!;
  const visible = new Set(shown().map((s) => s.id));
  const mine = b.endpoints.filter((e) => (service ? e.service === service : visible.has(e.service)));
  const rows = mine.filter((e) => !routeText || routeKey(e).toLowerCase().includes(routeText.toLowerCase()));
  const note = $("routenote");
  const tableEl = $("routetable");
  $("routefilter").hidden = mine.length === 0;
  if (!b.capabilities.endpoints) {
    note.textContent = "Per-route metrics are switched off for this backend.";
  } else if (mine.length === 0) {
    note.textContent = service
      ? `No per-route metrics were found for ${service} in this period. They come from the service's HTTP server metrics.`
      : "No per-route metrics were found in this period. They come from each service's HTTP server metrics.";
  } else if (rows.length === 0) {
    note.textContent = "No route matches the filter.";
  } else {
    note.textContent = "Select a route for its charts. 4xx are requests the caller got wrong; 5xx are failures in the service.";
  }
  tableEl.hidden = rows.length === 0;
  if (route && !rows.some((e) => routeKey(e) === route)) route = null;

  const bar = (v: number | null) => {
    const fill = h("b");
    fill.style.width = `${Math.round(Math.min(1, v ?? 0) * 100)}%`;
    return h("span", { class: "sharebar" }, h("span", {}, fmt.share(v)), h("i", { "aria-hidden": "true" }, fill));
  };
  const flag = (v: number | null, warnAt: number, tone: Tone) => h("span", { class: v !== null && v >= warnAt ? tone : "" }, fmt.ratio(v));
  const cols: Column<EndpointPerformance>[] = [
    ...(service ? [] : [{ key: "service", label: "Service", text: (e: EndpointPerformance) => e.service, sort: (e: EndpointPerformance) => e.service, num: false }]),
    { key: "endpoint", label: "Route", text: (e) => h("code", {}, e.endpoint), sort: (e) => e.endpoint, num: false },
    { key: "requests", label: "Requests", text: (e) => fmt.count(e.requests), sort: (e) => e.requests, num: true },
    { key: "share", label: "Share of service", text: (e) => bar(e.share), sort: (e) => e.share, num: true },
    { key: "p95", label: "p95", text: (e) => fmt.latency(e.p95), sort: (e) => e.p95, num: true },
    { key: "worst", label: "Worst p95", text: (e) => fmt.latency(e.p95Worst), sort: (e) => e.p95Worst, num: true },
    { key: "4xx", label: "4xx", text: (e) => flag(e.ratio4xx, 0.05, "warn"), sort: (e) => e.ratio4xx, num: true },
    { key: "5xx", label: "5xx", text: (e) => flag(e.ratio5xx, 0.01, "crit"), sort: (e) => e.ratio5xx, num: true },
  ];
  table(tableEl, cols, rows, routeSort, renderRoutes, {
    id: routeKey,
    selected: (e) => routeKey(e) === route,
    pick: (e) => {
      route = routeKey(e) === route ? null : routeKey(e);
      renderRoutes();
    },
    label: (e) => `Charts for ${e.service} ${e.endpoint}`,
  });

  const picked = rows.find((e) => routeKey(e) === route);
  const detail = $("routedetail");
  detail.hidden = !picked;
  if (picked) {
    detail.replaceChildren(
      h("h3", {}, h("code", {}, picked.endpoint), h("span", { class: "muted" }, ` on ${picked.service}`)),
      h("div", { class: "charts" }, ...routeCharts(picked).map(chart)),
    );
  }
}

// ---------- the page ----------

function pickService(id: string | null) {
  service = id;
  route = null;
  ($("service") as HTMLSelectElement).value = id ?? "";
  render();
  if (id) $("filters").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderFilters() {
  const b = B!;
  $("ranges").replaceChildren(
    ...RANGES.map((key) => {
      const btn = h("button", { type: "button", "aria-pressed": String(key === b.rangeKey) }, key) as HTMLButtonElement;
      // With nowhere to fetch from, only the period this page was given can be shown.
      btn.disabled = !source && key !== b.rangeKey;
      if (btn.disabled) btn.title = "Serve this page live to change the period";
      btn.addEventListener("click", () => key !== B!.rangeKey && load(key));
      return btn;
    }),
  );
  const envs = [...new Set(b.services.map(envOf).filter(Boolean))].sort();
  if (!envs.includes(env)) env = "";
  $("envwrap").hidden = envs.length < 2;
  $("env").replaceChildren(h("option", { value: "" }, "All environments"), ...envs.map((e) => h("option", { value: e }, e)));
  ($("env") as HTMLSelectElement).value = env;
  const list = shown();
  if (service && !list.some((s) => s.id === service)) service = null;
  $("service").replaceChildren(h("option", { value: "" }, "All applications"), ...[...list].sort((a, c) => a.id.localeCompare(c.id)).map((s) => h("option", { value: s.id }, s.id)));
  ($("service") as HTMLSelectElement).value = service ?? "";
}

function render() {
  const b = B!;
  const long = isLong(b);
  $("meta").textContent = `${when(b.range.start, long)} to ${when(b.range.end, long)} UTC${long ? "" : `, ${new Date(b.range.end * 1000).toISOString().slice(0, 10)}`} · ${b.backend}`;
  $("simulated").hidden = !b.simulated;
  $("filters").hidden = false;
  renderFilters();

  const none = b.services.length === 0;
  $("state").hidden = !none;
  $("state").textContent = none ? "The backend returned no services for this period. Check that request metrics are being collected, or try a longer period." : "";
  $("body").hidden = none;
  if (none) return;

  const s = service ? b.services.find((x) => x.id === service) : null;
  const back = h("a", { class: "back", href: address(b.rangeKey, null) }, "← All applications");
  back.addEventListener("click", (ev) => {
    ev.preventDefault();
    pickService(null);
  });
  $("summary").replaceChildren(...(s ? [back] : []), h("span", {}, sentence()));
  document.title = s ? `${s.id} · Performance` : "Performance analytics";
  renderCards();
  // Tiles, charts and routes belong to one application; the first screen is the cards alone.
  for (const id of ["tiles", "charts", "routes"]) $(id).hidden = !s;
  if (s) {
    renderTiles();
    $("charts").replaceChildren(...serviceCharts(s).map(chart));
    $("routes-h").textContent = `Routes of ${s.id}`;
    renderRoutes();
  }

  $("gaps").hidden = b.gaps.length === 0;
  $("gaps").replaceChildren(...b.gaps.map((g) => h("li", {}, g)));
  const dl = $("querylist");
  dl.replaceChildren();
  for (const q of b.queries) {
    dl.append(h("dt", {}, q.language === "none" ? q.purpose : `${q.purpose} (${q.language})`), h("dd", {}, h("code", {}, q.query)));
  }
  if (standalone) {
    const next = address(b.rangeKey, service);
    if (`${location.pathname}${location.search}${location.hash}` !== next) history.replaceState(null, "", next);
  }
}

function prepare(b: PerformanceBundle, keep = false) {
  B = b;
  if (!keep) service = b.focus ?? null;
  playEntrance();
  render();
}

/** Fetch another period, holding the current one on screen, dimmed, until it arrives. */
async function load(key: RangeKey, quiet = false) {
  if (!source) return;
  const state = $("state");
  if (!quiet) document.body.classList.add("loading");
  try {
    const next = await source(key);
    if (!isBundle(next)) throw new Error("the answer was not a performance report");
    state.hidden = true;
    prepare(next, true);
  } catch (e) {
    // A timed re-read that fails keeps the last good read; a chosen period that fails says so.
    if (!quiet) {
      state.hidden = false;
      state.textContent = `Could not read the last ${RANGE_WORDS[key]}: ${(e as Error).message}. The figures below are from the earlier read.`;
    }
  } finally {
    document.body.classList.remove("loading");
  }
}

function setTheme(theme?: string) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
}

function isBundle(v: unknown): v is PerformanceBundle {
  const b = v as PerformanceBundle | null;
  return !!b && b.version === 1 && b.kind === "performance" && Array.isArray(b.services);
}

$("service").addEventListener("change", (ev) => pickService((ev.target as HTMLSelectElement).value || null));
$("env").addEventListener("change", (ev) => {
  env = (ev.target as HTMLSelectElement).value;
  render();
});
$("routefilter").addEventListener("input", (ev) => {
  routeText = (ev.target as HTMLInputElement).value;
  renderRoutes();
});

const w = window as unknown as {
  __PERFORMANCE__?: unknown;
  __PERIODS__?: Record<string, unknown>;
  __LIVE__?: { url: string; seconds: number };
};

if (isBundle(w.__PERFORMANCE__)) {
  // Opened as a plain page with the data inlined.
  $("nav").hidden = false;
  standalone = true;
  served = !!w.__LIVE__;
  if (w.__LIVE__) {
    const live = w.__LIVE__;
    source = async (key) => {
      const res = await fetch(`${live.url}?range=${key}`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.text()).slice(0, 200) || `HTTP ${res.status}`);
      return (await res.json()) as PerformanceBundle;
    };
    if (live.seconds > 0) setInterval(() => B && load(B.rangeKey, true), live.seconds * 1000);
  } else if (w.__PERIODS__) {
    const periods = w.__PERIODS__;
    source = async (key) => periods[key] as PerformanceBundle;
  }
  // Read the address before the first render, which rewrites it.
  const want = /[#&]service=([^&]+)/.exec(location.hash);
  const period = /[#&]range=([^&]+)/.exec(location.hash)?.[1];
  const first = !served && period && isBundle(w.__PERIODS__?.[period]) ? (w.__PERIODS__![period] as PerformanceBundle) : w.__PERFORMANCE__;
  prepare(first);
  if (want && first.services.some((s) => s.id === decodeURIComponent(want[1]!))) pickService(decodeURIComponent(want[1]!));
} else {
  const app = new App({ name: "Performance analytics", version: "0.1.0" }, {});
  const state = $("state");
  state.hidden = false;
  state.textContent = "Reading the backend…";
  app.addEventListener("toolresult", (result) => {
    if (result.isError) {
      state.hidden = false;
      state.textContent = "The performance tool returned an error; see the conversation for details.";
    } else if (isBundle(result.structuredContent)) {
      state.hidden = true;
      prepare(result.structuredContent);
    }
  });
  app.addEventListener("hostcontextchanged", (ctx) => setTheme(ctx.theme));
  app
    .connect()
    .then(() => {
      setTheme(app.getHostContext()?.theme);
      // In a host, another period is one more call of the same read-only tool.
      source = async (key) => {
        const result = await app.callServerTool({ name: "performance_analytics", arguments: { range: key } });
        if (result.isError) throw new Error("the tool returned an error");
        return result.structuredContent as unknown as PerformanceBundle;
      };
      if (B) renderFilters();
    })
    .catch(() => {
      state.hidden = false;
      state.textContent = "No data: open this view through the performance_analytics tool, or use the preview page.";
    });
}
