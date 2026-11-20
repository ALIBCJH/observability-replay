import { App } from "@modelcontextprotocol/ext-apps";
import { playEntrance } from "./motion.js";
import {
  CAPPING_CHECKS,
  CHECKS,
  MIN_COVERAGE,
  TEST_PHASES,
  type Area,
  type BenchmarkResult,
  type CheckDef,
  type CheckResult,
  type Outcome,
} from "../src/benchmark.js";

/**
 * The benchmark report: the grade, where the points went, what to fix, the
 * test (if one was run), and every application against every check. It
 * prints only what is in the result.
 */

export interface ReportData {
  kind: "benchmark-report";
  result: BenchmarkResult;
  /** An earlier result to compare with. */
  previous?: BenchmarkResult;
}

type Child = Node | string | null | undefined | false;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children.filter((c): c is Node | string => !!c));
  return el;
}

const defOf = new Map(CHECKS.map((c) => [c.id, c]));
const clock = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16);
const clockS = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 19);
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
/** Start a sentence with a capital, except a unit-like word such as "p95". */
const cap = (s: string) => (/^p\d/.test(s) ? s : s.charAt(0).toUpperCase() + s.slice(1));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- outcome marks ----------

const ICON: Record<Outcome, string> = {
  pass: '<path d="M2.5 7.2l3 3 6-6.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  warn: '<path d="M7 2.6v5.2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="7" cy="11" r="1.3" fill="currentColor"/>',
  fail: '<path d="M3.2 3.2l7.6 7.6M10.8 3.2l-7.6 7.6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  "not measured": '<path d="M4 7h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};
const WORD: Record<Outcome, string> = { pass: "Pass", warn: "Warning", fail: "Fail", "not measured": "Not measured" };
const CLASS: Record<Outcome, string> = { pass: "pass", warn: "warn", fail: "fail", "not measured": "none" };

function mark(outcome: Outcome, small = false): HTMLElement {
  const el = h("span", { class: `mark ${CLASS[outcome]}${small ? " sm" : ""}`, role: "img", "aria-label": WORD[outcome] });
  el.innerHTML = `<svg viewBox="0 0 14 14" aria-hidden="true">${ICON[outcome]}</svg>`;
  return el;
}

/** Green, amber or red for a 0 to 100 score, on the grade boundaries. */
const tone = (score: number) => (score >= 75 ? "ok" : score >= 60 ? "warn" : "crit");

// ---------- hero ----------

function allChecks(b: BenchmarkResult): { app?: string; check: CheckResult }[] {
  return [
    ...b.system.map((check) => ({ check })),
    ...b.apps.flatMap((a) => a.checks.map((check) => ({ app: a.id, check }))),
  ];
}

function hero(d: ReportData): HTMLElement {
  const b = d.result;
  const all = allChecks(b).map((c) => c.check);
  const n = (o: Outcome) => all.filter((c) => c.outcome === o).length;
  const measured = all.length - n("not measured");
  const graded = b.score !== null;

  const verdict = !graded
    ? "Not enough could be measured to give a grade."
    : n("fail") + n("warn") === 0
      ? `Every measured check passes.`
      : `${n("pass")} of ${measured} measured checks pass.`;
  const lede = !graded
    ? `Only ${Math.round(b.coverage * 100)}% of the checks had data; ${Math.round(MIN_COVERAGE * 100)}% are needed. Check that request, container and deploy data reach the backend.`
    : b.cappedBy
      ? `The score is ${b.score} of 100, but a failed "${defOf.get(b.cappedBy)?.title}" check holds the grade at C.`
      : `Scored ${b.score} of 100 against the fixed standard, as the average of the areas that could be measured.`;

  let delta: HTMLElement | null = null;
  const p = d.previous;
  if (p) {
    const diff = p.score !== null && b.score !== null ? b.score - p.score : null;
    delta = h(
      "p",
      { class: "delta" },
      `Previous run, ${day(p.range.end)} ${clock(p.range.end)} UTC: `,
      h("b", {}, `${p.grade}${p.score !== null ? ` (${p.score})` : ""}`),
      diff === null ? "" : diff === 0 ? ", no change in score." : `, ${diff > 0 ? "up" : "down"} ${Math.abs(diff)} since then.`,
    );
  }

  return h(
    "section",
    { class: "card hero" },
    h(
      "div",
      { class: `grade ${graded ? `tone-${tone(b.score!)}` : ""}`, role: "img", "aria-label": graded ? `Grade ${b.grade}` : "No grade" },
      h("b", {}, graded ? b.grade : "–"),
      h("span", {}, graded ? `${b.score} of 100` : "no grade"),
    ),
    h(
      "div",
      {},
      h("p", { class: "verdict" }, verdict),
      h("p", { class: "lede" }, lede),
      delta,
    ),
  );
}

// ---------- areas ----------

const GRADE_TICKS: [number, string][] = [[40, "D"], [60, "C"], [75, "B"], [90, "A"]];

function areas(b: BenchmarkResult): HTMLElement {
  const scale = h("div", { class: "scale", "aria-hidden": "true" });
  for (const [at, letter] of GRADE_TICKS) {
    const s = h("span", {}, letter);
    s.style.left = `${at}%`;
    scale.append(s);
  }
  const rows = b.areas.map((a) => {
    const track = h("div", { class: `track${a.score === null ? " empty" : ""}` });
    if (a.score !== null) {
      const fill = h("i", { class: `tone-${tone(a.score)}` });
      fill.style.width = `${a.score}%`;
      track.append(fill);
      for (const [at] of GRADE_TICKS) {
        const t = h("u");
        t.style.left = `calc(${at}% - 1px)`;
        track.append(t);
      }
    }
    const counts = [a.pass && `${a.pass} pass`, a.warn && `${a.warn} warn`, a.fail && `${a.fail} fail`].filter(Boolean).join(" · ");
    return h(
      "div",
      { class: "area" },
      h("span", { class: "name" }, a.area),
      track,
      h(
        "span",
        { class: "fig" },
        a.score === null ? h("b", { class: "muted" }, "Not measured") : h("b", {}, `${a.score}`),
        h("span", {}, a.score === null ? WHY_EMPTY[a.area](b) : counts),
      ),
    );
  });
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "Score by area"),
    h("p", { class: "sub" }, "Each area counts the same toward the grade. The letters mark where each grade begins."),
    h("div", { class: "areas" }, h("div", { class: "area head" }, h("span"), scale, h("span")), ...rows),
  );
}

