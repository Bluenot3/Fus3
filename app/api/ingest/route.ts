import { Buffer } from "node:buffer";
import { NextResponse } from "next/server";
import { runKnowledgeIngestion } from "@/lib/knowledge-ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const files = await Promise.all(
      formData
        .getAll("files")
        .filter((value): value is File => value instanceof File && value.size > 0)
        .map(async (file) => {
          const entry = file as File & { webkitRelativePath?: string };
          return {
            name: entry.name,
            relativePath: entry.webkitRelativePath || entry.name,
            mimeType: entry.type,
            bytes: Buffer.from(await entry.arrayBuffer())
          };
        })
    );

    const urls = String(formData.get("urls") || "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);

    const paths = String(formData.get("paths") || "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);

    if (!files.length && !urls.length && !paths.length) {
      return NextResponse.json({ error: "Add at least one file, URL, or local path." }, { status: 400 });
    }

    const result = await runKnowledgeIngestion({ files, urls, paths });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ingestion failed." },
      { status: 500 }
    );
  }
}
