import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { checkRow, reEvaluate, type RowResult, type Sig, regDomain, normUrl } from "./check.ts";
import { fatal, sleep, createDataset, getDataset, allRows, type DsSpec, cancelRun } from "./tf.ts";
import { parseDate, iso } from "./dates.ts";
import { toCsv } from "./csv.ts";

export type Opts = { nameCol: string; urlCol: string; jobMode: boolean; concurrency: number; deep: boolean; deepMax: number };
export type Row = { i: number; cells: Record<string, string>; state: "pending" | "done" | "error"; result?: RowResult; error?: string; deep?: boolean };
export type Chunk = { rows: number[]; datasetId?: string; runId?: string; state: "todo" | "running" | "applied" | "failed"; note?: string };
export type Job = {
  id: string;
  name: string;
  createdAt: string;
  status: "ready" | "running" | "paused" | "done" | "error";
  stage: "checks" | "tinyset" | "finished";
  headers: string[];
  opts: Opts;
  rows: Row[];
  chunks: Chunk[];
  message?: string;
};

const DIR = path.join(process.cwd(), ".data", "jobs");
const file = (id: string) => path.join(DIR, `${id}.json`);
const G = globalThis as any;
const live: Map<string, Job> = (G.__zjobs ||= new Map());
const stops: Map<string, boolean> = (G.__zstops ||= new Map());

function save(j: Job) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = file(j.id) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(j));
  fs.renameSync(tmp, file(j.id)); // atomic: a crash never leaves a half-written job
}
export function getJob(id: string): Job | undefined {
  if (!/^[\w-]+$/.test(id)) return;
  const hit = live.get(id);
  if (hit) return hit;
  if (!fs.existsSync(file(id))) return;
  const j: Job = JSON.parse(fs.readFileSync(file(id), "utf8"));
  if (j.status === "running") j.status = "paused"; // server restarted mid-run -> resumable
  live.set(id, j);
  return j;
}
export function listJobs() {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => getJob(f.slice(0, -5)))
    .filter(Boolean)
    .map((j) => ({ id: j!.id, name: j!.name, status: j!.status, createdAt: j!.createdAt, total: j!.rows.length, done: j!.rows.filter((r) => r.state !== "pending").length }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function createJob(name: string, headers: string[], rows: Record<string, string>[], opts: Opts): Job {
  const j: Job = { id: randomUUID().slice(0, 8), name, createdAt: new Date().toISOString(), status: "ready", stage: "checks", headers, opts, chunks: [], rows: rows.map((cells, i) => ({ i, cells, state: "pending" })) };
  live.set(j.id, j);
  save(j);
  return j;
}

const inputOf = (j: Job, r: Row) => ({ name: (r.cells[j.opts.nameCol] || "").trim(), url: (r.cells[j.opts.urlCol] || "").trim(), jobMode: j.opts.jobMode });

export function startJob(id: string, opts?: Partial<Opts>) {
  const j = getJob(id);
  if (!j) throw new Error("job not found");
  if (opts) j.opts = { ...j.opts, ...opts };
  if (j.status === "running") return (stops.set(id, false), j); // resumed while the paused loop was still draining
  // resume: rows that errored are retried; finished rows are never redone
  j.rows.forEach((r) => r.state === "error" && ((r.state = "pending"), delete r.error));
  j.status = "running";
  j.message = undefined;
  stops.set(id, false);
  save(j);
  void run(j).catch((e) => {
    j.status = "error";
    j.message = String(e?.message || e);
    save(j);
  });
  return j;
}
export function resetJob(id: string) {
  const j = getJob(id);
  if (!j || j.status === "running") throw new Error("pause the job before re-checking");
  j.rows.forEach((r) => ((r.state = "pending"), delete r.result, delete r.error, delete r.deep));
  j.chunks = [];
  j.stage = "checks";
  j.status = "ready";
  j.message = undefined;
  save(j);
}
export const pauseJob = (id: string) => stops.set(id, true);

async function run(j: Job) {
  const stopped = () => stops.get(j.id) === true;
  if (j.stage === "checks") {
    const queue = j.rows.filter((r) => r.state === "pending");
    let sinceSave = 0;
    let abort: Error | undefined;
    const worker = async () => {
      while (!stopped() && !abort) {
        const r = queue.shift();
        if (!r) return;
        try {
          r.result = await checkRow(inputOf(j, r));
          r.state = "done";
        } catch (e: any) {
          if (fatal(e)) {
            abort = e;
            queue.unshift(r);
            return;
          }
          r.state = "error";
          r.error = String(e?.message || e).slice(0, 300);
        }
        if (++sinceSave >= 5) ((sinceSave = 0), save(j));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(16, j.opts.concurrency)) }, worker));
    if (abort) {
      j.status = "error";
      j.message = `TinyFish rejected the request: ${abort.message}`;
      return save(j);
    }
    if (stopped()) {
      j.status = "paused";
      return save(j);
    }
    j.stage = "tinyset";
    save(j);
  }
  if (j.stage === "tinyset") {
    if (j.opts.deep) await deepVerify(j, stopped);
    if (stopped()) {
      j.status = "paused";
      return save(j);
    }
    j.stage = "finished";
  }
  j.status = "done";
  save(j);
}

