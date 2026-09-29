-- 0008 — IA por equipe via OpenRouter: chave (cifrada) e modelos escolhidos na Administração,
-- e registro de consumo sem conteúdo.
--
-- A chave chega cifrada pela aplicação (AES-256-GCM, AI_SECRETS_KEY fora do banco); aqui fica só o
-- texto cifrado e os 4 últimos caracteres para identificação. Só o administrador (org.manage) lê e
-- altera a configuração. Os recursos de IA usados pela equipe obtêm a configuração ativa por
-- app.ai_config(), que exige vínculo ativo no tenant da transação.
-- O consumo (app.ai_usage) guarda recurso, modelo, tokens e custo — nunca o texto enviado ou recebido.

create table app.tenant_ai_settings (
  tenant_id uuid primary key references app.tenants(id),
  enabled boolean not null default false,
  api_key_enc text check (api_key_enc is null or length(api_key_enc) <= 1000),
  key_hint text check (key_hint is null or length(key_hint) <= 8),
  model text check (model is null or model ~ '^[A-Za-z0-9._:/-]{3,120}$'),
  transcription_model text check (transcription_model is null or transcription_model ~ '^[A-Za-z0-9._:/-]{3,120}$'),
  -- Só provedores sem retenção de dados (roteamento zdr do OpenRouter). Ligado por padrão.
  zero_retention boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references app.users(id),
  check (not enabled or (api_key_enc is not null and model is not null))
);
alter table app.tenant_ai_settings enable row level security;

create policy tenant_ai_settings_select on app.tenant_ai_settings for select
  using (tenant_id = app.current_tenant_id() and app.has_cap(tenant_id, null, 'org.manage'));
create policy tenant_ai_settings_insert on app.tenant_ai_settings for insert
  with check (tenant_id = app.current_tenant_id() and app.has_cap(tenant_id, null, 'org.manage'));
create policy tenant_ai_settings_update on app.tenant_ai_settings for update
  using (tenant_id = app.current_tenant_id() and app.has_cap(tenant_id, null, 'org.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_cap(tenant_id, null, 'org.manage'));
grant select, insert, update on app.tenant_ai_settings to evolu_app;

-- Configuração ativa para quem usa IA na equipe (não só o admin). Devolve a chave ainda cifrada.
create function app.ai_config()
returns table (model text, transcription_model text, zero_retention boolean, api_key_enc text)
language sql stable security definer set search_path = pg_catalog, app as $$
  select s.model, s.transcription_model, s.zero_retention, s.api_key_enc
  from app.tenant_ai_settings s
  where s.tenant_id = app.current_tenant_id() and s.enabled and app.is_active_member(s.tenant_id)
$$;
revoke all on function app.ai_config() from public;
grant execute on function app.ai_config() to evolu_app;

create table app.ai_usage (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  user_id uuid not null references app.users(id),
  feature text not null check (feature ~ '^[a-z0-9_.]{2,60}$'),
  model text not null check (length(model) <= 120),
  input_tokens int,
  output_tokens int,
  cost_usd numeric(12, 6),
  ok boolean not null,
  created_at timestamptz not null default now()
);
create index ai_usage_tenant_idx on app.ai_usage (tenant_id, created_at);
alter table app.ai_usage enable row level security;

create policy ai_usage_insert on app.ai_usage for insert
  with check (tenant_id = app.current_tenant_id() and app.is_active_member(tenant_id) and user_id = app.current_user_id());
create policy ai_usage_select on app.ai_usage for select
  using (tenant_id = app.current_tenant_id() and app.has_cap(tenant_id, null, 'org.manage'));
grant select, insert on app.ai_usage to evolu_app;