const WHY_EMPTY: Record<Area, (b: BenchmarkResult) => string> = {
  availability: (b) => (b.mode === "test" ? "left out of a test run" : "no request data"),
  latency: (b) => (b.mode === "test" ? "left out of a test run" : "no latency data"),
  resources: () => "no container metrics",
  stability: () => "no container metrics",
  changes: () => "no deploys to judge",
  resilience: () => "needs a test run",
};

// ---------- what to fix ----------

function fixes(b: BenchmarkResult): HTMLElement {
  const byCheck = new Map<string, { outcome: Outcome; items: { app?: string; detail: string }[] }>();
  for (const { app, check } of allChecks(b)) {
    if (check.outcome !== "fail" && check.outcome !== "warn") continue;
    const key = `${check.outcome}:${check.id}`;
    if (!byCheck.has(key)) byCheck.set(key, { outcome: check.outcome, items: [] });
    byCheck.get(key)!.items.push({ app, detail: check.detail });
  }
  const groups = [...byCheck.entries()]
    .map(([key, g]) => ({ def: defOf.get(key.split(":")[1]!)!, ...g }))
    // Fails first; among those, the ones that hold the grade down, then the widest.
    .sort(
      (x, y) =>
        Number(y.outcome === "fail") - Number(x.outcome === "fail") ||
        Number(CAPPING_CHECKS.includes(y.def.id)) - Number(CAPPING_CHECKS.includes(x.def.id)) ||
        y.items.length - x.items.length,
    );

  if (groups.length === 0) {
    return h(
      "section",
      { class: "card" },
      h("h2", {}, "What to fix"),
      h("p", { class: "allclear" }, mark("pass"), "Nothing: no measured check failed or warned."),
    );
  }
  const list = h("ul", { class: "fixes" });
  for (const g of groups) {
    const apps = g.items.filter((i) => i.app);
    const same = new Set(g.items.map((i) => i.detail)).size === 1;
    const body = h("div", {}, h("h3", {}, g.def.title));
    if (apps.length > 1) {
      body.append(
        h("p", { class: "who" }, `${WORD[g.outcome]} on ${plural(apps.length, "application")}${same ? `: ${g.items[0]!.detail}.` : "."}`),
        h("p", {}, ...apps.map((i) => h("span", { class: "chip", title: i.detail }, same ? i.app! : `${i.app}: ${i.detail}`))),
      );
    } else {
      const only = g.items[0]!;
      body.append(h("p", { class: "who" }, `${only.app ? `${only.app}: ` : ""}${only.detail}.`));
    }
    body.append(h("p", {}, `The bar: ${g.def.bar}.`));
    list.append(h("li", {}, mark(g.outcome), body));
  }
  return h("section", { class: "card" }, h("h2", {}, "What to fix"), h("p", { class: "sub" }, "Failures first, then warnings. Widest problems at the top."), list);
}

