import { fetchPages, search, type Page } from "./tf.ts";
import { extractDates, relativeDates, newest, iso, ageDays, parseDate } from "./dates.ts";

export type Verdict = "alive" | "slowing" | "zombie";
export type Sig = {
  id: "site" | "sitemap" | "repo" | "blog" | "release" | "jobs" | "social" | "signup" | "mentions" | "tinyset";
  state: "fresh" | "stale" | "none" | "unknown" | "bad";
  date?: string; // ISO yyyy-mm-dd of latest activity
  url?: string; // evidence link
  note?: string;
};
export type Flags = { invalid?: boolean; transient?: boolean; parked?: boolean; closed?: string; moved?: string; unreachable?: boolean; ghost?: string };
export type RowResult = {
  verdict: Verdict;
  confidence: "high" | "medium" | "low";
  score: number;
  latest?: string;
  effectiveUrl?: string;
  signals: Sig[];
  flags: Flags;
  reasons: string[];
  checkedAt: string;
};

const PARKED = /(domain (name )?(is )?for sale|buy this domain|this domain (may be|is) (for sale|parked)|domain parking|parked (free|domain|by)|sedo\.com|hugedomains|dan\.com\/buy|afternic|is available for purchase|related searches|coming soon\W*$)/i;
const CLOSED = /(has been acquired|was acquired by|is now part of|shutting down|has shut down|we have shut down|sunsetting|no longer (?:available|operating|in business|supported|maintained)|ceased operations|has closed (?:its doors|down)|service (?:is )?discontinued|(?:has|have) been discontinued)/i;
const CONTINUES = /(continues? (?:to )?operat|will continue|remains? (?:available|operat)|business as usual|now part of .{0,60}(?:team|family|platform))/i;
const SIGNUP_OK = /(sign ?up|create (an )?account|get started|start (a )?free|join (the )?waitlist|register|email address|password)/i;
const SIGNUP_BAD = /(sign-?ups? (are )?(closed|disabled|paused)|not (currently )?accepting (new )?(users|sign|customers)|waitlist (is )?closed|registration (is )?closed|invite[- ]only)/i;
const NO_JOBS = /(no (open|current) (positions|roles|openings|jobs)|not (currently )?hiring|no vacancies|don'?t have any open|0 open (positions|roles))/i;
const JOB_CLOSED = /(no longer accepting|position (has been|is) (filled|closed)|job (has )?expired|no longer available|this job (is|has been) (closed|removed)|posting (is )?closed|job not found|isn'?t available|page (you were looking for )?(not found|doesn'?t exist))/i;

