import { NextResponse } from "next/server";
import { createTelegramBot, listTelegramBots, type TelegramBotProfileInput } from "@/lib/telegram/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const bots = await listTelegramBots();
    return NextResponse.json({ ok: true, bots });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to load Telegram bots." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as TelegramBotProfileInput;
    const bot = await createTelegramBot(payload);
    return NextResponse.json({ ok: true, bot });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to connect Telegram bot." },
      { status: 400 }
    );
  }
}
