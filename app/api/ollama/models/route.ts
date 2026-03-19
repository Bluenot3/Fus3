import { NextResponse } from "next/server";
import { getOllamaBaseUrl, listOllamaModels } from "@/lib/ollama/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const baseUrl = searchParams.get("baseUrl");
    const models = await listOllamaModels(baseUrl);
    return NextResponse.json({ ok: true, baseUrl: getOllamaBaseUrl(baseUrl), models });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to load Ollama models."
      },
      { status: 502 }
    );
  }
}
