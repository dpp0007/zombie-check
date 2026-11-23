"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Sig = { id: string; state: string; date?: string; url?: string; note?: string };
type R = { i: number; state: string; deep: boolean; error?: string; name: string; url: string; verdict?: string; confidence?: string; latest?: string; score?: number; reasons?: string[]; signals?: Sig[]; flags?: Record<string, any> };
type J = { id: string; name: string; status: string; stage: string; message?: string; headers: string[]; opts: any; counts: Record<string, number>; chunks: { n: number; state: string; note?: string }[]; rows: R[] };
type Recent = { id: string; name: string; status: string; total: number; done: number };

const SIGNALS: [string, string, string][] = [
  ["site", "Site live", "Fetch|Redirects, parked domains, acquisition banners"],
  ["repo", "Repository", "Fetch|GitHub last push, releases, archived flag"],
  ["blog", "Blog & news", "Fetch|Newest post on the company's own pages"],
  ["release", "Releases", "Fetch|Changelog and release notes"],
  ["jobs", "Open jobs", "Fetch|Careers page and job boards"],
  ["social", "Social", "Fetch + Search|GitHub, X, LinkedIn, YouTube"],
  ["signup", "Sign-up", "Fetch|Form present and not closed"],
  ["mentions", "Press", "Search|Mentions in the last 180 days"],
];
const RANK: Record<string, number> = { fresh: 4, stale: 3, unknown: 2, bad: 1, none: 0 };
const EDGE: [string, string, (r: R) => boolean][] = [
  ["parked", "Parked", (r) => !!r.flags?.parked],
  ["moved", "Redirect or rebrand", (r) => !!r.flags?.moved],
  ["closed", "Acquired or closed", (r) => !!r.flags?.closed],
  ["ghost", "Ghost job", (r) => !!r.flags?.ghost],
  ["dead", "Unreachable", (r) => !!r.flags?.unreachable],
  ["tiny", "TinySet-verified", (r) => r.deep],
];
const EXAMPLES: [string, string][] = [
  ["Awesome Python, 564 rows", "https://github.com/vinta/awesome-python"],
  ["Awesome Selfhosted", "https://github.com/awesome-selfhosted/awesome-selfhosted"],
];