const RE = {
  blog: /\/(blog|news|newsroom|press|updates|stories|articles|insights|journal)(\/?$|\/?[?#])/i,
  release: /(\/(changelog|release-notes|releases|whats?-new|product-updates)(\/?$|\/?[?#])|github\.com\/[^/]+\/[^/]+\/releases\/?$)/i,
  jobs: /(\/(careers?|jobs?|join-us|work-with-us|hiring|open-positions)(\/?$|\/?[?#])|(boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|apply\.workable\.com|careers\.smartrecruiters\.com|\.bamboohr\.com\/(careers|jobs)|\.recruitee\.com|wellfound\.com\/company))/i,
  signup: /\/(sign-?up|register|get-started|join|try|trial|accounts?\/new|start)(\/?$|\/?[?#])/i,
  jobLink: /(boards\.greenhouse\.io\/[^/]+\/jobs\/|jobs\.lever\.co\/[^/]+\/[\w-]{8,}|jobs\.ashbyhq\.com\/[^/]+\/[\w-]{8,}|apply\.workable\.com\/[^/]+\/j\/|\/(jobs?|careers?|positions?|openings?)\/[^/?#]{4,})/i,
  github: /^https?:\/\/(www\.)?github\.com\/([^/?#]+)\/?$/i,
};
const MIRROR = /(git404hub|githubmemory|gitmemory|giters|gitee\.com|sourcegraph|deepwiki|libraries\.io|openbase|pypi\.org\/project|socket\.dev|snyk\.io|security\.snyk|piwheels|ossinsight|github\.com\/topics|awesomeopensource|alternativeto|slant\.co|stackshare|similarweb|trustpilot|crunchbase|zoominfo|rocketreach|pitchbook|cbinsights|owler|glassdoor|g2\.com|capterra|softwaresuggest|producthunt\.com\/products|web\.archive\.org|archive\.org)/i;
const SLD = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);
const PLATFORMS = /(^|\.)(onrender\.com|vercel\.app|netlify\.app|github\.io|herokuapp\.com|pages\.dev|web\.app|firebaseapp\.com|streamlit\.app|fly\.dev|railway\.app|glitch\.me|replit\.app|repl\.co|surge\.sh|gitlab\.io|workers\.dev|azurewebsites\.net|cyclic\.app|koyeb\.app|framer\.website|my\.canva\.site|carrd\.co|notion\.site|wixsite\.com|blogspot\.com|wordpress\.com|substack\.com)$/i;
export const regDomain = (host: string) => {
  if (PLATFORMS.test(host)) return host.replace(/^www\./, "").toLowerCase(); // app.onrender.com is its own site
  const p = host.replace(/^www\./, "").toLowerCase().split(".");
  return p.length > 2 && SLD.has(p[p.length - 2]) && p[p.length - 1].length === 2 ? p.slice(-3).join(".") : p.slice(-2).join(".");
};
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};
export function normUrl(raw: string): string {
  let u = (raw || "").trim();
  const sh = u.match(/^([\w-]+\/[\w.-]+?)(?:[:\s]|$)/); // "owner/repo: description" -> github.com/owner/repo
  if (sh && !/^https?:/i.test(u)) u = "github.com/" + sh[1];
  if (/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}\/\S*\s\S+$/i.test(u) && !/\s.*\s/.test(u)) u = u.replace(/\s+/g, ""); // "github.com/a/b- c" -> one URL
  u = u.split(/\s+/)[0].replace(/[.,;:)\]'"]+$/, "");
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const x = new URL(u);
    return x.hostname.includes(".") ? x.toString() : "";
  } catch {
    return "";
  }
}
const FEED = /(\/(feed|rss|atom)(\.xml)?\/?$|\/(feed|rss|atom|index)\.(xml|rss|atom)$|\/blog\/(feed|rss)(\.xml)?\/?$)/i;
const GONE = /(not_found|404|410|dns|resolve|enotfound|invalid_url|refused|no_such|nxdomain)/i; // definitive "nobody home"; timeouts/blocks are not
export const isGone = (e?: string) => !!e && GONE.test(e);
const shortest = (ls: string[]) => ls.sort((a, b) => a.length - b.length)[0];
const sameSiteOrAts = (l: string, dom: string) => regDomain(hostOf(l)) === dom || RE.jobs.test(l);

/** Pure scoring. Re-run after TinySet adds signals. */
export function evaluate(signals: Sig[], flags: Flags, now = new Date()): Omit<RowResult, "signals" | "flags" | "checkedAt" | "effectiveUrl"> {
  const reasons: string[] = [];
  const by = (id: Sig["id"]) => signals.filter((s) => s.id === id);
  const dated = signals.filter((s) => s.date && s.state !== "bad");
  const latestD = newest(dated.map((s) => parseDate(s.date)!).filter(Boolean));
  // "latest activity" = the entity's own dated activity; press mentions only if nothing else is dated
  const ownD = newest(dated.filter((s) => s.id !== "mentions").map((s) => parseDate(s.date)!).filter(Boolean));
  const latest = iso(ownD || latestD) || undefined;

  if (flags.invalid) return { verdict: "zombie", confidence: "low", score: 0, latest, reasons: ["No valid URL in the sheet for this row, so it could not be verified"] };
  const hard = flags.parked ? "Parked / for-sale domain" : flags.closed ? `Closed or acquired: ${flags.closed}` : flags.unreachable ? "Site unreachable and no live signs found" : flags.ghost ? `Ghost job: ${flags.ghost}` : "";
  if (hard) {
    const own = newest(dated.filter((s) => s.id !== "mentions" && s.id !== "social").map((s) => parseDate(s.date)!).filter(Boolean));
    return { verdict: "zombie", confidence: "high", score: 0, latest: iso(own) || undefined, reasons: [hard] };
  }

  let score = 0;
  const pts = (d?: string, a = 3, b = 2, c = 1) => {
    const dd = parseDate(d);
    if (!dd) return 0;
    const n = ageDays(dd, now);
    return n <= 90 ? a : n <= 180 ? b : n <= 365 ? c : 0;
  };
  const best = (id: Sig["id"], a: number, b: number, c: number) => Math.max(0, ...by(id).map((s) => pts(s.date, a, b, c)));
  const add = (label: string, n: number) => {
    if (n) {
      score += n;
      reasons.push(`${label} +${n}`);
    }
  };
  if (by("site").some((s) => s.state === "fresh")) add("site live", 1);
  add("recent commits", best("repo", 5, 3, 1));
  add("recent blog/news post", best("blog", 3, 2, 1));
  add("recent release/changelog", best("release", 3, 2, 1));
  add("sitemap pages updated", best("sitemap", 2, 1, 0));
  const jobs = by("jobs");
  if (jobs.some((s) => s.state === "fresh")) add("open jobs listed", 1 + (jobs.some((s) => pts(s.date, 1, 0, 0)) ? 1 : 0));
  const undated = (id: Sig["id"]) => (by(id).some((s) => s.state === "fresh" && !s.date) ? 1 : 0);
  add("recent social/dev activity", best("social", 2, 2, 1) || undated("social"));
  add("recent external mentions", best("mentions", 2, 1, 0) || undated("mentions"));
  if (by("signup").some((s) => s.state === "fresh")) add("sign-up works", 1);
  if (signals.some((s) => s.id === "signup" && s.state === "bad" && s.note?.includes("closed"))) {
    score -= 1;
    reasons.push("sign-ups closed -1");
  }
  if (flags.moved) reasons.push(`moved: ${flags.moved}`);

  let verdict: Verdict = score >= 6 ? "alive" : score >= 3 ? "slowing" : "zombie";
  // Quiet is not dead: own activity (commit, release, post) within a year caps the verdict at "slowing".
  if (verdict === "zombie" && signals.some((x) => ["repo", "blog", "release"].includes(x.id) && x.state === "fresh" && x.date)) {
    verdict = "slowing";
    reasons.push("own activity within a year, so not a zombie");
  }
  // "Nothing found" is not proof of death: a zombie verdict needs dated stale evidence, otherwise it is softened.
  const staleDated = signals.some((x) => x.state === "stale" && x.date);
  const talked = signals.some((x) => (x.id === "mentions" || x.id === "social") && x.state === "fresh");
  let softened = false;
  if (verdict === "zombie" && !staleDated && talked) {
    verdict = "slowing";
    softened = true;
    reasons.push("no dated stale evidence and still mentioned recently, so not called a zombie");
  }
  const known = signals.filter((s) => s.state !== "unknown").length;
  // A blocked / timed-out check is not evidence of death: say "slowing, low confidence" instead of zombie.
  if (verdict === "zombie" && flags.transient) {
    reasons.push("could not be verified (timeout or bot block), so not called a zombie");
    return { verdict: "slowing", confidence: "low", score, latest, reasons };
  }
  const confidence: RowResult["confidence"] = softened ? "medium" : verdict === "zombie" && !staleDated ? "low" : known < 3 ? "low" : Math.abs(score - 4.5) >= 2 || (verdict === "alive" && dated.length >= 2) ? "high" : "medium";
  return { verdict, confidence, score, latest, reasons };
}

const datesOfPage = (p?: Page) => {
  if (!p?.text) return undefined;
  const ds = extractDates(p.text);
  const pd = parseDate(p.published_date);
  if (pd) ds.push(pd);
  return newest(ds);
};

export type Input = { name: string; url: string; jobMode?: boolean };

export async function checkRow(inp: Input): Promise<RowResult> {
  return inp.jobMode ? checkJob(inp) : checkSite(inp);
}

async function resolveUrl(name: string): Promise<string> {
  const hits = await search(`${name} official website`);
  const bad = /(wikipedia|linkedin|facebook|twitter|x\.com|crunchbase|youtube|instagram|github\.com|reddit|glassdoor|g2\.com|capterra)/i;
  const h = hits.find((x) => !bad.test(x.url));
  return h ? new URL(h.url).origin : "";
}

async function checkSite(inp: Input): Promise<RowResult> {
  const signals: Sig[] = [];
  const flags: Flags = {};
  let url = normUrl(inp.url);
  if (!url && !inp.url.trim() && inp.name) url = await resolveUrl(inp.name);
  if (!url && inp.url.trim()) return fin(signals, { invalid: true }, "");
  if (!url) return fin(signals, { invalid: true }, "", ["No URL and none could be resolved from the name"]);
  if (/^(www\.)?github\.com$/i.test(hostOf(url)) && new URL(url).pathname.split("/").filter(Boolean).length >= 2) return checkRepo(inp, url);
  const origDom = regDomain(hostOf(url));

  const name0 = inp.name || origDom;
  const early = Promise.all([ // searches don't depend on the homepage: run them while it loads
    search(`"${name0}" ${origDom}`, { recencyDays: 180 }).catch(() => []),
    search(`"${name0}" (site:x.com OR site:linkedin.com OR site:youtube.com OR site:reddit.com OR site:news.ycombinator.com)`, { recencyDays: 180 }).catch(() => []),
  ]);
  // 1. Homepage, live.
  let { pages, errors } = await fetchPages([url]);
  if (!pages.get(url) && !isGone(errors.get(url))) ({ pages, errors } = await fetchPages([url])); // one retry for timeouts / bot blocks
  let home = pages.get(url);
  if (!home) {
    const alt = url.replace("://", "://www.");
    if (!/\/\/www\./.test(url)) {
      const r = await fetchPages([alt]);
      home = r.pages.get(alt);
      if (home) url = alt;
    }
  }
  let base = url;
  if (home) {
    const fu = home.final_url || url;
    base = fu;
    const text = (home.text || "").slice(0, 20000);
    const finalDom = regDomain(hostOf(fu));
    const thin = text.replace(/\s+/g, " ").length < 400;
    if (PARKED.test(text) && (thin || PARKED.test(home.title || ""))) flags.parked = true;
    if (/^(sedo|dan|hugedomains|afternic|godaddy|namecheap|squarespace)\./i.test(hostOf(fu)) || /(sedo|hugedomains|dan)\.com$/.test(finalDom)) flags.parked = true;
    if (finalDom !== origDom) flags.moved = `${origDom} redirects to ${finalDom}`;
    const m = (home.title + " " + text.slice(0, 700)).match(CLOSED);
    if (m && !/(github|gitlab|huggingface|notion|docs\.google|drive\.google)/i.test(hostOf(fu))) {
      if (CONTINUES.test((home.title + " " + text.slice(0, 1500)))) flags.moved = (flags.moved ? flags.moved + "; " : "") + `${m[0]} (but continues operating)`;
      else flags.closed = m[0] + (flags.moved ? ` (now ${finalDom})` : "");
    }
    signals.push({ id: "site", state: flags.parked ? "bad" : "fresh", url: fu, note: flags.moved || (thin ? "very thin page" : "live"), date: undefined });
    const cy = [...text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d{2})/gi)].map((x) => +x[1]);
    if (cy.length) signals.push({ id: "site", state: "unknown", note: `© ${Math.max(...cy)}`, url: fu });
  } else {
    const why = errors.get(url) || "no response";
    if (!isGone(why)) flags.transient = true;
    signals.push({ id: "site", state: isGone(why) ? "bad" : "unknown", url, note: `fetch failed: ${why}${isGone(why) ? "" : " (may be temporary or blocking bots)"}` });
  }

  // 2. Discover sub-pages from homepage links (same site, ATS, github).
  const links = (home?.links || []).map((l) => l.split("#")[0]);
  const dom = regDomain(hostOf(base));
  const own = [...new Set(links)];
  const pick = (re: RegExp, sameOnly = true) => shortest(own.filter((l) => re.test(l) && (!sameOnly || sameSiteOrAts(l, dom))).filter((l) => l.length < 140) as string[]) as string | undefined;
  let blog = pick(RE.blog), rel = pick(RE.release, false), jobs = pick(RE.jobs, false), signup = pick(RE.signup);
  const gh = own.map((l) => l.match(RE.github)).find((m) => m && !/^(sponsors|features|about|pricing|login|orgs)$/i.test(m[2]));
  const ghUrl = gh ? `https://github.com/${gh[2]}` : "";
  if (home && !flags.parked) {
    const origin = new URL(base).origin;
    blog ||= origin + "/blog";
    jobs ||= origin + "/careers";
  }
  const feed = pick(FEED);
  let sitemap = "";
  if (home && !flags.parked) sitemap = new URL(base).origin + "/sitemap.xml";
  const targets = [...new Set([blog, rel, jobs, signup, ghUrl, feed, sitemap].filter(Boolean) as string[])];
  const sub = home && !flags.parked && !flags.closed ? await fetchPages(targets) : { pages: new Map<string, Page>(), errors: new Map<string, string>() };

  const sig = (id: Sig["id"], u: string | undefined, f: (p: Page) => Partial<Sig>) => {
    if (!u) return;
    const p = sub.pages.get(u);
    if (!p) return void signals.push({ id, state: "none", url: u, note: sub.errors.get(u) ? `not reachable (${sub.errors.get(u)})` : "not found" });
    signals.push({ id, url: p.final_url || u, state: "none", ...f(p) });
  };
  const pageDate = (p: Page): Partial<Sig> => {
    const d = datesOfPage(p);
    return d ? { state: ageDays(d) <= 365 ? "fresh" : "stale", date: iso(d) } : { state: "unknown", note: "no dates on page" };
  };
  sig("blog", blog, pageDate);
  sig("blog", feed, (p) => { const d = datesOfPage(p); return d ? { state: ageDays(d) <= 365 ? "fresh" : "stale", date: iso(d), note: "RSS/Atom feed" } : { state: "unknown", note: "feed without dates" }; });
  sig("sitemap", sitemap, (p) => { const d = newest(extractDates((p.text || "").slice(0, 60000))); return d ? { state: ageDays(d) <= 365 ? "fresh" : "stale", date: iso(d), note: "sitemap lastmod" } : { state: "unknown", note: "sitemap without dates" }; });
  sig("release", rel, pageDate);
  sig("jobs", jobs, (p) => {
    const t = p.text || "";
    if (NO_JOBS.test(t)) return { state: "none", note: "no open positions" };
    const n = new Set((p.links || []).filter((l) => RE.jobLink.test(l)).map((l) => l.split("?")[0])).size;
    const d = datesOfPage(p);
    return n > 0 ? { state: "fresh", note: `${n} job links`, date: d && ageDays(d) <= 365 ? iso(d) : undefined } : { state: "none", note: "no job listings found" };
  });
  sig("signup", signup, (p) => {
    const t = (p.text || "").slice(0, 8000);
    if (SIGNUP_BAD.test(t)) return { state: "bad", note: "sign-ups closed" };
    return SIGNUP_OK.test(t) && t.length > 150 ? { state: "fresh", note: "sign-up form/CTA present" } : { state: "none", note: "no sign-up form" };
  });
  sig("social", ghUrl, (p) => {
    const ds = relativeDates(p.text || "");
    const d = newest([...ds, ...extractDates(p.text || "")]);
    return d ? { state: ageDays(d) <= 365 ? "fresh" : "stale", date: iso(d), note: "GitHub org activity" } : { state: "unknown", note: "GitHub org, no dates" };
  });

  // 3. Search signals: external mentions + social/community presence (live search, last 180 days).
  const name = inp.name || dom;
  const [m, s] = await early;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nm = name.trim().slice(0, 40);
  const rel2 = (h: any) => (new RegExp(esc(dom), "i").test(h.url + " " + h.title + " " + h.snippet)) || (nm.length >= 5 && new RegExp(`\\b${esc(nm)}\\b`, "i").test(h.title + " " + h.snippet));
  // acquisition/shutdown must be said about THIS company: name or domain and the phrase in one sentence
  const subject = (t: string) => { // the company name must be followed by the closing phrase within ~90 chars
    for (const n of [nm, dom.split(".")[0]].filter((x) => x.length >= 4)) {
      const re = new RegExp(esc(n), "ig");
      let m: RegExpExecArray | null;
      while ((m = re.exec(t))) if (CLOSED.test(t.slice(m.index, m.index + n.length + 90))) return true;
    }
    return false;
  };
  const about = (h: any) => !/(alternatives|competitors|compare|similar (products|companies)|vs\.?\s)/i.test(h.title + " " + h.snippet) && `${h.title}. ${h.snippet}`.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").split(/(?<=[.!?])\s+/).some((t) => subject(t) && (new RegExp(esc(dom.split(".")[0]), "i").test(t) || ((nm.length >= 8 || /\s/.test(nm)) && new RegExp(esc(nm), "i").test(t)) || (nm.length >= 5 && new RegExp(esc(nm), "i").test(t) && new RegExp(esc(dom.split(".")[0]), "i").test(`${h.url} ${h.title} ${h.snippet}`))));
  const toSig = (id: Sig["id"], hs: any[], note: string) => {
    const good = hs.filter((h) => !MIRROR.test(hostOf(h.url) + h.url) && rel2(h));
    const h = good[0];
    if (!h) return signals.push({ id, state: "none", note: "nothing relevant in last 180 days" });
    const d = parseDate(h.date) || newest(extractDates(h.snippet || "")) || undefined;
    signals.push({ id, state: "fresh", url: h.url, date: iso(d) || undefined, note: `${note}: ${good.length} hits${d ? "" : " (undated, inside the 180-day window)"}` });
  };
  toSig("mentions", m.filter((h) => regDomain(hostOf(h.url)) !== dom || true), "recent web mentions");
  toSig("social", s, "social/community posts");

  // 4. Acquisition / shutdown by search if site is dead or moved.
  if ((!home || flags.moved) && !flags.closed && !flags.parked) {
    const a = await search(`"${name}" acquired OR "shutting down" OR "rebrands to" OR "now known as"`).catch(() => []);
    const h = a.find(about);
    if (h) {
      const said = `${h.title}. ${h.snippet}`.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#*_`]+/g, "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).find((t) => CLOSED.test(t)) || h.title;
      if (flags.moved) flags.moved += ` — ${said.slice(0, 110)}`;
      else flags.closed = said.slice(0, 140);
      signals.push({ id: "mentions", state: "bad", url: h.url, note: "acquisition / shutdown report" });
    }
  }
  if (!home && !flags.transient && !signals.some((s2) => s2.id === "mentions" && s2.state === "fresh") && !signals.some((s2) => s2.id === "social" && s2.state === "fresh")) flags.unreachable = true;
  return fin(signals, flags, base);
}

/** GitHub repository: repo page (exists / archived) + commits.atom + releases.atom via Fetch. Feeds are live, dated and not rate-limited. */
async function checkRepo(inp: Input, url: string): Promise<RowResult> {
  const [, owner, repo] = new URL(url).pathname.split("/");
  const clean = repo.replace(/\.git$/, "");
  const page = `https://github.com/${owner}/${clean}`;
  const signals: Sig[] = [];
  const flags: Flags = {};
  const pypi = `https://pypi.org/pypi/${clean}/json`, npm = `https://registry.npmjs.org/${clean.toLowerCase()}`;
  const { pages, errors } = await fetchPages([page, `${page}/commits.atom`, `${page}/releases.atom`, pypi, npm], false);
  const p = pages.get(page);
  if (!p) {
    const why = errors.get(page) || "404";
    signals.push({ id: "site", state: isGone(why) ? "bad" : "unknown", url: page, note: `repo not reachable (${why})` });
    if (isGone(why)) flags.unreachable = true;
    else flags.transient = true;
  } else {
    signals.push({ id: "site", state: "fresh", url: page, note: "repo exists" });
    if (/This repository has been archived|is archived/i.test(p.text || "")) flags.closed = "repository is archived (read-only)";
    const dates = (t?: string | null) => (t ? extractDates(t.slice(0, 4000)) : []);
    const c = newest(dates(pages.get(`${page}/commits.atom`)?.text));
    let cd = c, how = "latest commit";
    if (!cd) { // feed unreadable: fall back to relative times printed on the repo page ("2 days ago"); "unknown" is never "dead"
      const rel = relativeDates((p.text || "").slice(0, 6000));
      if (rel.length) { cd = newest(rel); how = "latest commit (repo page)"; }
    }
    if (cd) signals.push({ id: "repo", state: ageDays(cd) <= 365 ? "fresh" : "stale", date: iso(cd), url: `${page}/commits`, note: how });
    else { signals.push({ id: "repo", state: "unknown", url: page, note: "no commit dates readable" }); flags.transient = true; }
    // Package registries: only trusted when the package points back to this very repo.
    for (const [u, label] of [[pypi, "PyPI"], [npm, "npm"]] as const) {
      const t = pages.get(u)?.text;
      if (!t || !t.toLowerCase().includes(`github.com/${owner}/${clean}`.toLowerCase())) continue;
      const d = newest(extractDates(t));
      if (d) signals.push({ id: "release", state: ageDays(d) <= 365 ? "fresh" : "stale", date: iso(d), url: label === "PyPI" ? `https://pypi.org/project/${clean}/` : `https://www.npmjs.com/package/${clean.toLowerCase()}`, note: `latest ${label} release` });
    }
    const rd = dates(pages.get(`${page}/releases.atom`)?.text);
    if (rd.length >= 2) {
      const d = newest(rd)!;
      signals.push({ id: "release", state: ageDays(d) <= 365 ? "fresh" : "stale", date: iso(d), url: `${page}/releases`, note: "latest release" });
    }
  }
  const name = inp.name || `${owner}/${clean}`;
  const hits = await search(`"${clean}" ${owner}`, { recencyDays: 180 }).catch(() => []);
  const h = hits.find((x) => !x.url.includes(`github.com/${owner}/${clean}`) && !MIRROR.test(x.url) && !/github\.com/i.test(hostOf(x.url)) && !!(parseDate(x.date) || newest(extractDates(x.snippet))) && new RegExp(clean.replace(/[^\w]/g, "."), "i").test(x.title + " " + x.snippet + " " + x.url) && new RegExp(owner.replace(/[^\w]/g, "."), "i").test(x.title + " " + x.snippet + " " + x.url));
  signals.push(h ? { id: "mentions", state: "fresh", url: h.url, date: iso(parseDate(h.date) || newest(extractDates(h.snippet))) || undefined, note: "recent mention elsewhere" } : { id: "mentions", state: "none", note: "nothing relevant in last 180 days" });
  return fin(signals, flags, page);
}

/** Ghost-job check for a single job posting URL. */
async function checkJob(inp: Input): Promise<RowResult> {
  const url = normUrl(inp.url);
  const signals: Sig[] = [];
  const flags: Flags = {};
  const { pages, errors } = await fetchPages([url]);
  const p = pages.get(url);
  if (!p) {
    const why = errors.get(url) || "no response";
    if (isGone(why)) flags.ghost = `posting removed (${why})`;
    else flags.transient = true;
    return fin(signals, flags, url);
  }
  const t = p.text || "";
  const fu = p.final_url || url;
  const jobId = (new URL(url).pathname.match(/\d{5,}|[\w-]{12,}/g) || []).pop();
  const lost = fu !== url && !!jobId && !fu.includes(jobId); // redirected somewhere that no longer names this job
  if (JOB_CLOSED.test(t.slice(0, 5000)) || JOB_CLOSED.test(p.title || "")) flags.ghost = "posting says closed / filled / not found";
  else if (lost) flags.ghost = `redirected to generic page ${fu}`;
  // Expiry stated on the posting itself
  const exp = t.match(/(?:valid through|apply (?:by|before)|closing date|closes(?: on)?|application deadline|expires?(?: on)?)\W{1,4}([A-Za-z0-9 ,/.-]{6,30})/i);
  const expD = exp ? parseDate(exp[1].trim()) : undefined;
  if (!flags.ghost && expD && ageDays(expD) > 0) flags.ghost = `posting expired ${iso(expD)}`;
  const rel = relativeDates(t.slice(0, 4000).replace(/posted\s+/gi, ""));
  const posted = datesOfPage(p) || parseDate(p.published_date) || newest(rel.filter(() => /posted|published|listed/i.test(t.slice(0, 4000))));
  if (/(reposted|re-?listed|re-?posted)/i.test(t.slice(0, 4000))) signals.push({ id: "jobs", state: "stale", url: fu, note: "reposted listing (ghost-job trait)" });
  signals.push({ id: "site", state: flags.ghost ? "bad" : "fresh", url: fu, note: "job page live" });
  if (posted) signals.push({ id: "jobs", state: ageDays(posted) <= 60 ? "fresh" : "stale", date: iso(posted), url: fu, note: "posting date" });
  else signals.push({ id: "jobs", state: "unknown", url: fu, note: "no posting date visible (common ghost-job trait)" });
  if (/(apply|submit application)/i.test(t)) signals.push({ id: "signup", state: "fresh", url: fu, note: "apply action present" });
  // Cross-check: is the job still listed on the company's own board?
  if (!flags.ghost && jobId) {
    const u = new URL(fu);
    const seg = u.pathname.split("/").filter(Boolean)[0];
    const board = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com)/i.test(u.hostname) && seg ? `${u.origin}/${seg}` : `${u.origin}/careers`;
    if (board !== fu) {
      const b = await fetchPages([board]).catch(() => undefined);
      const bp = b?.pages.get(board);
      const bl = (bp?.links || []).filter((l) => RE.jobLink.test(l));
      if (bp && bl.length >= 3) {
        const listed = bl.some((l) => l.includes(jobId)) || (bp.text || "").toLowerCase().includes((p.title || "").split(/[|\-–]/)[0].trim().toLowerCase().slice(0, 40) || " ");
        signals.push({ id: "jobs", state: listed ? "fresh" : "stale", url: bp.final_url || board, note: listed ? `still listed on company board (${bl.length} jobs)` : `not on company board (${bl.length} other jobs listed)` });
        if (!listed) flags.ghost = `no longer on the company's job board (${bl.length} other jobs listed)`;
      }
    }
  }
  const co = inp.name || regDomain(hostOf(fu));
  const hits = await search(`"${co}" hiring OR careers OR jobs`, { recencyDays: 90 }).catch(() => []);
  if (hits[0]) signals.push({ id: "mentions", state: "fresh", url: hits[0].url, date: iso(parseDate(hits[0].date) || newest(extractDates(hits[0].snippet))) || undefined, note: "company recently active" });
  if (!flags.ghost && posted && ageDays(posted) > 90) flags.ghost = `posted ${iso(posted)}, over 90 days ago`;
  return fin(signals, flags, fu);
}

function fin(signals: Sig[], flags: Flags, eff: string, extra: string[] = []): RowResult {
  const e = evaluate(signals, flags);
  return { ...e, reasons: [...extra, ...e.reasons], signals, flags, effectiveUrl: eff, checkedAt: new Date().toISOString() };
}

export const reEvaluate = (r: RowResult): RowResult => ({ ...r, ...evaluate(r.signals, r.flags) });