// ---------- the test ----------

function testSection(b: BenchmarkResult): HTMLElement | null {
  const t = b.test;
  if (!t) return null;
  const recovered = t.recoverySeconds !== null;
  const recoveredAt = recovered ? t.restoredAt + t.recoverySeconds! : t.endedAt;
  const spans: [string, string, number, number][] = [
    ["steady", "Steady load", t.startedAt, t.faultAt],
    ["fault", "Fault in place", t.faultAt, t.restoredAt],
    ["recovery", recovered ? "Recovering" : "Did not recover", t.restoredAt, recoveredAt],
  ];
  if (recovered && t.endedAt - recoveredAt > 1) spans.push(["after", "Recovered", recoveredAt, t.endedAt]);
  const phases = h("div", { class: "phases", role: "img", "aria-label": spans.map(([, l, a, z]) => `${l} ${Math.round(z - a)} seconds`).join(", ") });
  const times = h("div", { class: "phase-times", "aria-hidden": "true" });
  for (const [cls, label, from, to] of spans) {
    const seconds = Math.max(1, to - from);
    const length = cls === "after" ? label : `${label} · ${Math.round(to - from)} s`;
    const seg = h("div", { class: `phase ${cls}`, title: `${label}: ${clockS(from)} to ${clockS(to)} UTC` }, length);
    seg.style.flex = `${seconds} 0 0`;
    const tm = h("span", {}, clockS(from));
    tm.style.flex = `${seconds} 0 0`;
    phases.append(seg);
    times.append(tm);
  }

  const by = new Map(b.system.map((c) => [c.id, c]));
  const card = (id: string, value: string) => {
    const c = by.get(id);
    if (!c) return null;
    return h(
      "div",
      { class: "result" },
      h("div", { class: "k" }, mark(c.outcome), defOf.get(id)!.title),
      h("div", { class: "v" }, value),
      h("p", {}, `${cap(c.detail)}. Bar: ${defOf.get(id)!.bar}.`),
    );
  };
  const pct = (ok: number, sent: number) => (sent ? `${((100 * ok) / sent).toFixed(ok === sent ? 0 : 1)}%` : "no data");
  const ms = (s: number | null) => (s === null ? "no data" : s >= 1 ? `${s.toFixed(2)} s` : `${Math.round(s * 1000)} ms`);
  const seenBy = by.get("resilience.detected");

  return h(
    "section",
    { class: "card" },
    h("h2", {}, "The test"),
    h(
      "p",
      { class: "sub" },
      `${t.ratePerSecond} requests per second to ${t.target}. Fault: ${t.fault}. ` +
        `While it was in place, ${t.duringFault.ok} of ${t.duringFault.sent} requests succeeded. ` +
        `Every test uses the same timings: ${TEST_PHASES.steadySeconds} s steady, ${TEST_PHASES.faultSeconds} s of fault, up to ${TEST_PHASES.recoveryLimitSeconds} s to recover.`,
    ),
    phases,
    times,
    // On a narrow screen the labels do not fit inside the bar; this line replaces them.
    h("p", { class: "phase-caption" }, spans.map(([, l, a, z]) => `${l} ${Math.round(z - a)} s`).join(" · ")),
    h(
      "div",
      { class: "results" },
      card("resilience.steady_success", pct(t.steady.ok, t.steady.sent)),
      card("resilience.steady_latency", ms(t.steady.p95)),
      card("resilience.recovery", recovered ? `${Math.round(t.recoverySeconds!)} s` : "never"),
      card("resilience.detected", seenBy?.outcome === "pass" ? "Seen" : seenBy?.outcome === "fail" ? "Missed" : "no data"),
    ),
  );
}

