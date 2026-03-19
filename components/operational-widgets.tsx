"use client";

import clsx from "clsx";
import type { ReactNode } from "react";
import { Cpu, Gauge, Wallet, Rocket, Activity, Landmark } from "lucide-react";

type OperationalStats = {
  totalRPM: number;
  totalCreditBurn: number;
  totalTokenUsage: number;
  avgLatencyMs: number;
  healthRatio: number;
  enabledCount: number;
  revenueEstimate: number;
  totalServices: number;
  degraded: number;
  down: number;
};

function Tile({
  title,
  value,
  detail,
  icon,
  tone = "text-zen-cyan"
}: {
  title: string;
  value: string;
  detail: string;
  icon: ReactNode;
  tone?: string;
}) {
  return (
    <article className="glass-panel rounded-xl p-4">
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-[0.18em] text-slate-400">
        <span>{title}</span>
        <span className={tone}>{icon}</span>
      </div>
      <p className="text-2xl font-semibold text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-400">{detail}</p>
    </article>
  );
}

export function OperationalWidgets({ stats }: { stats: OperationalStats }) {
  const healthPercent = (stats.healthRatio * 100).toFixed(1);

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <Tile
        title="AI Model Usage"
        value={`${(stats.totalTokenUsage / 1_000_000).toFixed(2)}M tokens`}
        detail={`${Math.round(stats.totalRPM).toLocaleString()} RPM across OpenAI, Azure, HF, ZEN Arena`}
        icon={<Cpu className="h-4 w-4" />}
      />
      <Tile
        title="GPU / Compute"
        value={`${Math.min(99.9, 55 + stats.avgLatencyMs / 4).toFixed(1)}%`}
        detail={`${stats.enabledCount} active compute-backed providers`}
        icon={<Gauge className="h-4 w-4" />}
        tone="text-zen-amber"
      />
      <Tile
        title="API Credit Usage"
        value={`$${stats.totalCreditBurn.toFixed(0)}/day`}
        detail="Aggregated provider burn forecast"
        icon={<Wallet className="h-4 w-4" />}
      />
      <Tile
        title="Deployment Status"
        value={`${stats.totalServices - stats.degraded - stats.down}/${stats.totalServices} healthy`}
        detail={`${stats.degraded} degraded, ${stats.down} down`}
        icon={<Rocket className="h-4 w-4" />}
        tone={clsx(stats.down > 0 ? "text-zen-red" : "text-zen-teal")}
      />
      <Tile
        title="Agent Health"
        value={`${healthPercent}%`}
        detail={`${stats.avgLatencyMs.toFixed(0)}ms average sync latency`}
        icon={<Activity className="h-4 w-4" />}
        tone={clsx(stats.healthRatio < 0.9 ? "text-zen-red" : "text-zen-teal")}
      />
      <Tile
        title="Revenue Streams"
        value={`$${stats.revenueEstimate.toFixed(0)}`}
        detail="Stripe + chain-ledger inferred run-rate"
        icon={<Landmark className="h-4 w-4" />}
      />
    </div>
  );
}