// ---------------- TinySet deep verification ----------------
const CHUNK = 40;
const SPEC: DsSpec = {
  name: "Signs of life",
  description: "One row per listed company/site domain, with the latest verifiable signs of activity found on live pages",
  columns: [
    { name: "domain", label: "Domain", type: "string", is_primary_key: true, is_unique: true, format: "Exactly the domain or github.com/owner/repo path given in the prompt, lowercase, no scheme" },
    { name: "latest_post_date", label: "Latest blog/news post", type: "date", is_primary_key: false, retrieval_hint: "Date of the newest post on the company's own blog, news or press page" },
    { name: "latest_post_url", label: "Latest post URL", type: "url", is_primary_key: false },
    { name: "latest_release_date", label: "Latest release/changelog", type: "date", is_primary_key: false, retrieval_hint: "Date of the newest release, version or changelog entry (GitHub releases count)" },
    { name: "open_jobs", label: "Open jobs", type: "number", is_primary_key: false, retrieval_hint: "Count of currently open job postings on the careers page or its job board; 0 if none" },
    { name: "last_social_date", label: "Last social post", type: "date", is_primary_key: false, retrieval_hint: "Date of the most recent public post on X, LinkedIn, YouTube or GitHub for the company" },
    { name: "social_url", label: "Social URL", type: "url", is_primary_key: false },
    { name: "signup_works", label: "Sign-up works", type: "boolean", is_primary_key: false, retrieval_hint: "true if the public sign-up / get-started / waitlist page is reachable and accepting new users" },
    { name: "source_url", label: "Source URL", type: "url", is_primary_key: false, retrieval_hint: "The page where the newest dated activity above was found (post, release, jobs or sign-up page)" },
    { name: "status_note", label: "Status note", type: "string", is_primary_key: false, retrieval_hint: "If the company or project was acquired, rebranded, merged, parked, shut down, deprecated or abandoned, say so and name the successor; else 'active'" },
  ],
};

async function deepVerify(j: Job, stopped: () => boolean) {
  if (!j.chunks.length) {
    const cand = j.rows
      .filter((r) => r.result && !j.opts.jobMode && !r.deep && !r.result.flags.parked && !r.result.flags.invalid && wantsDeep(r, j))
      .sort((a, b) => Math.abs(a.result!.score - 4.5) - Math.abs(b.result!.score - 4.5)) // most ambiguous first
      .slice(0, j.opts.deepMax);
    for (let k = 0; k < cand.length; k += CHUNK) j.chunks.push({ rows: cand.slice(k, k + CHUNK).map((r) => r.i), state: "todo" });
    save(j);
  }
  const todo = j.chunks.filter((c) => c.state === "todo" || c.state === "running");
  const worker = async () => {
    while (!stopped()) {
      const c = todo.shift();
      if (!c) return;
      try {
        await runChunk(j, c, stopped);
      } catch (e: any) {
        c.state = "failed";
        c.note = String(e?.message || e).slice(0, 300);
        if (fatal(e)) j.message = `TinySet unavailable: ${c.note}`;
      }
      save(j);
    }
  };
  await Promise.all([worker(), worker(), worker()]); // TinySet allows 3 runs per account
}

