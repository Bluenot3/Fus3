create table if not exists public.service_secrets (
  service_id text not null,
  key_name text not null,
  encrypted_value text not null,
  updated_at timestamptz not null default now(),
  primary key (service_id, key_name)
);

alter table public.service_secrets enable row level security;

create policy "service_secrets_deny_client_access"
  on public.service_secrets
  for all
  to authenticated
  using (false)
  with check (false);
