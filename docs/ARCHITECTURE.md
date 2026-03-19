# Architecture

## System Overview
ZEN Command Center has four layers:
1. UI Layer: Next.js app with Tailwind dark-glass interface.
2. Data Layer: Provider registry and snapshot aggregator.
3. Realtime Layer: WebSocket stream pushes operational deltas.
4. Security Layer: Supabase + encrypted secrets vault.

## Data Flow
1. Providers implement `ServiceProvider` and register in `lib/providers/registry.ts`.
2. `/api/metrics` collects snapshots and returns system-wide health.
3. Client polls metrics via `useMetricsSnapshot`.
4. Client receives websocket deltas via `useRealtimeSignals`.
5. Widgets merge snapshot baselines + live deltas for operational visibility.

## Security Model
- Secrets are encrypted with AES-256-GCM before storage.
- Raw secret values are never rendered in dashboard widgets.
- Secret endpoints require bearer token (`ZEN_ADMIN_TOKEN`).
- Supabase table RLS policy denies client access by default.

## Extendability
- Add connectors by implementing `ServiceProvider` and calling `registry.register()`.
- For external APIs, place auth + mapping in provider adapters.
- Maintain normalized metrics (`requests_per_min`, `credit_burn`, `token_usage`) for cross-provider analytics.
