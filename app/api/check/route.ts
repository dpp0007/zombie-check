import { NextResponse } from "next/server";
import { checkRow } from "@/lib/check";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Stateless API: POST /api/check  { "rows": [{ "name": "Stripe", "url": "stripe.com" }], "jobMode": false }
// Up to 25 rows per call, checked live in parallel. For bigger sheets use /api/jobs (resumable).
export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const rows: { name?: string; url?: string }[] = Array.isArray(b?.rows) ? b.rows.slice(0, 25) : [];
  if (!rows.length) return NextResponse.json({ error: 'send {"rows":[{"name","url"}]}' }, { status: 400 });
  const results = await Promise.all(
    rows.map(async (r) => {
      try {
        const x = await checkRow({ name: String(r.name || ""), url: String(r.url || ""), jobMode: !!b.jobMode });
        const evidence = [...new Set(x.signals.filter((s) => s.url && s.state !== "unknown").map((s) => s.url!))];
        return { name: r.name, url: r.url, verdict: x.verdict, confidence: x.confidence, latest_activity_date: x.latest || null, evidence_links: evidence, reasons: x.reasons, notes: [x.flags.moved, x.flags.closed, x.flags.ghost, x.flags.parked && "parked domain"].filter(Boolean), signals: x.signals, checked_at: x.checkedAt };
      } catch (e: any) {
        return { name: r.name, url: r.url, error: String(e?.message || e) };
      }
    }),
  );
  return NextResponse.json({ results });
}
