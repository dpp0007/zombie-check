import { getJob, jobCsv, jobXlsx } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// GET /api/jobs/:id/download            -> CSV
// GET /api/jobs/:id/download?format=xlsx -> Excel (colour-coded verdicts + Summary sheet)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const j = getJob((await params).id);
  if (!j) return new Response("not found", { status: 404 });
  const base = j.name.replace(/[^\w.-]+/g, "_");
  if (new URL(req.url).searchParams.get("format") === "xlsx") {
    const buf = await jobXlsx(j);
    return new Response(new Uint8Array(buf), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${base}.zombie-checked.xlsx"` } });
  }
  return new Response("\uFEFF" + jobCsv(j), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${base}.zombie-checked.csv"` } });
}