const api = async (u: string, body?: any) => {
  const r = await fetch(u, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const ago = (d?: string) => {
  if (!d) return "";
  const n = Math.floor((Date.now() - +new Date(d)) / 864e5);
  return n < 1 ? "today" : n < 60 ? `${n} days ago` : n < 700 ? `${Math.round(n / 30)} months ago` : `${(n / 365).toFixed(1)} years ago`;
};
const bestState = (r: R, id: string) => (r.signals || []).filter((s) => s.id === id).sort((a, b) => RANK[b.state] - RANK[a.state])[0];

export default function Page() {
  const [job, setJob] = useState<J | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [src, setSrc] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("order");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const [cfg, setCfg] = useState<any>(null);
  const [eta, setEta] = useState("");
  const samples = useRef<[number, number][]>([]);
  const timer = useRef<any>(null);

  const load = useCallback(async (id: string) => {
    const j: J = await api(`/api/jobs/${id}`);
    setJob(j);
    setCfg((c: any) => c ?? j.opts);
    localStorage.setItem("zc-job", id);
    const done = j.rows.filter((r) => r.state !== "pending").length;
    const s = samples.current;
    s.push([Date.now(), done]);
    if (s.length > 12) s.shift();
    const rate = s.length > 2 ? (s[s.length - 1][1] - s[0][1]) / ((s[s.length - 1][0] - s[0][0]) / 1000) : 0;
    const left = j.rows.length - done;
    setEta(j.status === "running" && rate > 0 && left > 0 ? `about ${Math.max(1, Math.round(left / rate / 60))} min left · ${(rate * 60).toFixed(0)} rows a minute` : "");
    return j;
  }, []);
  const refreshRecent = () => api("/api/jobs").then(setRecent).catch(() => {});
  useEffect(() => {
    refreshRecent();
    const id = localStorage.getItem("zc-job");
    if (id) load(id).catch(() => localStorage.removeItem("zc-job"));
  }, [load]);
  useEffect(() => {
    clearInterval(timer.current);
    if (job && job.status === "running") timer.current = setInterval(() => load(job.id).catch(() => {}), 2500);
    return () => clearInterval(timer.current);
  }, [job?.status, job?.id, load]);

  async function create(body: any) {
    setErr("");
    setBusy(true);
    try {
      const { id } = await api("/api/jobs", body);
      setCfg(null);
      setFilter("all");
      setPage(0);
      samples.current = [];
      await load(id);
      refreshRecent();
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy(false);
  }
  const fromUrl = (u: string) => create({ sourceUrl: u, name: u.replace(/https?:\/\/(github\.com\/)?/, "").replace(/[^\w]+/g, "-").slice(0, 40) });
  const act = async (action: "start" | "pause" | "reset") => {
    setErr("");
    try {
      await api(`/api/jobs/${job!.id}/run`, { action, opts: cfg ? { ...cfg, concurrency: +cfg.concurrency, deepMax: +cfg.deepMax } : undefined });
      setTimeout(() => load(job!.id), 400);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const newList = () => {
    localStorage.removeItem("zc-job");
    setJob(null);
    setCfg(null);
    refreshRecent();
  };

  const total = job?.rows.length || 0;
  const c = job?.counts || { alive: 0, slowing: 0, zombie: 0, pending: 0, error: 0 };
  const done = total - c.pending;
  const checked = c.alive + c.slowing + c.zombie;
  const edge = useMemo(() => Object.fromEntries(EDGE.map(([k, , f]) => [k, (job?.rows || []).filter(f).length])), [job]);

  const PS = 40;
  const rows = useMemo(() => {
    let r = job?.rows || [];
    const e = EDGE.find(([k]) => k === filter);
    if (e) r = r.filter(e[2]);
    else if (filter !== "all") r = r.filter((x) => (x.verdict || (x.state === "error" ? "error" : "pending")) === filter);
    if (q) r = r.filter((x) => (x.name + " " + x.url).toLowerCase().includes(q.toLowerCase()));
    const rank = { zombie: 0, slowing: 1, alive: 2 } as any;
    if (sort === "worst") r = [...r].sort((a, b) => (rank[a.verdict ?? ""] ?? 9) - (rank[b.verdict ?? ""] ?? 9) || (a.score ?? 0) - (b.score ?? 0));
    if (sort === "stale") r = [...r].sort((a, b) => (a.latest || "0").localeCompare(b.latest || "0"));
    if (sort === "fresh") r = [...r].sort((a, b) => (b.latest || "").localeCompare(a.latest || ""));
    return r;
  }, [job, filter, q, sort]);
  useEffect(() => setPage(0), [filter, q, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / PS));
  const pct = Math.round((done / Math.max(1, total)) * 100);
  const stageNow = job?.stage;
  const tsBatches = job?.chunks || [];
  const w = (n: number) => `${(n / Math.max(1, checked)) * 100}%`;
  const pick = async (f?: File) => f && create({ name: f.name.replace(/\.csv$/i, ""), csv: await f.text() });

  return (
    <main>
      <nav className="nav">
        <span className="mark">Zombie Check</span>
        <div className="apis"><span><b>Fetch</b> live pages</span><span><b>Search</b> fresh mentions</span><span><b>TinySet</b> deep verification</span></div>
      </nav>

      {!job && (
        <>
          <section className={`hero ${drag ? "drag" : ""}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}>
            <span className="eyebrow">List hygiene, checked live</span>
            <h1 className="display">Is anyone<br /><em>still home?</em></h1>
            <p className="lead">Hand over a spreadsheet of companies, tools, repos or job posts. Every row is checked against live pages and returned with a verdict, the date of its latest activity, and the links that prove it.</p>
            <div className="row">
              <label className="btn primary">{busy ? "Loading…" : "Choose a CSV"}<input type="file" hidden accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} /></label>
              <span className="mut tiny">or drop a file anywhere on this page</span>
            </div>
            <div className="row" style={{ width: "100%" }}>
              <input className="field" style={{ flex: "1 1 360px", maxWidth: 560 }} value={src} onChange={(e) => setSrc(e.target.value)} placeholder="Google Sheet, CSV link or GitHub awesome-list" onKeyDown={(e) => e.key === "Enter" && src && fromUrl(src)} />
              <button className="btn line" disabled={busy || !src} onClick={() => fromUrl(src)}>Load list</button>
            </div>
            <div className="recent">
              <span className="mut tiny" style={{ alignSelf: "center", marginRight: 4 }}>Try</span>
              {EXAMPLES.map(([l, u]) => <button key={u} className="pillbtn" onClick={() => fromUrl(u)}>{l}</button>)}
              <a className="pillbtn" href="/sample.csv" style={{ textDecoration: "none" }}>sample.csv with known zombies</a>
            </div>
            {err && <p className="err">{err}</p>}
          </section>

          {recent.length > 0 && (
            <section className="section" style={{ paddingTop: 8 }}>
              <span className="eyebrow">Resume a run</span>
              <div className="recent">{recent.slice(0, 8).map((r) => <button key={r.id} className="pillbtn" onClick={() => { setCfg(null); load(r.id); }}>{r.name} · {r.done}/{r.total} · {r.status}</button>)}</div>
            </section>
          )}

          <section className="section">
            <span className="eyebrow">How a verdict is made</span>
            <h2 className="h2" style={{ margin: "0 0 32px", maxWidth: 720 }}>Eight signals per row, each with a date and a link, weighed by freshness.</h2>
            <div className="signals">
              {SIGNALS.map(([id, l, d], i) => {
                const [a, t] = d.split("|");
                return <div key={id}><span className="num">0{i + 1}</span><b>{l}</b><span className="mut tiny">{t}</span><div className="api" style={{ marginTop: 10 }}>{a}</div></div>;
              })}
            </div>
            <p className="lead" style={{ marginTop: 36, fontSize: 18 }}>A parked domain, an acquisition notice or a dead site overrides the score. Rows the first sweep can&apos;t settle go to TinySet for a second, sourced opinion. Lists of job posts switch to ghost-job mode.</p>
          </section>
        </>
      )}

      {job && (
        <>
          <header className="jobhead">
            <div>
              <span className="eyebrow">{total} rows · job {job.id}</span>
              <h1 className="h2" style={{ marginTop: 10 }}>{job.name}</h1>
              <div style={{ marginTop: 12, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                <span className={`state ${job.status}`}><i />{job.status}</span>
                <span className="mut tiny">{done} of {total} checked {eta && `· ${eta}`}</span>
              </div>
            </div>
            <div className="acts">
              {job.status === "running" ? <button className="btn line" onClick={() => act("pause")}>Pause</button> : <button className="btn primary" onClick={() => act("start")}>{job.status === "done" ? "Re-check errors" : done > 0 ? "Resume" : "Start check"}</button>}
              <a className="btn stone" style={done === 0 ? { opacity: 0.4, pointerEvents: "none" } : {}} href={`/api/jobs/${job.id}/download`}>Download CSV</a>
              <a className="btn stone" style={done === 0 ? { opacity: 0.4, pointerEvents: "none" } : {}} href={`/api/jobs/${job.id}/download?format=xlsx`}>Download XLSX</a>
              {job.status !== "running" && done > 0 && <button className="btn line" onClick={() => confirm("Re-check every row from scratch?") && act("reset")}>Re-check all</button>}
              <button className="btn line" onClick={newList}>New list</button>
            </div>
          </header>
          {(err || job.message) && <p className="err">{err || job.message}</p>}

          <details open={job.status === "ready"}>
            <summary>Settings — columns are auto-detected{total < 500 ? " · fewer than 500 rows" : ""}</summary>
            {cfg && (
              <div className="set">
                <label className="lab">Name column<select className="field" value={cfg.nameCol} disabled={job.status === "running"} onChange={(e) => setCfg({ ...cfg, nameCol: e.target.value })}>{job.headers.map((h) => <option key={h}>{h}</option>)}</select></label>
                <label className="lab">URL column<select className="field" value={cfg.urlCol} disabled={job.status === "running"} onChange={(e) => setCfg({ ...cfg, urlCol: e.target.value })}><option value="">(resolve from name)</option>{job.headers.map((h) => <option key={h}>{h}</option>)}</select></label>
                <label className="lab">List type<select className="field" value={cfg.jobMode ? "jobs" : "sites"} disabled={job.status === "running"} onChange={(e) => setCfg({ ...cfg, jobMode: e.target.value === "jobs" })}><option value="sites">Companies, tools, repos</option><option value="jobs">Job posts (ghost jobs)</option></select></label>
                <label className="lab">Parallel rows<input className="field" type="number" min={1} max={16} style={{ width: 90 }} value={cfg.concurrency} onChange={(e) => setCfg({ ...cfg, concurrency: e.target.value })} /></label>
                <label className="lab">TinySet<select className="field" value={cfg.deep ? "y" : "n"} onChange={(e) => setCfg({ ...cfg, deep: e.target.value === "y" })}><option value="y">Deep-verify uncertain rows</option><option value="n">Off</option></select></label>
                <label className="lab">Up to rows<input className="field" type="number" min={1} max={800} style={{ width: 90 }} value={cfg.deepMax} onChange={(e) => setCfg({ ...cfg, deepMax: e.target.value })} /></label>
              </div>
            )}
          </details>

          <div className="verdicts">
            {([["alive", "Alive", c.alive], ["slowing", "Slowing down", c.slowing], ["zombie", "Zombie", c.zombie]] as const).map(([k, l, n]) => (
              <div key={k} className={`circ ${k} ${filter === k ? "on" : ""}`} onClick={() => setFilter(filter === k ? "all" : k)}><div><span className="num">{n}</span><small>{l}</small></div></div>
            ))}
            <div className="split">
              <div className="meter"><i style={{ width: w(c.alive), background: "var(--forest)" }} /><i style={{ width: w(c.slowing), background: "var(--gold)" }} /><i style={{ width: w(c.zombie), background: "var(--clay)" }} /></div>
              <div className="cap">
                <span>{checked ? Math.round((c.zombie / checked) * 100) : 0}% of checked rows are zombies</span>
                <span>{c.pending} pending{c.error > 0 && <> · <a href="#" className="err" onClick={(e) => { e.preventDefault(); setFilter("error"); }}>{c.error} errors</a></>}</span>
              </div>
              <div className="chips" style={{ marginTop: 18 }}>
                {EDGE.map(([k, l]) => <button key={k} className={`pillbtn ${filter === k ? "on" : ""}`} onClick={() => setFilter(filter === k ? "all" : k)}><b>{edge[k]}</b>{l}</button>)}
              </div>
            </div>
          </div>

          <section className="band">
            <span className="eyebrow">Pipeline</span>
            <div className="stages">
              <div className={`stage ${stageNow === "checks" ? "cur" : "fin"}`}>
                <span className="pct">{pct}%</span>
                <div className="t">Live-page sweep</div>
                <p>Fetch and Search read each site&apos;s own pages: {SIGNALS.length} signals per row, never from a cache.</p>
                <div className="rail"><i style={{ width: `${pct}%` }} /></div>
              </div>
              <div className={`stage ${stageNow === "tinyset" ? "cur" : stageNow === "finished" ? "fin" : ""}`}>
                <div className="t">TinySet deep verification</div>
                <p>The most ambiguous rows are re-researched in 40-domain datasets, every value with its source.</p>
                <div>{tsBatches.length ? tsBatches.map((k, i) => <span key={i} className={`batch ${k.state}`} title={k.note}>Batch {i + 1} · {k.n} rows · {k.state}</span>) : <span className="mut tiny">{job.opts.deep ? "Starts when the sweep finishes" : "Switched off"}</span>}</div>
              </div>
            </div>
          </section>

          <div className="tools">
            <input className="field light" style={{ minWidth: 240 }} placeholder="Search name or URL" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="field light" value={sort} onChange={(e) => setSort(e.target.value)}><option value="order">Original order</option><option value="worst">Worst first</option><option value="stale">Oldest activity first</option><option value="fresh">Newest activity first</option></select>
            <span className="mut tiny">{rows.length} rows{filter !== "all" && <> · {filter} · <a href="#" onClick={(e) => { e.preventDefault(); setFilter("all"); }}>clear</a></>}</span>
            <div className="legend"><span><i className="dot fresh" /> fresh</span><span><i className="dot stale" /> stale</span><span><i className="dot bad" /> broken</span><span><i className="dot none" /> none</span></div>
          </div>

          {rows.length === 0 ? <div className="empty">{done === 0 ? "Press Start check. Verdicts appear here as they land." : "No rows match."}</div> : (
            <table>
              <thead><tr><th>Row</th><th>Verdict</th><th title={SIGNALS.map((x) => x[1]).join(" · ")}>Signals</th><th>Latest activity</th><th>Confidence</th><th>Why</th></tr></thead>
              <tbody>
                {rows.slice(page * PS, page * PS + PS).map((r) => (
                  <Fragment key={r.i}>
                    <tr className="r" onClick={() => setOpen(open === r.i ? null : r.i)}>
                      <td><div className="rname">{r.name || r.url}</div><div className="rurl">{r.url}</div></td>
                      <td><span className={`verdict ${r.verdict || (r.state === "error" ? "error" : "pending")}`}>{r.verdict || r.state}</span></td>
                      <td><div className="dots">{SIGNALS.map(([id, l]) => { const s = bestState(r, id); return <i key={id} className={`dot ${s?.state || "none"}`} title={`${l}: ${s ? `${s.state}${s.date ? " · " + s.date : ""}${s.note ? " · " + s.note : ""}` : "not checked"}`} />; })}</div></td>
                      <td className="when">{r.latest ? <><b>{r.latest}</b><div>{ago(r.latest)}</div></> : <span className="mut">None found</span>}</td>
                      <td><span className="conf" title={r.confidence}>{[0, 1, 2].map((k) => <i key={k} className={k <= ["low", "medium", "high"].indexOf(r.confidence || "") ? "on" : ""} />)}</span></td>
                      <td className="why">
                        {r.flags?.parked && <span className="tag">Parked</span>}
                        {r.flags?.closed && <span className="tag">{r.flags.closed.slice(0, 48)}</span>}
                        {r.flags?.ghost && <span className="tag">{r.flags.ghost.slice(0, 48)}</span>}
                        {r.flags?.moved && <span className="tag mv">{r.flags.moved.slice(0, 48)}</span>}
                        {r.deep && <span className="tag ts">TinySet</span>}
                        {r.error || (!r.flags?.parked && !r.flags?.closed && !r.flags?.ghost && !r.flags?.moved ? (r.reasons || []).slice(0, 2).join(" · ") : "")}
                      </td>
                    </tr>
                    {open === r.i && (
                      <tr><td colSpan={6} style={{ padding: 0, borderBottom: 0 }}>
                        <div className="detail">
                          <div>
                            <span className="eyebrow">Evidence</span>
                            <div className="tl">
                              {(r.signals || []).filter((s) => s.state !== "unknown" || s.note).map((s, k) => (
                                <div key={k} className={s.state}>
                                  <div className="l">{SIGNALS.find((x) => x[0] === s.id)?.[1] || s.id}</div>
                                  <div className="mut tiny">{s.state}{s.date ? ` · ${s.date} (${ago(s.date)})` : ""}{s.note ? ` · ${s.note}` : ""}</div>
                                  {s.url && <a href={s.url} target="_blank" rel="noreferrer">{s.url}</a>}
                                </div>
                              ))}
                            </div>
                          </div>
                          <div>
                            <span className="eyebrow">Why {r.verdict}</span>
                            <div className="score">{r.score}</div>
                            <div className="mut tiny" style={{ marginBottom: 14 }}>6 or more is alive, 3 to 5 slowing, 2 or less zombie</div>
                            {(r.reasons || []).map((x, k) => { const m = x.match(/^(.*?) ([+-]\d+)$/); return <div key={k} className="rs"><span>{m ? m[1] : x}</span>{m && <b className={m[2].startsWith("-") ? "neg" : ""}>{m[2]}</b>}</div>; })}
                            {r.url && <p className="tiny"><a href={/^https?:/.test(r.url) ? r.url : "https://" + r.url} target="_blank" rel="noreferrer">Open the source row</a></p>}
                          </div>
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
          {pages > 1 && <div className="pager"><button className="btn line sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span className="tiny mut">Page {page + 1} of {pages}</span><button className="btn line sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</button></div>}
        </>
      )}
    </main>
  );
}
