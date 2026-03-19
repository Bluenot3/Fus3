import { NextResponse } from "next/server";
import { registry } from "@/lib/providers/registry";

export async function GET() {
  const providers = registry.listProviders().map((provider) => provider.definition);
  return NextResponse.json({ total: providers.length, providers });
}
