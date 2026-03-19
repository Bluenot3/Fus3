import { NextResponse } from "next/server";
import { sendTelegramBotTestMessage } from "@/lib/telegram/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ botId: string }> }
) {
  try {
    const { botId } = await params;
    const payload = (await request.json()) as { chatId?: string; text?: string };
    await sendTelegramBotTestMessage(botId, payload.chatId || "", payload.text || "");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to send Telegram test message." },
      { status: 400 }
    );
  }
}