// ---------- applications by check ----------

const tip = () => $("tip");
function showTip(target: HTMLElement, app: string, def: CheckDef, c: CheckResult) {
  const el = tip();
  el.replaceChildren(h("b", {}, `${app} · ${def.title}`), `${WORD[c.outcome]}: ${c.detail}.`, h("i", {}, `Bar: ${def.bar}.`));
  el.hidden = false;
  const r = target.getBoundingClientRect();
  const w = el.offsetWidth;
  const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
  const above = r.top - el.offsetHeight - 8;
  el.style.left = `${left}px`;
  el.style.top = `${above > 8 ? above : r.bottom + 8}px`;
}

function grid(b: BenchmarkResult): HTMLElement {
  const cols = CHECKS.filter((c) => c.scope === "app");
  const head = h("tr", {}, h("th", { scope: "col" }));
  cols.forEach((c, i) => {
    const first = i === 0 || cols[i - 1]!.area !== c.area;
    head.append(h("th", { scope: "col", class: first ? "group-start" : "", title: c.title }, h("em", {}, first ? c.area : " "), c.short));
  });
  const body = h("tbody");
  // Worst first: most fails, then most warnings.
  const count = (a: BenchmarkResult["apps"][number], o: Outcome) => a.checks.filter((c) => c.outcome === o).length;
  const apps = [...b.apps].sort((x, y) => count(y, "fail") - count(x, "fail") || count(y, "warn") - count(x, "warn") || x.id.localeCompare(y.id));
  for (const a of apps) {
    const attention = count(a, "fail") + count(a, "warn");
    const row = h("tr", {}, h("th", { scope: "row" }, a.id, h("small", {}, attention ? `${attention} to look at` : "all clear")));
    cols.forEach((def, i) => {
      const c = a.checks.find((x) => x.id === def.id) ?? { id: def.id, outcome: "not measured" as Outcome, detail: "not checked" };
      const btn = h("button", { type: "button", "aria-label": `${a.id}, ${def.title}: ${WORD[c.outcome]}, ${c.detail}` }, mark(c.outcome));
      const show = () => showTip(btn, a.id, def, c);
      const hide = () => (tip().hidden = true);
      btn.addEventListener("pointerenter", show);
      btn.addEventListener("pointerleave", hide);
      btn.addEventListener("focus", show);
      btn.addEventListener("blur", hide);
      const first = i === 0 || cols[i - 1]!.area !== def.area;
      row.append(h("td", first ? { class: "group-start" } : {}, btn));
    });
    body.append(row);
  }
  const legend = h("div", { class: "legend" });
  for (const o of ["pass", "warn", "fail", "not measured"] as Outcome[]) legend.append(h("span", {}, mark(o, true), WORD[o]));
  return h(
    "details",
    { class: "card standard" },
    h("summary", {}, "Every application, every check"),
    h("p", { class: "sub" }, `${plural(b.apps.length, "application")}, worst first. Point at a mark to see what was measured.`),
    h("div", { class: "grid-wrap" }, h("table", { class: "grid" }, h("thead", {}, head), body)),
    legend,
  );
}

// ---------- compared with the previous run ----------

