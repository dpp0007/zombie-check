import Papa from "papaparse";

export type Table = { headers: string[]; rows: Record<string, string>[] };

export function parseCsv(text: string): Table {
  const r = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
  const headers = (r.meta.fields || []).filter(Boolean);
  return { headers, rows: r.data.map((x) => Object.fromEntries(headers.map((h) => [h, String(x[h] ?? "")]))) };
}
export const toCsv = (headers: string[], rows: Record<string, string>[]) => Papa.unparse({ fields: headers, data: rows.map((r) => headers.map((h) => r[h] ?? "")) });

const URL_H = /(^|_|\s)(url|website|site|domain|link|homepage|web)(\s|_|$)/i;
const NAME_H = /(^|_|\s)(name|company|title|tool|vendor|product|organization|org)(\s|_|$)/i;
const JOB_H = /(job|posting|apply|role|position)/i;

/** Guess which column is the name, which is the URL, and whether the list is job posts. */
export function detectColumns(t: Table) {
  const sample = t.rows.slice(0, 50);
  const urlish = (h: string) => sample.filter((r) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/|$|\?)/i.test((r[h] || "").trim())).length;
  const urlCol = t.headers.filter((h) => urlish(h) >= sample.length * 0.5).sort((a, b) => Number(URL_H.test(b)) - Number(URL_H.test(a)))[0] || t.headers.find((h) => URL_H.test(h)) || "";
  const nameCol = t.headers.find((h) => NAME_H.test(h) && h !== urlCol) || t.headers.find((h) => h !== urlCol) || "";
  const jobs = sample.filter((r) => /(greenhouse\.io\/.+\/jobs|lever\.co\/.+\/.{8}|ashbyhq\.com\/.+\/.{8}|linkedin\.com\/jobs|\/jobs?\/|\/careers?\/.+|indeed\.com\/viewjob|workable\.com\/.+\/j\/)/i.test(r[urlCol] || "")).length;
  const jobMode = (!!urlCol && jobs >= sample.length * 0.5) || (JOB_H.test(urlCol) && jobs > 0);
  return { urlCol, nameCol, jobMode };
}

/** Turn any supported source URL into a Table: Google Sheet, raw CSV, or a GitHub "awesome" README (markdown links). */
export async function loadSource(src: string): Promise<Table> {
  src = src.trim();
  const g = src.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)(?:.*[?#&]gid=(\d+))?/);
  if (g) src = `https://docs.google.com/spreadsheets/d/${g[1]}/export?format=csv${g[2] ? `&gid=${g[2]}` : ""}`;
  const gh = src.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/blob\/([^/]+)\/(.+))?\/?$/);
  if (gh) src = `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3] || "HEAD"}/${gh[4] || "README.md"}`;
  const get = (u: string) => fetch(u, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
  let res = await get(src);
  if (!res.ok && gh && !gh[4]) for (const n of ["readme.md", "Readme.md"]) { res = await get(src.replace(/README\.md$/, n)); if (res.ok) break; }
  if (!res.ok) throw new Error(`Could not download source (${res.status}). Google Sheets must be shared as "anyone with the link".`);
  const text = await res.text();
  if (/\.(md|markdown)(\?|$)/i.test(src) || /raw\.githubusercontent/.test(src)) return fromMarkdown(text);
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error("Source returned HTML, not CSV. Share the sheet publicly or paste the export URL.");
  return parseCsv(text);
}

/** `- [Name](https://x.com) - description` lines -> rows. Skips badges, anchors and github-internal links. */
export function fromMarkdown(md: string): Table {
  const rows: Record<string, string>[] = [];
  const seen = new Set<string>();
  let section = "";
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^#{2,4}\s+(.+)/);
    if (h) section = h[1].replace(/[\[\]*`]/g, "").trim();
    const m = line.match(/^\s*[-*+]\s+\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*[-–—:]?\s*(.*)$/);
    if (!m) continue;
    const url = m[2];
    if (/(shields\.io|img\.shields|badge|#|creativecommons|\/issues|\/pulls|\/blob\/|\/tree\/|\/wiki)/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    rows.push({ name: m[1].trim(), url, section, description: m[3].replace(/[*_`]/g, "").slice(0, 200) });
  }
  return { headers: ["name", "url", "section", "description"], rows };
}
