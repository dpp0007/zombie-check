import { NextResponse } from "next/server";
import { pauseJob, resetJob, startJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// POST { action: "start" | "pause", opts? }  — start also means resume.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  try {
    if (b.action === "pause") pauseJob(id);
    else if (b.action === "reset") (resetJob(id), startJob(id, b.opts));
    else startJob(id, b.opts);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 400 });
  }
}
