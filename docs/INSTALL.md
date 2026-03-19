# Installation Guide

## Prerequisites
- Node.js 20+
- npm 10+
- Supabase project

## Setup
1. Install dependencies:
   - `npm install`
2. Configure environment:
   - `cp .env.example .env.local`
3. Create tables:
   - Run SQL from `supabase/schema.sql` in Supabase SQL editor.
4. Start app:
   - `npm run dev`
5. Start realtime server:
   - `npm run dev:ws`

## Optional hardening
- Put `ZEN_ADMIN_TOKEN` behind an internal API gateway.
- Rotate `SECRET_ENCRYPTION_KEY` quarterly.
- Restrict Supabase service role key to server runtime only.
