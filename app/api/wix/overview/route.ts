import { NextResponse } from "next/server";
import { WixConfigurationError, getWixOverview } from "@/lib/wix/client";

export async function GET() {
  try {
    const overview = await getWixOverview();
    return NextResponse.json({ ok: true, overview });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected Wix error";
    const status = error instanceof WixConfigurationError ? 400 : 502;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
