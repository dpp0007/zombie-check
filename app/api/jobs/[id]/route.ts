import { NextResponse } from "next/server";
import { getJob, summary } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const j = getJob((await params).id);
  if (!j) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    id: j.id, name: j.name, status: j.status, stage: j.stage, message: j.message, headers: j.headers, opts: j.opts,
    counts: summary(j),
    chunks: j.chunks.map((c) => ({ n: c.rows.length, state: c.state, note: c.note, datasetId: c.datasetId })),
    rows: j.rows.map((r, i) => ({
      i, state: r.state, deep: !!r.deep, error: r.error,
      name: r.cells[j.opts.nameCol] || "", url: r.cells[j.opts.urlCol] || "",
      verdict: r.result?.verdict, confidence: r.result?.confidence, latest: r.result?.latest, score: r.result?.score,
      reasons: r.result?.reasons, signals: r.result?.signals, flags: r.result?.flags,
    })),
  });
}
