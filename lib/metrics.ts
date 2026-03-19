"use client";

import { useEffect, useMemo, useState } from "react";

type MetricsPayload = {
  generatedAt: string;
  totalServices: number;
  healthy: number;
  degraded: number;
  down: number;
  snapshots: Array<{
    service: { id: string; name: string; category: string; enabled: boolean };
    metrics: Array<{ key: string; value: number; unit: string; timestamp: string }>;
    health: { status: "healthy" | "degraded" | "down"; latencyMs: number; lastSync: string };
  }>;
};

export function useMetricsSnapshot(intervalMs = 10000) {
  const [payload, setPayload] = useState<MetricsPayload | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch("/api/metrics", { cache: "no-store" });
        const data = (await response.json()) as MetricsPayload;
        if (!cancelled) {
          setPayload(data);
        }
      } catch {
        if (!cancelled) {
          setPayload(null);
        }
      }
    };

    void load();
    const timer = setInterval(load, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs]);

  const aggregate = useMemo(() => {
    if (!payload) {
      return {
        totalRPM: 0,
        totalCreditBurn: 0,
        totalTokenUsage: 0,
        avgLatencyMs: 0,
        healthRatio: 0,
        enabledCount: 0,
        revenueEstimate: 0
      };
    }

    const allMetrics = payload.snapshots.flatMap((item) => item.metrics);
    const totalRPM = allMetrics.filter((m) => m.key === "requests_per_min").reduce((acc, item) => acc + item.value, 0);
    const totalCreditBurn = allMetrics.filter((m) => m.key === "credit_burn").reduce((acc, item) => acc + item.value, 0);
    const totalTokenUsage = allMetrics.filter((m) => m.key === "token_usage").reduce((acc, item) => acc + item.value, 0);
    const avgLatencyMs = payload.snapshots.reduce((acc, item) => acc + item.health.latencyMs, 0) / Math.max(payload.snapshots.length, 1);
    const enabledCount = payload.snapshots.filter((item) => item.service.enabled).length;
    const healthRatio = payload.healthy / Math.max(payload.totalServices, 1);

    return {
      totalRPM,
      totalCreditBurn,
      totalTokenUsage,
      avgLatencyMs,
      healthRatio,
      enabledCount,
      revenueEstimate: totalCreditBurn * 4.2
    };
  }, [payload]);

  return { payload, aggregate };
}