function changes(d: ReportData): HTMLElement | null {
  const p = d.previous;
  if (!p) return null;
  const flat = (b: BenchmarkResult) => new Map(allChecks(b).map(({ app, check }) => [`${app ?? ""}|${check.id}`, { app, check }]));
  const was = flat(p);
  const moved = [...flat(d.result).entries()].flatMap(([key, now]) => {
    const old = was.get(key);
    return old && old.check.outcome !== now.check.outcome ? [{ ...now, old: old.check.outcome }] : [];
  });
  const notes: string[] = [];
  if (p.standard.version !== d.result.standard.version) notes.push("The two runs used different versions of the standard, so they are not directly comparable.");
  if (p.mode !== d.result.mode) notes.push("The two runs used different modes, so different checks were measured.");
  const list = h("ul", { class: "changes" });
  for (const m of moved) {
    list.append(
      h(
        "li",
        {},
        mark(m.old),
        h("span", { class: "arrow", "aria-hidden": "true" }, "→"),
        mark(m.check.outcome),
        h("span", { class: "what" }, `${m.app ? `${m.app}: ` : ""}${defOf.get(m.check.id)?.title ?? m.check.id}`, h("small", {}, `${WORD[m.old]} before, ${WORD[m.check.outcome].toLowerCase()} now: ${m.check.detail}.`)),
      ),
    );
  }
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "Since the previous run"),
    h("p", { class: "sub" }, `Compared with the ${p.mode} run ending ${day(p.range.end)} ${clock(p.range.end)} UTC. ${notes.join(" ")}`),
    moved.length ? list : h("p", { class: "allclear" }, mark("not measured"), "No check changed its outcome."),
  );
}

// ---------- the standard ----------

function standard(b: BenchmarkResult): HTMLElement {
  const rows = CHECKS.map((c) => h("tr", {}, h("td", { style: "text-transform:capitalize" }, c.area), h("td", {}, c.title), h("td", {}, c.bar)));
  return h(
    "details",
    { class: "card standard" },
    h("summary", {}, `The standard: ${b.standard.id} v${b.standard.version}`),
    h(
      "div",
      { class: "table-wrap" },
      h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Area"), h("th", {}, "Check"), h("th", {}, "The bar"))), h("tbody", {}, ...rows)),
    ),
  );
}

// ---------- page ----------

function render(d: ReportData) {
  const b = d.result;
  playEntrance();
  const minutes = Math.round((b.range.end - b.range.start) / 60);
  $("title").textContent = b.test ? `${b.test.plan}: resilience test` : "System health";
  $("meta").replaceChildren(
    `${b.mode === "test" ? "Test" : "Observe"} mode · backend ${b.backend}`,
    h("br"),
    `${day(b.range.end)}, ${clock(b.range.start)} to ${clock(b.range.end)} UTC (${minutes} min)`,
  );
  $("report").replaceChildren(
    ...[
      hero(d),
      areas(b),
      fixes(b),
      testSection(b),
      changes(d),
      grid(b),
      standard(b),
      h("p", { class: "foot" }, "The bars are fixed by the standard and are the same for every system. Checks that could not be measured count neither for nor against the grade."),
    ].filter((n): n is HTMLElement => !!n),
  );
  $("report").hidden = false;
  $("empty").hidden = true;
}

function setTheme(theme?: string) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
}

function isReport(v: unknown): v is ReportData {
  const d = v as ReportData | null;
  return !!d && d.kind === "benchmark-report" && !!d.result && Array.isArray(d.result.apps);
}

const embedded = (window as unknown as { __BENCHMARK__?: unknown }).__BENCHMARK__;
if (isReport(embedded)) {
  // Only the preview sits beside the other two pages; a saved report stands alone.
  $("nav").hidden = !/benchmark-preview\.html$/.test(location.pathname);
  render(embedded);
} else {
  const app = new App({ name: "Benchmark report", version: "0.1.0" }, {});
  app.addEventListener("toolresult", (result) => {
    if (result.isError) {
      $("empty").hidden = false;
      $("empty").textContent = "The benchmark tool returned an error; see the conversation for details.";
    } else if (isReport(result.structuredContent)) {
      render(result.structuredContent);
    }
  });
  app.addEventListener("hostcontextchanged", (ctx) => setTheme(ctx.theme));
  app
    .connect()
    .then(() => setTheme(app.getHostContext()?.theme))
    .catch(() => {
      $("empty").hidden = false;
      $("empty").textContent = "No data: open this view through the benchmark tool, or open a saved report.";
    });
}
