import { NextResponse } from "next/server";
import { createJob, listJobs } from "@/lib/jobs";
import { detectColumns, loadSource, parseCsv } from "@/lib/csv";

export const dynamic = "force-dynamic";
export const GET = () => NextResponse.json(listJobs());

// Body: { name?, csv?: string, sourceUrl?: string } -> creates a job (not started) with detected columns.
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const t = b.csv ? parseCsv(String(b.csv)) : b.sourceUrl ? await loadSource(String(b.sourceUrl)) : null;
    if (!t || !t.rows.length) return NextResponse.json({ error: "No rows found in that source." }, { status: 400 });
    const d = detectColumns(t);
    const j = createJob(b.name || b.sourceUrl?.split("/").slice(-1)[0] || "list", t.headers, t.rows, { ...d, concurrency: 10, deep: true, deepMax: 400 });
    return NextResponse.json({ id: j.id });
  } catch (e: any) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 400 });
  }
}
