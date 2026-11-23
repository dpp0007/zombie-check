// Thin TinyFish client: Fetch, Search, Datasets (TinySet). All calls are live (ttl:0).
const FETCH = "https://api.fetch.tinyfish.ai";
const SEARCH = "https://api.search.tinyfish.ai";
const DS = "https://agent.tinyfish.ai/v1/datasets";

export class TFError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, msg: string) {
    super(msg);
    this.status = status;
    this.code = code;
  }
}
export const fatal = (e: unknown) => e instanceof TFError && (e.status === 401 || e.status === 403 || e.status === 402);

function key() {
  const k = process.env.TINYFISH_API_KEY;
  if (!k) throw new TFError(401, "NO_KEY", "TINYFISH_API_KEY is not set (put it in .env.local)");
  return k;
}

async function call(url: string, init: RequestInit = {}, timeoutMs = 150_000, tries = 4): Promise<any> {
  let last: unknown;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "X-API-Key": key(), "Content-Type": "application/json", ...(init.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return await res.json();
      const body = await res.json().catch(() => ({}));
      const code = body?.error?.code || String(res.status);
      const err = new TFError(res.status, code, body?.error?.message || `${res.status} ${code}`);
      if (res.status === 429 || res.status >= 500) {
        last = err;
        const ra = Number(res.headers.get("retry-after")) || 0;
        await sleep(Math.max(ra * 1000, 1500 * 2 ** a));
        continue;
      }
      throw err;
    } catch (e) {
      if (e instanceof TFError && e.status < 500 && e.status !== 429) throw e;
      last = e;
      await sleep(1500 * 2 ** a);
    }
  }
  throw last instanceof Error ? last : new Error("request failed");
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Page = {
  url: string;
  final_url?: string;
  title?: string | null;
  description?: string | null;
  published_date?: string | null;
  text?: string | null;
  links?: string[];
};

/** Fetch API: live render of up to 10 URLs. Returns pages keyed by requested URL plus errors. */
export async function fetchPages(urls: string[], links = true) {
  const out = new Map<string, Page>();
  const errs = new Map<string, string>();
  for (let i = 0; i < urls.length; i += 10) {
    const batch = urls.slice(i, i + 10);
    const r = await call(FETCH, {
      method: "POST",
      body: JSON.stringify({ urls: batch, format: "markdown", links, ttl: 0, per_url_timeout_ms: 40_000, purpose: "Check whether a company/site/job post is still active (zombie check)" }),
    });
    for (const p of r.results || []) out.set(p.url, p);
    for (const e of r.errors || []) errs.set(e.url, typeof e.error === "string" ? e.error : JSON.stringify(e.error ?? e));
  }
  return { pages: out, errors: errs };
}

export type Hit = { title: string; url: string; snippet: string; site_name?: string; date?: string };

/** Search API: ranked live web results. */
export async function search(query: string, opts: { recencyDays?: number; news?: boolean } = {}): Promise<Hit[]> {
  const p = new URLSearchParams({ query });
  if (opts.recencyDays) p.set("recency_minutes", String(opts.recencyDays * 1440));
  if (opts.news) p.set("domain_type", "news");
  const r = await call(`${SEARCH}?${p}`, { method: "GET" }, 30_000);
  return (r.results || []).map((x: any) => ({
    title: x.title || "",
    url: x.url,
    snippet: x.snippet || "",
    site_name: x.site_name,
    date: x.date || x.published_date || x.published_at || undefined,
  }));
}

// ---- TinySet (Datasets API) ----
export type DsColumn = { name: string; label?: string; type: "string" | "number" | "boolean" | "url" | "date"; is_primary_key: boolean; is_unique?: boolean; retrieval_hint?: string; format?: string };
export type DsSpec = { name: string; description: string; columns: DsColumn[] };

export const createDataset = (spec: DsSpec, target_rows: number) =>
  call(DS, { method: "POST", body: JSON.stringify({ spec, target_rows }) }, 90_000);
export const getDataset = (id: string) => call(`${DS}/${id}`, {}, 30_000);
export const cancelRun = (id: string, runId: string) => call(`${DS}/${id}/runs/${runId}/cancel`, { method: "POST", body: "{}" }, 30_000);
export async function allRows(id: string): Promise<Record<string, any>[]> {
  const rows: Record<string, any>[] = [];
  let after: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await call(`${DS}/${id}/rows?limit=500${after ? `&after=${encodeURIComponent(after)}` : ""}`, {}, 30_000);
    rows.push(...(r.rows || []).map((x: any) => x.data));
    if (!r.truncated || !r.next_cursor) break;
    after = r.next_cursor;
  }
  return rows;
}