// Every real company/site row is deep-verified. Plain GitHub repos only when the sweep is unsure (not a confident "alive").
const wantsDeep = (r: Row, j: Job) => {
  const d = domOf(r, j);
  if (!d) return false;
  if (/^github\.com\/[^/]+\/[^/]+/.test(d)) return r.result!.verdict !== "alive" || r.result!.confidence !== "high";
  return !CODE_HOST.test(d);
};
const CODE_HOST = /(^|\.)(github\.com|gitlab\.com|huggingface\.co|drive\.google\.com|docs\.google\.com|notion\.site|onrender\.com|vercel\.app|netlify\.app|github\.io|herokuapp\.com|streamlit\.app|pages\.dev)$/i;
const domOf = (r: Row, j: Job) => {
  try {
    const u = new URL(r.result?.effectiveUrl || normUrl(r.cells[j.opts.urlCol] || ""));
    const h = u.hostname.replace(/^www\./, "").toLowerCase();
    const seg = u.pathname.split("/").filter(Boolean);
    return h === "github.com" && seg.length >= 2 ? `github.com/${seg[0]}/${seg[1].replace(/\.git$/, "")}`.toLowerCase() : h;
  } catch {
    return "";
  }
};

async function runChunk(j: Job, c: Chunk, stopped: () => boolean) {
  const rows = c.rows.map((i) => j.rows[i]);
  const doms = rows.map((r) => domOf(r, j));
  if (!c.datasetId) {
    const prompt = `Research EXACTLY these ${doms.length} entries (a bare domain, or a github.com/owner/repo project path), one row each, using the entry text verbatim as the key, and do not add any other rows: ${doms.filter(Boolean).join(", ")}.`;
    for (let a = 0; ; a++) {
      try {
        const ds = await createDataset({ ...SPEC, description: `${SPEC.description}. ${prompt} Only use values you can verify on live pages; leave a cell empty rather than guess.` }, doms.length);
        c.datasetId = ds.id;
        c.runId = ds.run?.id;
        c.state = "running";
        save(j);
        break;
      } catch (e: any) {
        if (a < 20 && (e?.status === 429 || e?.status === 409 || e?.status === 503)) await sleep(30_000);
        else throw e;
      }
    }
  }
  const start = Date.now();
  for (;;) {
    if (stopped()) return; // stays "running"; resume re-attaches to the same dataset
    const d = await getDataset(c.datasetId!);
    if (d.status !== "populating") {
      if (d.status === "failed" || d.status === "cancelled") c.note = d.run?.error || d.status;
      break;
    }
    if (Date.now() - start > 40 * 60_000) {
      if (c.runId) await cancelRun(c.datasetId!, c.runId).catch(() => {});
      c.note = "timed out; used rows landed so far";
      break;
    }
    await sleep(15_000);
  }
  const got = await allRows(c.datasetId!);
  const keyOf = (x: string) => x.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#]*$/, "");
  const byDom = new Map(got.map((g) => [keyOf(String(g.domain || Object.values(g)[0] || "")), g]));
  for (const r of rows) {
    const k = domOf(r, j);
    const g = byDom.get(k) || byDom.get(k.replace(/\/.*$/, "")) || byDom.get(regDomain(k.replace(/\/.*$/, "")));
    if (g && r.result) applyTinySet(r, g);
  }
  c.state = "applied";
}

