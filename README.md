# ZEN Command Center

Unified operational command dashboard for 50+ internal and external services across AI, infra, billing, analytics, and blockchain systems.

## Stack
- Next.js (App Router, TypeScript)
- TailwindCSS
- Supabase (metrics/secrets persistence)
- WebSockets (real-time feed)
- Vercel (deployment)

## Repo Structure
```text
zen-command-center/
├─ app/
│  ├─ api/
│  │  ├─ connectors/route.ts
│  │  ├─ metrics/route.ts
│  │  └─ secrets/
│  │     ├─ [serviceId]/route.ts
│  │     └─ route.ts
│  ├─ globals.css
│  ├─ layout.tsx
│  └─ page.tsx
├─ components/
│  ├─ command-center-shell.tsx
│  ├─ command-palette.tsx
│  └─ operational-widgets.tsx
├─ lib/
│  ├─ metrics.ts
│  ├─ realtime.ts
│  ├─ widgets.ts
│  ├─ providers/
│  │  ├─ builtin.ts
│  │  ├─ catalog.ts
│  │  ├─ provider.ts
│  │  └─ registry.ts
│  ├─ secrets/
│  │  ├─ crypto.ts
│  │  └─ manager.ts
│  └─ supabase/server.ts
├─ realtime/mock-stream-server.js
├─ supabase/schema.sql
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ INSTALL.md
│  └─ PLUGINS.md
├─ .env.example
├─ vercel.json
└─ package.json
```

## Installation
1. `cd zen_local_intelligence/zen-command-center`
2. `npm install`
3. Copy `.env.example` to `.env.local` and fill values.
4. Apply Supabase schema from `supabase/schema.sql`.
5. Run Next.js: `npm run dev`
6. Run websocket stream: `npm run dev:ws`

## Environment Configuration
```bash
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:8890

SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

SECRET_ENCRYPTION_KEY=
ZEN_ADMIN_TOKEN=
```

## Features
- Palantir-style dark glass interface
- Drag and drop widget board
- Keyboard command palette (`Ctrl/Cmd + K`)
- Real-time websocket signal feed
- Modular provider plugin registry
- Secure encrypted secret manager
- API endpoints for metrics, connectors, and secret operations

## Deployment (Vercel)
- `vercel.json` config is included.
- GitHub Action deploy file is at `.github/workflows/deploy-vercel.yml`.
- Set these repo secrets:
  - `VERCEL_TOKEN`
  - `VERCEL_ORG_ID`
  - `VERCEL_PROJECT_ID`

Detailed docs are in `/docs`.
