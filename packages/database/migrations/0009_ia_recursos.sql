-- 0009 — Recursos de IA sobre a configuração da 0008. Tudo o que a IA gera é proposta:
-- * app.document_extractions: leitura (OCR) de foto/PDF anexado, classificada e com destino sugerido;
--   só vira informação do paciente quando alguém com clinical.write confirma.
-- * app.encounter_reports: relatório da internação (para o paciente ou para cobrança). Rascunho
--   editável pelo autor; emitido = imutável, com hash. Envio é sempre feito pelo médico.
-- * tasks.source = 'ia': tarefas sugeridas nascem 'proposed' e só entram na rotina se aprovadas.

create table app.document_extractions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  service_id uuid not null,
  encounter_id uuid not null,
  service_episode_id uuid not null,
  document_id uuid not null,
  category text not null check (category in ('laboratorio', 'imagem', 'laudo', 'medicacoes', 'relatorio_externo', 'outro')),
  target text not null check (target in ('resultados_revistos', 'antecedentes', 'contexto', 'nenhum')),
  title text not null check (length(title) between 1 and 200),
  exam_date date,
  summary text not null check (length(summary) between 1 and 8000),
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  status text not null default 'proposed' check (status in ('proposed', 'confirmed', 'discarded')),
  model text not null check (length(model) <= 120),
  created_by uuid not null references app.users(id),
  created_at timestamptz not null default now(),
  reviewed_by uuid references app.users(id),
  reviewed_at timestamptz,
  version int not null default 1,
  unique (document_id),
  foreign key (tenant_id, service_episode_id, encounter_id, service_id, hospital_id)
    references app.service_episodes (tenant_id, id, encounter_id, service_id, hospital_id),
  foreign key (tenant_id, document_id) references app.source_documents (tenant_id, id),
  check ((status = 'proposed') = (reviewed_by is null))
);
create index document_extractions_episode on app.document_extractions (tenant_id, service_episode_id, status);

create function app.document_extractions_guard() returns trigger
language plpgsql set search_path = pg_catalog, app as $$
begin
  if new.tenant_id <> old.tenant_id or new.service_episode_id <> old.service_episode_id or new.document_id <> old.document_id then
    raise exception 'escopo da extração não pode mudar' using errcode = 'P0001';
  end if;
  if old.status <> 'proposed' then
    raise exception 'extração já revisada' using errcode = 'P0001';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'versão da extração deve ser incrementada' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger document_extractions_guard before update on app.document_extractions
  for each row execute function app.document_extractions_guard();

alter table app.document_extractions enable row level security;
create policy document_extractions_select on app.document_extractions for select
  using (app.has_cap(tenant_id, service_id, 'clinical.read'));
create policy document_extractions_insert on app.document_extractions for insert
  with check (created_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'clinical.write'));
create policy document_extractions_update on app.document_extractions for update
  using (app.has_cap(tenant_id, service_id, 'clinical.write'))
  with check (app.has_cap(tenant_id, service_id, 'clinical.write')
              and (status = 'proposed' or reviewed_by = app.current_user_id()));
grant select, insert, update on app.document_extractions to evolu_app;

create table app.encounter_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  service_id uuid not null,
  encounter_id uuid not null,
  service_episode_id uuid not null,
  purpose text not null check (purpose in ('paciente', 'cobranca')),
  status text not null default 'draft' check (status in ('draft', 'issued')),
  body text not null check (length(body) between 1 and 40000),
  author_id uuid not null references app.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  issued_at timestamptz,
  issued_by uuid references app.users(id),
  body_sha256 text,
  version int not null default 1,
  foreign key (tenant_id, service_episode_id, encounter_id, service_id, hospital_id)
    references app.service_episodes (tenant_id, id, encounter_id, service_id, hospital_id),
  check ((status = 'issued') = (issued_at is not null and issued_by is not null and body_sha256 is not null))
);
create index encounter_reports_episode on app.encounter_reports (tenant_id, service_episode_id, created_at desc);
create trigger encounter_reports_touch before update on app.encounter_reports for each row execute function app.touch_updated_at();

create function app.encounter_reports_guard() returns trigger
language plpgsql set search_path = pg_catalog, app as $$
begin
  if new.tenant_id <> old.tenant_id or new.service_episode_id <> old.service_episode_id or new.author_id <> old.author_id
     or new.purpose <> old.purpose then
    raise exception 'escopo do relatório não pode mudar' using errcode = 'P0001';
  end if;
  if old.status = 'issued' then
    raise exception 'relatório emitido é imutável' using errcode = 'P0001';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'versão do relatório deve ser incrementada' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger encounter_reports_guard before update on app.encounter_reports
  for each row execute function app.encounter_reports_guard();

alter table app.encounter_reports enable row level security;
create policy encounter_reports_select on app.encounter_reports for select
  using (app.has_cap(tenant_id, service_id, 'clinical.read') and (status = 'issued' or author_id = app.current_user_id()));
create policy encounter_reports_insert on app.encounter_reports for insert
  with check (author_id = app.current_user_id() and status = 'draft' and app.has_cap(tenant_id, service_id, 'clinical.write'));
-- Só o autor mexe no rascunho; emitir exige note.finalize (médico que assina a evolução).
create policy encounter_reports_update on app.encounter_reports for update
  using (status = 'draft' and author_id = app.current_user_id() and app.has_cap(tenant_id, service_id, 'clinical.write'))
  with check (author_id = app.current_user_id() and app.has_cap(tenant_id, service_id, 'clinical.write')
              and (status = 'draft' or (issued_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'note.finalize'))));
grant select, insert, update on app.encounter_reports to evolu_app;

alter table app.tasks drop constraint tasks_source_check;
alter table app.tasks add constraint tasks_source_check check (source in ('manual', 'nota', 'passagem', 'proposta', 'ia'));
-- Sugestão da IA sempre nasce proposta (aprovação = proposed → open, pelo médico).
create function app.tasks_ia_insert_guard() returns trigger
language plpgsql set search_path = pg_catalog, app as $$
begin
  if new.source = 'ia' and new.status <> 'proposed' then
    raise exception 'tarefa sugerida pela IA nasce como proposta' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger tasks_ia_insert_guard before insert on app.tasks for each row execute function app.tasks_ia_insert_guard();
