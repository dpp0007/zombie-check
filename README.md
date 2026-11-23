# Zombie Check

Give it a spreadsheet (500+ rows). Get it back with a verdict on every row (**alive / slowing down / zombie**), the date of the latest activity found, and links to the evidence. Every signal comes from a live page (TinyFish Fetch with `ttl: 0`) or a live search, never a cached database.

## Run

```bash
cp .env.example .env.local      # add TINYFISH_API_KEY (personal key: https://agent.tinyfish.ai/api-keys)
npm install
npm run dev                     # http://localhost:3000
npm test                        # offline self-check of scoring, date parsing, URL cleanup, list import
```

Load a CSV, a public Google Sheet link, a raw CSV URL, or a GitHub "awesome" README (`https://github.com/vinta/awesome-python` gives 564 rows). Check the auto-detected columns, press **Start check**, then **Download CSV** at any time (partial results included).
A list of job-posting URLs switches to **ghost-job mode** automatically.

## Signals (10 per row, each with a date and a link)

| Signal | Source |
|---|---|
| Site live, redirects, parked domain, "acquired / shutting down" banner | **Fetch** homepage, `final_url`, page text |
| Repository: latest commit, latest release, archived | **Fetch** `github.com/o/r`, `commits.atom`, `releases.atom` |
| Latest blog / news / press post | **Fetch** the site's blog page, newest date |
| Latest release / changelog | **Fetch** changelog / releases page |
| Open jobs | **Fetch** careers page or ATS board (Greenhouse, Lever, Ashby…) |
| Social / community activity | **Fetch** GitHub org + **Search** over X, LinkedIn, YouTube, Reddit, HN (180 days) |
| Sign-up still works | **Fetch** the sign-up page: form present, not "closed" |
| Sitemap `lastmod` | **Fetch** `/sitemap.xml`, newest page update |
| RSS / Atom feed | **Fetch** the feed linked from the homepage (dated posts) |
| Package release | **Fetch** PyPI / npm registry JSON, trusted only when the package links back to the same GitHub repo |
| Press / mentions | **Search** with `recency_minutes` |

**Scoring** (`lib/check.ts`, `evaluate`): each signal adds points by freshness (≤90 d / ≤180 d / ≤365 d). 6+ alive, 3–5 slowing, ≤2 zombie. Confidence is high/medium/low by how many signals were readable.
**Hard overrides to zombie:** parked/for-sale domain, acquired or shut-down notice, definitive 404/DNS failure, archived repo.
**Not a zombie by guess:** timeouts, bot blocks and unreadable commit feeds are retried once and marked "unknown", never "dead"; a row that could only be blocked is reported as *slowing, low confidence*. Press mentions from mirror / directory sites (git404hub, Crunchbase, archive.org…) and undated mentions of repos are ignored, so they cannot fake or inflate activity. Rows with no valid URL get a low-confidence verdict that says so.

## Edge cases
- **Redirects / rebrands / acquisitions:** a redirect to a different registrable domain is followed, the new domain is what gets checked, and `notes_redirect_acquisition` records it (`parse.com redirects to parseplatform.org`). A live search for acquisition/shutdown news is run when a site is dead or moved; the phrase must be about *this* company.
- **Parked domains:** for-sale/parking text on a thin page, or a redirect to a domain marketplace.
- **Shared hosts** (`*.onrender.com`, `*.github.io`, `*.vercel.app`…) count as separate sites, not as a redirect.
- **Dirty sheets:** `owner/repo: description`, trailing dots, stray spaces in URLs are repaired; unusable cells are reported, not guessed.
- **Ghost jobs:** posting removed (404, "no longer accepting", redirected to a page that no longer names the job), or posted >90 days ago, or no posting date visible.

## How TinySet is used
After the fast sweep, **every real company/site row** goes to **TinySet** (`POST /v1/datasets`), plus every GitHub repo the sweep is not confident is alive (default up to 400 rows, adjustable to 800). Rows go in 40-entry batches, 3 datasets at a time (the account limit). The prompt pins the exact domains / `github.com/owner/repo` paths; the spec asks for latest post / release / social dates, open jobs, sign-up status, a status note (acquired, rebranded, deprecated, shut down) and a **source URL** per row. When a dataset is `ready`, its rows are read back (columns matched by type and keyword, because TinySet may rename them), merged as extra signals with that source link, and the verdict is recomputed (a dated post/release within a year lifts a row out of "zombie"; an "acquired / deprecated / shut down" note forces it). The output column `tinyset_verified` says which rows went through it. Batches are saved by dataset id, so a resume re-attaches to the same dataset instead of paying twice. If TinySet isn't enabled for the key, the job still finishes with Fetch + Search verdicts and says why.

## Output columns added
`zombie_verdict, zombie_confidence, latest_activity_date, evidence_links, signals_found, verdict_reasons, notes_redirect_acquisition, checked_url, checked_at`. Original columns are untouched and in the same order.

## Scale and resume
~45 rows/minute at 12 parallel rows (564 rows ≈ 12 min plus TinySet). State is saved atomically to `.data/jobs/<id>.json` every 5 rows and after each TinySet batch. Pause, close the tab, or kill the server, then reopen the job under *Resume a run* and press **Resume**: finished rows are skipped, errored rows retried. 429/5xx are retried with backoff, one bad row never stops the run, and an invalid key or empty wallet stops the job with a clear message.

## Notes
- Free allowances: Fetch 1,000 URLs/day, Search 12,000/day. A row uses about 3–5 Fetch URLs, so a 564-row run goes past the free Fetch allowance into the wallet.
- Single-process job runner (`next dev` / `next start`): use a long-lived Node host, not serverless.
- X and LinkedIn are login-walled, so social activity is read from GitHub and live search results.

## Extra scope
- **XLSX export** (`/api/jobs/:id/download?format=xlsx`): colour-coded verdicts, clickable evidence link, frozen header, filters, and a *Summary* sheet (verdict counts, confidence, TinySet coverage, signal coverage). CSV is still available.
- **Stateless API** `POST /api/check` with `{"rows":[{"name":"Stripe","url":"stripe.com"}],"jobMode":false}` returns verdict, confidence, latest date, evidence links and every signal for up to 25 rows, live.
- **Ghost-job upgrades:** stated expiry ("valid through", "apply by") in the past, "reposted" listings, relative "posted N days ago" dates, and a cross-check that the job is still listed on the company's own board (Greenhouse / Lever / Ashby / Workable / `/careers`).
