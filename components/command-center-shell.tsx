"use client";

import { Command, LayoutGrid, Move, Search, Signal } from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent } from "react";
import clsx from "clsx";
import { defaultWidgets, type WidgetConfig } from "@/lib/widgets";
import { useRealtimeSignals } from "@/lib/realtime";
import { useMetricsSnapshot } from "@/lib/metrics";
import { OperationalWidgets } from "@/components/operational-widgets";
import { CommandPalette, type CommandAction } from "@/components/command-palette";

type ProviderSummary = {
  total: number;
  providers: Array<{ id: string; name: string; category: string; enabled: boolean }>;
};

const statusTone: Record<WidgetConfig["status"], string> = {
  ok: "text-zen-teal",
  warn: "text-zen-amber",
  critical: "text-zen-red"
};

function WidgetCard({ widget, onDragStart, onDrop, onDragOver, liveDelta }: {
  widget: WidgetConfig;
  onDragStart: (id: string) => void;
  onDrop: (id: string) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  liveDelta?: number;
}) {
  const deltaText = liveDelta === undefined ? widget.trend : `${liveDelta >= 0 ? "+" : ""}${liveDelta.toFixed(2)} live`;

  return (
    <div
      draggable
      onDragStart={() => onDragStart(widget.id)}
      onDrop={() => onDrop(widget.id)}
      onDragOver={onDragOver}
      className="glass-panel group rounded-xl p-4 transition hover:border-zen-cyan/80"
    >
      <div className="mb-3 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-400">
        <span>{widget.kind.replace("-", " ")}</span>
        <Move className="h-3.5 w-3.5 opacity-40 transition group-hover:opacity-100" />
      </div>
      <p className="text-sm text-slate-200">{widget.title}</p>
      <p className="mt-2 text-3xl font-semibold text-white">{widget.value}</p>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-slate-400">{widget.detail}</span>
        <span className={clsx("font-semibold", statusTone[widget.status])}>{deltaText}</span>
      </div>
    </div>
  );
}

export function CommandCenterShell() {
  const [widgets, setWidgets] = useState(defaultWidgets);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [providers, setProviders] = useState<ProviderSummary>({ total: 0, providers: [] });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { signals, latestByKind } = useRealtimeSignals();
  const { payload, aggregate } = useMetricsSnapshot();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
    };

    window.addEventListener("keydown", onKey);

    fetch("/api/connectors")
      .then((response) => response.json())
      .then((data: ProviderSummary) => setProviders(data))
      .catch(() => {
        // Keep zero state if registry endpoint is unavailable.
      });

    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const populatedWidgets = useMemo(() => {
    return widgets.map((widget) => {
      switch (widget.kind) {
        case "model-usage":
          return { ...widget, value: `${(aggregate.totalTokenUsage / 1_000_000).toFixed(2)}M tokens` };
        case "gpu-compute":
          return { ...widget, value: `${Math.min(99.9, 55 + aggregate.avgLatencyMs / 4).toFixed(1)}%` };
        case "api-credit":
          return { ...widget, value: `$${aggregate.totalCreditBurn.toFixed(0)}/day` };
        case "deployment-status":
          return {
            ...widget,
            value: `${payload ? payload.totalServices - payload.degraded - payload.down : 0}/${payload?.totalServices ?? 0} healthy`
          };
        case "agent-health":
          return { ...widget, value: `${(aggregate.healthRatio * 100).toFixed(1)}%` };
        case "revenue":
          return { ...widget, value: `$${aggregate.revenueEstimate.toFixed(0)}` };
        default:
          return widget;
      }
    });
  }, [aggregate, payload, widgets]);

  const visible = useMemo(() => {
    if (!query.trim()) {
      return populatedWidgets;
    }
    const q = query.toLowerCase();
    return populatedWidgets.filter((w) => `${w.title} ${w.kind} ${w.detail}`.toLowerCase().includes(q));
  }, [query, populatedWidgets]);

  const reorder = (targetId: string) => {
    if (!draggingId || draggingId === targetId) {
      return;
    }
    const clone = [...widgets];
    const from = clone.findIndex((w) => w.id === draggingId);
    const to = clone.findIndex((w) => w.id === targetId);
    if (from < 0 || to < 0) {
      return;
    }
    const [item] = clone.splice(from, 1);
    clone.splice(to, 0, item);
    setWidgets(clone);
    setDraggingId(null);
  };

  const actions: CommandAction[] = [
    { id: "metrics", label: "Open Metrics API", hint: "/api/metrics", run: () => window.open("/api/metrics", "_blank") },
    { id: "connectors", label: "Open Connectors API", hint: "/api/connectors", run: () => window.open("/api/connectors", "_blank") },
    { id: "secrets", label: "Open Secrets API", hint: "/api/secrets", run: () => window.open("/api/secrets", "_blank") },
    { id: "stream", label: "Realtime Stream Setup", hint: "npm run dev:ws", run: () => setQuery("realtime") }
  ];

  return (
    <main className="grid-overlay min-h-screen p-6 text-slate-100 md:p-8">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-4">
        <header className="glass-panel rounded-2xl p-4 md:p-5">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.35em] text-zen-cyan/90">ZEN Command Center</p>
              <h1 className="mt-1 text-xl font-semibold md:text-2xl">Global Operations Fabric</h1>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-zen-edge/80 bg-slate-950/50 px-2 py-1 text-xs text-slate-300">
              <LayoutGrid className="h-4 w-4 text-zen-cyan" />
              {providers.total || 50}+ Integrated Services
            </div>
          </div>

          <label className="flex items-center gap-2 rounded-lg border border-zen-edge/80 bg-slate-950/60 px-3 py-2">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Command palette: filter widgets, services, connectors..."
              className="w-full bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
            />
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="flex items-center gap-1 rounded border border-zen-edge px-2 py-0.5 text-[10px] tracking-[0.15em] text-slate-400"
            >
              <Command className="h-3 w-3" />K
            </button>
          </label>
        </header>

        <OperationalWidgets
          stats={{
            ...aggregate,
            totalServices: payload?.totalServices ?? 0,
            degraded: payload?.degraded ?? 0,
            down: payload?.down ?? 0
          }}
        />

        <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-2">
            {visible.map((widget) => (
              <WidgetCard
                key={widget.id}
                widget={widget}
                onDragStart={setDraggingId}
                onDrop={reorder}
                onDragOver={(event) => event.preventDefault()}
                liveDelta={latestByKind.get(widget.kind)?.delta}
              />
            ))}
          </div>

          <aside className="glass-panel rounded-xl p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">Realtime Feed</p>
              <Signal className="h-4 w-4 text-zen-cyan" />
            </div>
            <div className="space-y-2 text-xs">
              {signals.slice(0, 8).map((signal) => (
                <div key={`${signal.kind}-${signal.timestamp}`} className="rounded border border-zen-edge/60 bg-slate-950/40 p-2">
                  <p className="uppercase tracking-[0.18em] text-slate-400">{signal.kind}</p>
                  <p className={clsx("mt-1 font-semibold", signal.delta >= 0 ? "text-zen-teal" : "text-zen-red")}>{signal.delta >= 0 ? "+" : ""}{signal.delta.toFixed(2)}</p>
                </div>
              ))}
              {!signals.length && <p className="text-slate-400">Waiting for websocket stream...</p>}
            </div>
          </aside>
        </div>

        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={actions} />
      </section>
    </main>
  );
}
