import { NextResponse } from "next/server";
import { applyTelegramBotCommands } from "@/lib/telegram/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ botId: string }> }
) {
  try {
    const { botId } = await params;
    const payload = (await request.json()) as { commands?: Array<{ command: string; description: string }> };
    const result = await applyTelegramBotCommands(botId, payload.commands);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to apply Telegram commands." },
      { status: 400 }
    );
  }
}