/** TinySet may re-plan column names, so read cells by type + keyword rather than exact name. */
function pickCell(g: Record<string, any>, re: RegExp, type?: string) {
  for (const [k, v] of Object.entries(g)) if (re.test(k) && v !== null && v !== "" && (!type || typeof v === type)) return v;
}
function applyTinySet(r: Row, raw: Record<string, any>) {
  const res = r.result!;
  const g = {
    latest_post_date: pickCell(raw, /(post|blog|news)(?!.*url)/i), latest_post_url: pickCell(raw, /(post|blog|news).*url|url.*(post|blog|news)/i),
    latest_release_date: pickCell(raw, /(release|changelog)/i), last_social_date: pickCell(raw, /social(?!.*url)/i), social_url: pickCell(raw, /social.*url|url.*social/i),
    source_url: pickCell(raw, /(source|evidence|proof)/i), open_jobs: pickCell(raw, /job/i, "number"), signup_works: pickCell(raw, /sign.?up/i, "boolean"), status_note: pickCell(raw, /(status|note)/i) || "",
  } as Record<string, any>;
  const add = (s: Sig) => res.signals.push(s);
  const post = parseDate(g.latest_post_date), rel = parseDate(g.latest_release_date), soc = parseDate(g.last_social_date);
  const fresh = (d?: Date) => (d && Date.now() - +d < 365 * 864e5 ? "fresh" : d ? "stale" : "none");
  const u = (x: unknown) => (typeof x === "string" && /^https?:\/\//.test(x) ? x : undefined);
  const src = u(g.source_url);
  if (post) add({ id: "blog", state: fresh(post), date: iso(post), url: u(g.latest_post_url) || src, note: "TinySet: latest post" });
  if (rel) add({ id: "release", state: fresh(rel), date: iso(rel), url: src, note: "TinySet: latest release" });
  if (soc) add({ id: "social", state: fresh(soc), date: iso(soc), url: u(g.social_url), note: "TinySet: social activity" });
  if (typeof g.open_jobs === "number" && g.open_jobs > 0) add({ id: "jobs", state: "fresh", url: src, note: `TinySet: ${g.open_jobs} open jobs` });
  if (g.signup_works === true) add({ id: "signup", state: "fresh", url: src, note: "TinySet: sign-up works" });
  const note = String(g.status_note || "");
  if (note) add({ id: "site", state: "unknown", url: src, note: `TinySet: ${note.slice(0, 220)}` });
  if (/(acquired|shut ?down|defunct|ceased|sunset|discontinued|deprecated|unmaintained|abandoned|no longer maintained|end of life)/i.test(note) && !/^active/i.test(note) && !/(continues?|still|remains?) (to )?(operat|active|available|running)|operating (under|as)/i.test(note)) res.flags.closed = `TinySet: ${note.slice(0, 120)}`;
  else if (/(rebrand|renamed|now known|merged)/i.test(note)) res.flags.moved = `TinySet: ${note.slice(0, 120)}`;
  r.result = { ...reEvaluate(res), effectiveUrl: res.effectiveUrl };
  r.deep = true;
}

// ---------------- Output ----------------
export const NEW_COLS = ["zombie_verdict", "zombie_confidence", "latest_activity_date", "evidence_links", "signals_found", "verdict_reasons", "notes_redirect_acquisition", "checked_url", "checked_at", "tinyset_verified"];

export function outputRows(j: Job) {
  return j.rows.map((r) => {
    const x = r.result;
    const base = { ...r.cells };
    if (!x) return { ...base, zombie_verdict: r.state === "error" ? "error" : "pending", verdict_reasons: r.error || "" };
    const ev = [...new Set(x.signals.filter((s) => s.url && (s.state === "fresh" || s.state === "stale" || s.state === "bad" || s.id === "site")).map((s) => s.url!))].slice(0, 6);
    return {
      ...base,
      zombie_verdict: x.verdict,
      zombie_confidence: x.confidence,
      latest_activity_date: x.latest || "",
      evidence_links: ev.join(" | "),
      signals_found: x.signals.filter((s) => s.state !== "unknown" || s.note?.startsWith("©")).map((s) => `${s.id}:${s.state}${s.date ? "@" + s.date : ""}${s.note ? " (" + s.note + ")" : ""}`).join("; "),
      verdict_reasons: x.reasons.join("; "),
      notes_redirect_acquisition: [x.flags.parked && "parked domain", x.flags.moved, x.flags.closed, x.flags.ghost].filter(Boolean).join("; "),
      checked_url: x.effectiveUrl || "",
      checked_at: x.checkedAt,
      tinyset_verified: r.deep ? "yes" : "no",
    };
  });
}
export const jobCsv = (j: Job) => toCsv([...j.headers.filter((h) => !NEW_COLS.includes(h)), ...NEW_COLS], outputRows(j) as any);

export function summary(j: Job) {
  const n = { alive: 0, slowing: 0, zombie: 0, pending: 0, error: 0 };
  j.rows.forEach((r) => (r.result ? n[r.result.verdict]++ : n[r.state === "error" ? "error" : "pending"]++));
  return n;
}

// ---------------- XLSX export ----------------
export async function jobXlsx(j: Job): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const cols = [...j.headers.filter((h) => !NEW_COLS.includes(h)), ...NEW_COLS];
  const out = outputRows(j) as Record<string, string>[];
  const ws = wb.addWorksheet("Checked list", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c, key: c, width: NEW_COLS.includes(c) ? (c === "evidence_links" || c === "signals_found" || c === "verdict_reasons" ? 60 : 22) : 26 }));
  out.forEach((r) => ws.addRow(cols.map((c) => r[c] ?? "")));
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  const fill: Record<string, string> = { alive: "FFC6EFCE", slowing: "FFFFEB9C", zombie: "FFFFC7CE" };
  const vi = cols.indexOf("zombie_verdict") + 1;
  const ei = cols.indexOf("evidence_links") + 1;
  out.forEach((r, k) => {
    const row = ws.getRow(k + 2);
    const f = fill[r.zombie_verdict];
    if (f) row.getCell(vi).fill = { type: "pattern", pattern: "solid", fgColor: { argb: f } };
    const first = (r.evidence_links || "").split(" | ")[0];
    if (first) row.getCell(ei).value = { text: r.evidence_links, hyperlink: first };
  });
  const sm = wb.addWorksheet("Summary");
  const n = summary(j);
  const total = j.rows.length;
  const conf = { high: 0, medium: 0, low: 0 } as Record<string, number>;
  const sigs: Record<string, number> = {};
  let ts = 0;
  for (const r of j.rows) {
    if (!r.result) continue;
    conf[r.result.confidence]++;
    if (r.deep) ts++;
    for (const id of new Set(r.result.signals.filter((s) => s.state === "fresh" || s.state === "stale").map((s) => s.id))) sigs[id] = (sigs[id] || 0) + 1;
  }
  const lines: (string | number)[][] = [
    ["Zombie Check summary"], ["List", j.name], ["Rows", total], ["Mode", j.opts.jobMode ? "ghost-job posts" : "companies / tools / repos"], [],
    ["Verdict", "Rows", "Share"],
    ...(["alive", "slowing", "zombie"] as const).map((v) => [v, n[v], total ? `${Math.round((100 * n[v]) / total)}%` : ""]),
    ["pending / error", n.pending + n.error, ""], [],
    ["Confidence", "Rows"], ["high", conf.high], ["medium", conf.medium], ["low", conf.low], [],
    ["Rows verified by TinySet", ts], [],
    ["Signal", "Rows where it produced a dated or live reading"],
    ...Object.entries(sigs).sort((a, b) => b[1] - a[1]),
  ];
  lines.forEach((l) => sm.addRow(l));
  sm.getRow(1).font = { bold: true, size: 14 };
  sm.getColumn(1).width = 34;
  sm.getColumn(2).width = 40;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
