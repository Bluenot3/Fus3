"use client";

import { Command, Server, Shield, Plug, Activity } from "lucide-react";
import { useEffect } from "react";

export type CommandAction = {
  id: string;
  label: string;
  hint: string;
  run: () => void;
};

const iconMap = {
  metrics: <Activity className="h-4 w-4 text-zen-cyan" />,
  connectors: <Plug className="h-4 w-4 text-zen-teal" />,
  secrets: <Shield className="h-4 w-4 text-zen-amber" />,
  stream: <Server className="h-4 w-4 text-slate-200" />
};

export function CommandPalette({
  open,
  onClose,
  actions
}: {
  open: boolean;
  onClose: () => void;
  actions: CommandAction[];
}) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 p-6 pt-20" onClick={onClose}>
      <div className="glass-panel w-full max-w-2xl rounded-xl p-4" onClick={(event) => event.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-slate-400">
          <Command className="h-4 w-4 text-zen-cyan" />
          Command Palette
        </div>
        <div className="space-y-2">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => {
                action.run();
                onClose();
              }}
              className="flex w-full items-center justify-between rounded border border-zen-edge/70 bg-slate-950/40 px-3 py-2 text-left hover:border-zen-cyan/80"
            >
              <span className="flex items-center gap-2 text-sm">
                {iconMap[action.id as keyof typeof iconMap] ?? <Activity className="h-4 w-4 text-slate-300" />}
                {action.label}
              </span>
              <span className="text-xs text-slate-400">{action.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
