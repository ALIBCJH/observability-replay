import { App } from "@modelcontextprotocol/ext-apps";
import { playEntrance } from "./motion.js";
import type { ReplayBundle } from "../src/replay.js";

/**
 * The renderer. It draws only what is in the bundle: animation interpolates
 * between samples for smooth motion, but every number printed is a real sample
 * from the nearest frame.
 */

type Samples = (number | null)[];
type Status = 0 | 1 | 2 | 3; // ok, off baseline, critical, no data

type StoryKind = "change" | "onset" | "alert" | "resolved";
interface Story {
  at: number;
  kind: StoryKind;
  text: string;
  service?: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Seconds a full replay takes at 1×. */
const PLAY_SECONDS = 45;

let B: ReplayBundle | null = null;
let frames = 0;
let pos = 0;
let playing = false;
let speed = 1;
let selected: string | null = null;
let colors: Record<string, string> = {};

let layout = new Map<string, { lx: number; ly: number }>();
let baselines = new Map<string, { lat: number | null; err: number | null }>();
let statuses = new Map<string, Status[]>();
let offBaseline: number[] = [];
let anyCritical: boolean[] = [];
let story: Story[] = [];
let maxEdgeRate = 1;
let maxNodeRate = 1;
let particles: { t: number; err: boolean }[][] = [];
let spawnDebt: number[] = [];
let pulses: { service: string; age: number }[] = [];
let lastPulsedFrame = -1;

// ---------- helpers ----------

function clock(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(11, 19);
}

function lerp(samples: Samples, p: number): number | null {
  const i = Math.floor(p);
  const a = samples[i];
  const b = samples[Math.min(i + 1, samples.length - 1)];
  if (a === null || a === undefined) return null;
  if (b === null || b === undefined) return a;
  return a + (b - a) * (p - i);
}

function nearest(samples: Samples, p: number): number | null {
  const v = samples[Math.round(p)];
  return v === undefined ? null : v;
}

function median(values: number[]): number | null {
  if (values.length < 3) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function baselineOf(samples: Samples): number | null {
  const head = samples.slice(0, Math.max(5, Math.floor(samples.length / 5)));
  return median(head.filter((v): v is number => v !== null));
}

function fmtLatency(v: number | null): string {
  if (v === null) return "no data";
  return v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`;
}
function fmtRatio(v: number | null): string {
  return v === null ? "no data" : `${(v * 100).toFixed(1)}%`;
}
function fmtRate(v: number | null): string {
  return v === null ? "no data" : `${v.toFixed(1)} req/s`;
}

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ["bg", "surface", "raised", "ink", "muted", "faint", "line", "edge", "ok", "warn", "crit", "accent"]) {
    colors[k] = cs.getPropertyValue(`--${k}`).trim();
  }
}

function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const c = pa.map((x, i) => Math.round(x + (pb[i]! - x) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function parseHex(h: string): number[] {
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------- preparing a bundle ----------

function computeLayout(b: ReplayBundle) {
  const ids = b.services.map((s) => s.id);
  const inbound = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of b.edgeSeries) inbound.get(e.to)?.push(e.from);

  // Layer = longest path from a root. The pass count is capped so a cycle in
  // the graph cannot loop forever.
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const e of b.edgeSeries) {
      const want = (layer.get(e.from) ?? 0) + 1;
      if (want > (layer.get(e.to) ?? 0) && want < ids.length) {
        layer.set(e.to, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const depth = Math.max(0, ...layer.values());
  const order = new Map<string, number>();
  layout = new Map();
  for (let l = 0; l <= depth; l++) {
    const members = ids.filter((id) => layer.get(id) === l);
    // Sit each node near the average position of the nodes that call it.
    const score = (id: string) => {
      const parents = (inbound.get(id) ?? []).filter((p) => order.has(p));
      if (parents.length === 0) return 0.5;
      return parents.reduce((a, p) => a + order.get(p)!, 0) / parents.length;
    };
    members.sort((a, c) => score(a) - score(c) || a.localeCompare(c));
    members.forEach((id, i) => {
      const y = (i + 0.5) / members.length;
      order.set(id, y);
      layout.set(id, { lx: depth === 0 ? 0.5 : l / depth, ly: y });
    });
  }
}

function prepare(b: ReplayBundle) {
  B = b;
  playEntrance();
  frames = Math.floor((b.range.end - b.range.start) / b.range.step) + 1;
  pos = 0;
  computeLayout(b);

  baselines = new Map();
  statuses = new Map();
  offBaseline = new Array(frames).fill(0);
  anyCritical = new Array(frames).fill(false);
  maxNodeRate = 1;
  for (const s of b.serviceSeries) {
    const lat = baselineOf(s.latencyP95);
    const err = baselineOf(s.errorRatio);
    baselines.set(s.service, { lat, err });
    const st: Status[] = [];
    for (let i = 0; i < frames; i++) {
      const l = s.latencyP95[i] ?? null;
      const e = s.errorRatio[i] ?? null;
      const r = s.rate[i] ?? null;
      if (r !== null && r > maxNodeRate) maxNodeRate = r;
      let v: Status = l === null && e === null && r === null ? 3 : 0;
      const latOff = l !== null && lat !== null && l > Math.max(3 * lat, lat + 0.1);
      const errOff = e !== null && err !== null && e > Math.max(3 * err, err + 0.02);
      if (latOff || errOff) v = 1;
      if ((e !== null && e >= 0.1) || (l !== null && lat !== null && lat > 0 && l > 10 * lat)) v = 2;
      st.push(v);
      if (v === 1 || v === 2) offBaseline[i]!++;
      if (v === 2) anyCritical[i] = true;
    }
    statuses.set(s.service, st);
  }

  maxEdgeRate = 1;
  for (const e of b.edgeSeries) for (const r of e.rate) if (r !== null && r > maxEdgeRate) maxEdgeRate = r;
  particles = b.edgeSeries.map(() => []);
  spawnDebt = b.edgeSeries.map(() => 0);
  pulses = [];
  lastPulsedFrame = -1;

  const signalText: Record<string, string> = {
    latency_p95: "p95 latency left baseline",
    error_ratio: "error ratio left baseline",
    rate_drop: "request rate fell",
  };
  story = [
    ...b.changes.map((c) => ({
      at: c.at,
      kind: "change" as StoryKind,
      service: c.service,
      text: `${c.kind[0]!.toUpperCase()}${c.kind.slice(1)} · ${c.description}`,
    })),
    ...b.onsets.map((o) => ({
      at: o.at,
      kind: "onset" as StoryKind,
      service: o.service,
      text: `${o.service} · ${signalText[o.signal] ?? o.signal}`,
    })),
    ...b.alerts.map((a) => ({
      at: a.startsAt,
      kind: "alert" as StoryKind,
      service: a.service,
      text: `Alert firing · ${a.name}${a.service ? ` (${a.service})` : ""}`,
    })),
    ...b.alerts
      .filter((a) => a.endsAt !== undefined && a.endsAt <= b.range.end)
      .map((a) => ({ at: a.endsAt!, kind: "resolved" as StoryKind, service: a.service, text: `Alert resolved · ${a.name}` })),
  ].sort((x, y) => x.at - y.at);

  selected = b.focus ?? b.onsets[0]?.service ?? b.services[0]?.id ?? null;
  renderChrome();
  setPlaying(!reducedMotion && b.services.length > 0);
}

// ---------- DOM around the canvas ----------

function renderChrome() {
  const b = B!;
  const mins = Math.round((b.range.end - b.range.start) / 60);
  const day = new Date(b.range.end * 1000).toISOString().slice(0, 10);
  $("meta").textContent = `${clock(b.range.start)} to ${clock(b.range.end)} UTC, ${day} · ${mins} min · ${b.backend}`;

  const empty = b.services.length === 0;
  $("empty").hidden = !empty;
  $("empty").textContent = empty ? "The backend returned no service graph data for this window." : "";
  for (const id of ["main", "controls", "legend", "queries"]) $(id).hidden = empty;
  if (empty) return;

  const sel = $<HTMLSelectElement>("service");
  sel.replaceChildren(
    ...b.services.map((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.id;
      return o;
    }),
  );
  if (selected) sel.value = selected;

  const dl = $("querylist");
  dl.replaceChildren();
  for (const q of b.queries) {
    const dt = document.createElement("dt");
    dt.textContent = q.language === "none" ? q.purpose : `${q.purpose} (${q.language})`;
    const dd = document.createElement("dd");
    const code = document.createElement("code");
    code.textContent = q.query;
    dd.append(code);
    dl.append(dt, dd);
  }

  storyKey = "";
  const tl = $("timeline");
  tl.setAttribute("aria-valuemin", "0");
  tl.setAttribute("aria-valuemax", String(frames - 1));
  resize();
  renderPanel();
}

let panelFrame = -1;
let panelService: string | null = null;

function sparkline(samples: Samples, baseline: number | null, frame: number, stroke: string): string {
  const W = 220;
  const H = 34;
  const vals = samples.filter((v): v is number => v !== null);
  const max = Math.max(...vals, baseline ?? 0, 1e-9);
  const x = (i: number) => (frames <= 1 ? 0 : (i / (frames - 1)) * W);
  const y = (v: number) => H - 2 - (v / max) * (H - 4);
  let d = "";
  let area = "";
  let start = -1;
  const close = (end: number) => {
    if (start >= 0) area += `L${x(end).toFixed(1)} ${H}L${x(start).toFixed(1)} ${H}Z`;
    start = -1;
  };
  samples.forEach((v, i) => {
    if (v === null || v === undefined) {
      close(i - 1);
      return;
    }
    const pt = `${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    d += `${start < 0 ? "M" : "L"}${pt}`;
    area += `${start < 0 ? "M" : "L"}${pt}`;
    if (start < 0) start = i;
  });
  close(samples.length - 1);
  const base =
    baseline === null
      ? ""
      : `<line x1="0" x2="${W}" y1="${y(baseline).toFixed(1)}" y2="${y(baseline).toFixed(1)}" stroke="${colors.edge}" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>`;
  return (
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${base}` +
    `<path d="${area}" fill="${stroke}" opacity="0.16"/>` +
    `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
    `<line x1="${x(frame).toFixed(1)}" x2="${x(frame).toFixed(1)}" y1="0" y2="${H}" stroke="${colors.ink}" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>`
  );
}

function renderPanel() {
  const b = B;
  if (!b || !selected) return;
  const frame = Math.round(pos);
  if (frame === panelFrame && selected === panelService) return;
  panelFrame = frame;
  panelService = selected;

  const ref = b.services.find((s) => s.id === selected);
  const series = b.serviceSeries.find((s) => s.service === selected);
  $("where").textContent = [ref?.kind, ref?.cloud, ref?.cluster].filter(Boolean).join(" · ");
  if (!series) return;
  const base = baselines.get(selected);
  const rows: [string, string, Samples, number | null, string][] = [
    ["p95 latency", fmtLatency(nearest(series.latencyP95, pos)), series.latencyP95, base?.lat ?? null, colors.accent!],
    ["Error ratio", fmtRatio(nearest(series.errorRatio, pos)), series.errorRatio, base?.err ?? null, colors.crit!],
    ["Request rate", fmtRate(nearest(series.rate, pos)), series.rate, null, colors.muted!],
  ];
  $("stats").innerHTML = rows
    .map(
      ([label, value, samples, baseline, stroke]) =>
        `<div class="stat"><div class="stat-head"><span class="stat-label">${label}</span>` +
        `<span class="stat-value">${value}</span></div>${sparkline(samples, baseline, frame, stroke)}</div>`,
    )
    .join("");

  const mine = b.onsets.filter((o) => o.service === selected);
  const ul = $("onsets");
  ul.replaceChildren(
    ...mine.map((o) => {
      const li = document.createElement("li");
      const what =
        o.signal === "latency_p95"
          ? `p95 ${fmtLatency(o.baseline)} to ${fmtLatency(o.peak)}`
          : o.signal === "error_ratio"
            ? `errors ${fmtRatio(o.baseline)} to ${fmtRatio(o.peak)}`
            : `rate ${fmtRate(o.baseline)} to ${fmtRate(o.peak)}`;
      li.textContent = `${clock(o.at)} ${what}`;
      return li;
    }),
  );
}

let storyKey = "";
function renderStory() {
  const b = B!;
  const now = b.range.start + pos * b.range.step;
  let current = -1;
  story.forEach((ev, i) => {
    if (ev.at <= now) current = i;
  });
  const key = String(current);
  if (key === storyKey) return;
  storyKey = key;

  const head = story[current];
  const box = $("story");
  if (!head) {
    box.replaceChildren();
  } else {
    const li = document.createElement("li");
    const dot = document.createElement("i");
    dot.className = `ev-${head.kind}`;
    const t = document.createElement("time");
    t.textContent = clock(head.at);
    const text = document.createElement("span");
    text.textContent = head.text;
    li.append(dot, t, text);
    box.replaceChildren(li);
  }

}

const ICON_PLAY = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M5.5 3.2v11.6a.8.8 0 0 0 1.2.7l9-5.8a.8.8 0 0 0 0-1.4l-9-5.8a.8.8 0 0 0-1.2.7z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 18 18" aria-hidden="true"><rect x="3.5" y="3" width="4" height="12" rx="1.2" fill="currentColor"/><rect x="10.5" y="3" width="4" height="12" rx="1.2" fill="currentColor"/></svg>';

function setPlaying(p: boolean) {
  playing = p;
  const btn = $("play");
  btn.innerHTML = p ? ICON_PAUSE : ICON_PLAY;
  btn.setAttribute("aria-label", p ? "Pause" : "Play");
}

function seek(p: number) {
  pos = Math.min(frames - 1, Math.max(0, p));
  // Pulses belong to forward play; a jump starts them afresh from here.
  lastPulsedFrame = Math.floor(pos);
  pulses = [];
}

// ---------- canvas ----------

const map = $<HTMLCanvasElement>("map");
const track = $<HTMLCanvasElement>("track");
let mapW = 0;
let mapH = 0;
let trackW = 0;
let trackH = 0;

function fit(canvas: HTMLCanvasElement): [number, number] {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  canvas.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [r.width, r.height];
}

function resize() {
  [mapW, mapH] = fit(map);
  [trackW, trackH] = fit(track);
}

/** Left-to-right when there is room, top-to-bottom on a narrow stage. */
function place(id: string): { x: number; y: number } {
  const p = layout.get(id) ?? { lx: 0.5, ly: 0.5 };
  const bottom = 64;
  if (mapW >= 520) {
    const top = 96;
    return { x: 60 + p.lx * (mapW - 120), y: top + p.ly * (mapH - top - bottom) };
  }
  // Extra headroom so the top node's label clears the story lines.
  const top = 128;
  return { x: 16 + p.ly * (mapW - 32), y: top + p.lx * (mapH - top - 64) };
}

function nodeRadius(rate: number | null): number {
  return 13 + 13 * Math.sqrt(Math.max(0, rate ?? 0) / maxNodeRate);
}

function statusColor(s: Status): string {
  return s === 2 ? colors.crit! : s === 1 ? colors.warn! : s === 3 ? colors.muted! : colors.ok!;
}

function drawMap(dt: number) {
  const b = B!;
  const g = map.getContext("2d")!;
  g.clearRect(0, 0, mapW, mapH);
  const frame = Math.round(pos);
  const seriesBy = new Map(b.serviceSeries.map((s) => [s.service, s]));

  // Edges and the traffic on them.
  b.edgeSeries.forEach((e, ei) => {
    const a = place(e.from);
    const c = place(e.to);
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ra = nodeRadius(lerp(seriesBy.get(e.from)?.rate ?? [], pos)) + 3;
    const rc = nodeRadius(lerp(seriesBy.get(e.to)?.rate ?? [], pos)) + 7;
    const x1 = a.x + (dx / len) * ra;
    const y1 = a.y + (dy / len) * ra;
    const x2 = c.x - (dx / len) * rc;
    const y2 = c.y - (dy / len) * rc;
    const mx = (x1 + x2) / 2 - (dy / len) * len * 0.06;
    const my = (y1 + y2) / 2 + (dx / len) * len * 0.06;
    const at = (t: number) => {
      const u = 1 - t;
      return {
        x: u * u * x1 + 2 * u * t * mx + t * t * x2,
        y: u * u * y1 + 2 * u * t * my + t * t * y2,
      };
    };

    const rate = lerp(e.rate, pos);
    const err = lerp(e.errorRatio, pos) ?? 0;
    const heat = Math.min(1, err / 0.2);
    const stroke = mix(colors.edge!, colors.crit!, heat);
    g.strokeStyle = stroke;
    g.lineWidth = 1 + 6 * Math.sqrt(Math.max(0, rate ?? 0) / maxEdgeRate);
    g.globalAlpha = rate === null ? 0.3 : 0.55;
    g.setLineDash(rate === null ? [4, 4] : []);
    g.beginPath();
    g.moveTo(x1, y1);
    g.quadraticCurveTo(mx, my, x2, y2);
    g.stroke();
    g.setLineDash([]);

    // Arrowhead.
    const tip = at(1);
    const back = at(0.94);
    const ang = Math.atan2(tip.y - back.y, tip.x - back.x);
    g.globalAlpha = 0.8;
    g.fillStyle = stroke;
    g.beginPath();
    g.moveTo(tip.x + Math.cos(ang) * 5, tip.y + Math.sin(ang) * 5);
    g.lineTo(tip.x + Math.cos(ang + 2.5) * 6, tip.y + Math.sin(ang + 2.5) * 6);
    g.lineTo(tip.x + Math.cos(ang - 2.5) * 6, tip.y + Math.sin(ang - 2.5) * 6);
    g.fill();
    g.globalAlpha = 1;

    if (reducedMotion) return;
    // Dots: more of them with more traffic, slower as the callee's latency
    // rises, and red in proportion to the error ratio.
    const list = particles[ei]!;
    const lat = lerp(seriesBy.get(e.to)?.latencyP95 ?? [], pos) ?? 0;
    const travel = Math.min(4.5, 0.7 + 1.3 * lat);
    if (rate !== null && rate > 0) {
      spawnDebt[ei]! += dt * (1.2 + 10 * (rate / maxEdgeRate));
      while (spawnDebt[ei]! >= 1 && list.length < 60) {
        spawnDebt[ei]! -= 1;
        list.push({ t: 0, err: Math.random() < err });
      }
      if (list.length >= 60) spawnDebt[ei] = 0;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i]!;
      p.t += dt / travel;
      if (p.t >= 1) {
        list.splice(i, 1);
        continue;
      }
      const q = at(p.t);
      g.fillStyle = p.err ? colors.crit! : colors.accent!;
      g.globalAlpha = 0.22;
      g.beginPath();
      g.arc(q.x, q.y, p.err ? 6.5 : 5.5, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
      g.beginPath();
      g.arc(q.x, q.y, p.err ? 3 : 2.4, 0, Math.PI * 2);
      g.fill();
    }
  });

  // A ring spreads from a service at the moment it leaves baseline.
  if (!reducedMotion) {
    const f = Math.floor(pos);
    if (playing && f > lastPulsedFrame) {
      for (const o of b.onsets) {
        const of = Math.round((o.at - b.range.start) / b.range.step);
        if (of > lastPulsedFrame && of <= f) pulses.push({ service: o.service, age: 0 });
      }
    }
    lastPulsedFrame = Math.max(lastPulsedFrame, f);
    pulses = pulses.filter((p) => (p.age += dt) < 1.6);
    for (const p of pulses) {
      const c = place(p.service);
      g.globalAlpha = 1 - p.age / 1.6;
      g.strokeStyle = colors.warn!;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(c.x, c.y, 26 + p.age * 44, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  // Nodes.
  g.textAlign = "center";
  for (const s of b.services) {
    const series = seriesBy.get(s.id);
    const c = place(s.id);
    const r = nodeRadius(series ? lerp(series.rate, pos) : null);
    const st = statuses.get(s.id)?.[frame] ?? 3;
    const tone = statusColor(st);
    const off = st === 1 || st === 2;
    // A soft halo behind a service that is off baseline.
    if (off) {
      const halo = g.createRadialGradient(c.x, c.y, r, c.x, c.y, r + 22);
      halo.addColorStop(0, mix(colors.surface!, tone, 0.45));
      halo.addColorStop(1, mix(colors.surface!, tone, 0));
      g.globalAlpha = st === 2 ? 0.75 : 0.5;
      g.fillStyle = halo;
      g.beginPath();
      g.arc(c.x, c.y, r + 22, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }
    g.fillStyle = mix(colors.surface!, tone, off ? 0.22 : 0.1);
    g.beginPath();
    g.arc(c.x, c.y, r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = tone;
    g.lineWidth = off ? 3.5 : 2;
    g.setLineDash(st === 3 ? [3, 3] : []);
    g.stroke();
    g.setLineDash([]);
    // The status light at the centre.
    g.fillStyle = tone;
    g.globalAlpha = st === 3 ? 0.4 : 1;
    g.beginPath();
    g.arc(c.x, c.y, Math.max(3, r * 0.24), 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    if (s.id === selected) {
      g.strokeStyle = colors.accent!;
      g.lineWidth = 2;
      g.setLineDash([5, 4]);
      g.beginPath();
      g.arc(c.x, c.y, r + 7, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }

    // The name sits on a plate so edges passing behind do not cut through it.
    g.font = `${s.id === selected ? "650" : "550"} 12px Inter, system-ui, sans-serif`;
    const nameW = g.measureText(s.id).width + 14;
    g.fillStyle = colors.surface!;
    g.globalAlpha = 0.86;
    g.beginPath();
    g.roundRect(c.x - nameW / 2, c.y + r + 6, nameW, 19, 7);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = s.id === selected ? colors.accent! : colors.ink!;
    g.fillText(s.id, c.x, c.y + r + 20);

    // Off baseline: say how, in words, so colour is not the only signal.
    if (series && (st === 1 || st === 2)) {
      const base = baselines.get(s.id);
      const e = nearest(series.errorRatio, pos);
      const l = nearest(series.latencyP95, pos);
      const errOff = e !== null && base?.err !== null && base?.err !== undefined && e > Math.max(3 * base.err, base.err + 0.02);
      const label = errOff ? `${fmtRatio(e)} errors` : `p95 ${fmtLatency(l)}`;
      g.font = "650 11px Inter, system-ui, sans-serif";
      const w = g.measureText(label).width + 16;
      const bx = Math.min(mapW - w - 4, Math.max(4, c.x - w / 2));
      const by = c.y - r - 30;
      g.fillStyle = statusColor(st);
      g.beginPath();
      g.roundRect(bx, by, w, 20, 10);
      g.fill();
      g.fillStyle = colors.surface!;
      g.fillText(label, bx + w / 2, by + 14);
    }
  }
}

function drawTrack() {
  const b = B!;
  const g = track.getContext("2d")!;
  g.clearRect(0, 0, trackW, trackH);
  const pad = 8; // room for the playhead knob at either end
  const w = Math.max(1, trackW - pad * 2);
  const x = (ts: number) => pad + ((ts - b.range.start) / (b.range.end - b.range.start)) * w;
  const stripY = 14;
  const stripH = 14;
  const px = pad + (frames <= 1 ? 0 : (pos / (frames - 1)) * w);

  // Strip: how many services are off baseline at each frame.
  const colW = w / frames;
  const total = Math.max(1, b.services.length);
  g.save();
  g.beginPath();
  g.roundRect(pad, stripY, w, stripH, 5);
  g.clip();
  g.fillStyle = colors.line!;
  g.fillRect(pad, stripY, w, stripH);
  for (let i = 0; i < frames; i++) {
    const n = offBaseline[i]!;
    if (n === 0) continue;
    g.globalAlpha = 0.4 + 0.6 * Math.min(1, n / Math.max(2, total / 2));
    g.fillStyle = anyCritical[i] ? colors.crit! : colors.warn!;
    g.fillRect(pad + i * colW, stripY, Math.ceil(colW), stripH);
  }
  // What has not played yet is dimmed.
  g.globalAlpha = 0.5;
  g.fillStyle = colors.surface!;
  g.fillRect(px, stripY, pad + w - px, stripH);
  g.restore();
  g.globalAlpha = 1;

  // Alerts as bars under the strip, one row each (up to three rows).
  b.alerts.forEach((a, i) => {
    const x1 = Math.max(pad, x(a.startsAt));
    const x2 = Math.min(pad + w, x(a.endsAt ?? b.range.end));
    g.fillStyle = a.severity === "critical" ? colors.crit! : colors.warn!;
    g.beginPath();
    g.roundRect(x1, stripY + stripH + 4 + (i % 3) * 5, Math.max(3, x2 - x1), 3, 1.5);
    g.fill();
  });

  // Changes as markers above the strip.
  g.fillStyle = colors.ink!;
  for (const c of b.changes) {
    const cx = x(c.at);
    g.beginPath();
    g.moveTo(cx - 5, 2);
    g.lineTo(cx + 5, 2);
    g.lineTo(cx, 11);
    g.fill();
  }

  // Time along the bottom.
  g.font = "10px Inter, system-ui, sans-serif";
  g.fillStyle = colors.faint!;
  const ticks = 1;
  for (let i = 0; i <= ticks; i++) {
    const ts = b.range.start + ((b.range.end - b.range.start) * i) / ticks;
    g.textAlign = i === 0 ? "left" : i === ticks ? "right" : "center";
    g.fillText(clock(ts).slice(0, 5), pad + (w * i) / ticks, trackH - 3);
    g.globalAlpha = 0.6;
    g.fillRect(pad + (w * i) / ticks - (i === ticks ? 1 : 0), stripY + stripH + 1, 1, 3);
    g.globalAlpha = 1;
  }

  // Playhead.
  g.strokeStyle = colors.accent!;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(px, 1);
  g.lineTo(px, trackH - 15);
  g.stroke();
  g.fillStyle = colors.accent!;
  g.beginPath();
  g.arc(px, stripY + stripH / 2, 7, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = colors.surface!;
  g.beginPath();
  g.arc(px, stripY + stripH / 2, 3, 0, Math.PI * 2);
  g.fill();
}

let lastTime = 0;
let clockShown = "";
function tick(now: number) {
  requestAnimationFrame(tick);
  if (!B || B.services.length === 0) return;
  const dt = Math.min(0.1, (now - lastTime) / 1000 || 0);
  lastTime = now;
  if (playing && frames > 1) {
    pos += (dt * speed * (frames - 1)) / PLAY_SECONDS;
    if (pos >= frames - 1) {
      pos = frames - 1;
      setPlaying(false);
    }
  }
  drawMap(dt);
  drawTrack();
  renderStory();
  renderPanel();
  const ts = B.range.start + Math.round(pos) * B.range.step;
  const label = clock(ts);
  if (label !== clockShown) {
    clockShown = label;
    $("clock").innerHTML = `${label}<small>UTC</small>`;
  }
  const tl = $("timeline");
  tl.setAttribute("aria-valuenow", String(Math.round(pos)));
  tl.setAttribute("aria-valuetext", `${clock(ts)} UTC`);
}

// ---------- input ----------

function select(id: string) {
  selected = id;
  $<HTMLSelectElement>("service").value = id;
}

function nodeAt(ev: PointerEvent | MouseEvent): string | null {
  if (!B) return null;
  const r = map.getBoundingClientRect();
  const x = ev.clientX - r.left;
  const y = ev.clientY - r.top;
  for (const s of B.services) {
    const c = place(s.id);
    if (Math.hypot(c.x - x, c.y - y) <= 30) return s.id;
  }
  return null;
}

map.addEventListener("click", (ev) => {
  const id = nodeAt(ev);
  if (id) select(id);
});
map.addEventListener("mousemove", (ev) => {
  map.style.cursor = nodeAt(ev) ? "pointer" : "default";
});

$("service").addEventListener("change", (ev) => select((ev.target as HTMLSelectElement).value));
for (const btn of document.querySelectorAll<HTMLElement>("#speed button")) {
  btn.addEventListener("click", () => {
    speed = Number(btn.dataset.speed) || 1;
    for (const other of document.querySelectorAll("#speed button")) {
      other.setAttribute("aria-pressed", String(other === btn));
    }
  });
}

function togglePlay() {
  if (!playing && pos >= frames - 1) seek(0);
  setPlaying(!playing);
}
$("play").addEventListener("click", togglePlay);

const timeline = $("timeline");
function scrub(ev: PointerEvent) {
  const r = timeline.getBoundingClientRect();
  seek(((ev.clientX - r.left - 8) / Math.max(1, r.width - 16)) * (frames - 1));
}
timeline.addEventListener("pointerdown", (ev) => {
  timeline.setPointerCapture(ev.pointerId);
  setPlaying(false);
  scrub(ev);
});
timeline.addEventListener("pointermove", (ev) => {
  if (timeline.hasPointerCapture(ev.pointerId)) scrub(ev);
});
timeline.addEventListener("keydown", (ev) => {
  const jump: Record<string, number> = {
    ArrowLeft: Math.round(pos) - 1,
    ArrowRight: Math.round(pos) + 1,
    Home: 0,
    End: frames - 1,
  };
  if (!(ev.key in jump)) return;
  ev.preventDefault();
  setPlaying(false);
  seek(jump[ev.key]!);
});
document.addEventListener("keydown", (ev) => {
  const tag = (ev.target as HTMLElement).tagName;
  if (ev.key === " " && tag !== "BUTTON" && tag !== "SELECT") {
    ev.preventDefault();
    togglePlay();
  }
});

new ResizeObserver(resize).observe($("stage"));
new ResizeObserver(resize).observe(timeline);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  readColors();
  panelFrame = -1;
});

function setTheme(theme?: string) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  readColors();
  panelFrame = -1;
}

function isBundle(v: unknown): v is ReplayBundle {
  const b = v as ReplayBundle | null;
  return !!b && b.version === 1 && Array.isArray(b.services) && !!b.range;
}

// ---------- start ----------

readColors();
requestAnimationFrame(tick);

const embedded = (window as unknown as { __REPLAY__?: unknown }).__REPLAY__;
if (isBundle(embedded)) {
  // Opened as a plain page with the data inlined.
  prepare(embedded);
  $("nav").hidden = false;
  // `#at=0.4` opens paused 40% of the way through, to link to one moment.
  const at = /[#&]at=([0-9.]+)/.exec(location.hash);
  if (at) {
    setPlaying(false);
    seek(Number(at[1]) * (frames - 1));
  }
} else {
  // Running inside an MCP Apps host: the tool result arrives as a message.
  const app = new App({ name: "Incident replay", version: "0.1.0" }, {});
  app.addEventListener("toolresult", (result) => {
    if (result.isError) {
      $("empty").hidden = false;
      $("empty").textContent = "The replay tool returned an error; see the conversation for details.";
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
        "No data: open this view through the incident_replay tool, or use the preview page.";
    });
}
