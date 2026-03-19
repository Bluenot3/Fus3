import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const zipPath = path.join(process.cwd(), "storage", "jobs", jobId, `${jobId}-markdown.zip`);

  try {
    const bytes = await readFile(zipPath);
    return new NextResponse(bytes, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${jobId}-markdown.zip"`
      }
    });
  } catch {
    return NextResponse.json({ error: "Export not found." }, { status: 404 });
  }
}
