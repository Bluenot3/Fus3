"use client";

import { useEffect, useMemo, useState } from "react";

export type LiveSignal = {
  kind: "model-usage" | "gpu-compute" | "api-credit" | "deployment-status" | "agent-health" | "revenue";
  delta: number;
  timestamp: string;
};

export function useRealtimeSignals() {
  const [signals, setSignals] = useState<LiveSignal[]>([]);

  useEffect(() => {
    const endpoint = process.env.NEXT_PUBLIC_WS_URL ?? "ws://127.0.0.1:8890";
    const socket = new WebSocket(endpoint);

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as LiveSignal;
        setSignals((current) => [payload, ...current].slice(0, 100));
      } catch {
        // Ignore malformed events from external providers.
      }
    };

    return () => socket.close();
  }, []);

  const latestByKind = useMemo(() => {
    const map = new Map<LiveSignal["kind"], LiveSignal>();
    for (const signal of signals) {
      if (!map.has(signal.kind)) {
        map.set(signal.kind, signal);
      }
    }
    return map;
  }, [signals]);

  return { signals, latestByKind };
}
