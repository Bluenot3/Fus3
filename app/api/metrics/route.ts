import { NextResponse } from "next/server";
import { registry } from "@/lib/providers/registry";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshots = await registry.collectAll();
  const response = {
    generatedAt: new Date().toISOString(),
    totalServices: snapshots.length,
    healthy: snapshots.filter((item) => item.health.status === "healthy").length,
    degraded: snapshots.filter((item) => item.health.status === "degraded").length,
    down: snapshots.filter((item) => item.health.status === "down").length,
    snapshots
  };

  return NextResponse.json(response);
}
