import assert from "node:assert/strict";
import { extractDates, iso } from "./dates.ts";
import { evaluate, regDomain, normUrl } from "./check.ts";
import { fromMarkdown, detectColumns } from "./csv.ts";

const now = new Date("2026-11-15");
const d = extractDates("Posted Mar 5, 2026 and 12 January 2025 and 2024-07-01 and Jan 1, 2099");
assert.deepEqual(d.map(iso).sort(), ["2024-07-01", "2025-01-12", "2026-03-05"]);
assert.equal(regDomain("www.foo.co.uk"), "foo.co.uk");

const S = (id: any, state: any, date?: string): any => ({ id, state, date });
const alive = evaluate([S("site", "fresh"), S("blog", "fresh", "2026-10-20"), S("jobs", "fresh", "2026-10-01"), S("signup", "fresh"), S("social", "fresh", "2026-10-30")], {}, now);
assert.equal(alive.verdict, "alive");
const slow = evaluate([S("site", "fresh"), S("blog", "stale", "2025-12-01"), S("signup", "fresh"), S("jobs", "none")], {}, now);
assert.equal(slow.verdict, "slowing");
const zombie = evaluate([S("site", "fresh"), S("blog", "stale", "2022-01-01"), S("signup", "none")], {}, now);
assert.equal(zombie.verdict, "zombie");
assert.equal(evaluate([S("site", "fresh"), S("blog", "fresh", "2026-11-01")], { parked: true }, now).verdict, "zombie");
assert.equal(evaluate([S("site", "fresh")], { closed: "acquired by X" }, now).verdict, "zombie");

const t = fromMarkdown("## Tools\n- [Foo](https://foo.com) - a tool\n- [Bar](https://bar.io/x)\n- [Badge](https://img.shields.io/x)\n");
assert.equal(t.rows.length, 2);
assert.equal(detectColumns(t).urlCol, "url");
assert.deepEqual(extractDates("<updated>2026-10-29T02:35:05Z</updated>").map(iso), ["2026-10-29"]);
assert.equal(normUrl("github.com/a/b- c"), "https://github.com/a/b-c");
assert.equal(normUrl("github.com/KritikaTech123/ai-shield."), "https://github.com/KritikaTech123/ai-shield");
assert.equal(normUrl("suriya-127/STUDENT-SYSTEM: An AI-powered thing"), "https://github.com/suriya-127/STUDENT-SYSTEM");
assert.equal(normUrl("Hello world"), "");
assert.equal(evaluate([], { invalid: true }, now).confidence, "low");
// blocked / timed-out checks are never called zombie by guess
const tr = evaluate([S("site", "unknown")], { transient: true }, now);
assert.equal(tr.verdict, "slowing");
assert.equal(tr.confidence, "low");
const sm = evaluate([S("site", "fresh"), S("sitemap", "fresh", "2026-11-01"), S("signup", "fresh")], {}, now);
assert.equal(sm.verdict, "slowing"); // a fresh sitemap alone is not enough to be "alive"
console.log("selftest ok");
