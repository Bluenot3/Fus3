import { NextResponse } from "next/server";
import { deleteTelegramBot, updateTelegramBot } from "@/lib/telegram/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ botId: string }> }
) {
  try {
    const { botId } = await params;
    const payload = (await request.json()) as Record<string, unknown>;
    const bot = await updateTelegramBot(botId, payload);
    return NextResponse.json({ ok: true, bot });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to update Telegram bot." },
      { status: 400 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ botId: string }> }
) {
  try {
    const { botId } = await params;
    await deleteTelegramBot(botId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to delete Telegram bot." },
      { status: 400 }
    );
  }
}
