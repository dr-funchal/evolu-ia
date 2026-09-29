-- 0003 — Censo, acompanhamento, problemas, notas (rascunho → versão final imutável → adendo),
-- tarefas, passagem de caso, documentos e exportações.
--
-- Chaves compostas: toda referência entre entidades do tenant inclui tenant_id e, quando cabível,
-- hospital, serviço e internação. Um tenant_id isolado não basta (especificação 5.2, regra 2).

-- ---------------------------------------------------------------------------------------------
-- Paciente e internação
-- ---------------------------------------------------------------------------------------------
create table app.patients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  full_name text not null check (length(full_name) between 2 and 200),
  birth_date date,
  sex text check (sex in ('feminino', 'masculino', 'intersexo', 'nao_informado')),
  created_by uuid not null references app.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (tenant_id, id)
);
create trigger patients_touch before update on app.patients for each row execute function app.touch_updated_at();

-- CPF não é obrigatório nem chave; nenhum índice global entre tenants.
create table app.patient_identifiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  patient_id uuid not null,
  system text not null check (system in ('prontuario', 'cns', 'cpf', 'nome_mae', 'data_nascimento', 'outro')),
  issuer_label text,
  value text not null check (length(value) between 1 and 120),
  created_by uuid not null references app.users(id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, patient_id) references app.patients (tenant_id, id)
);
create index patient_identifiers_lookup on app.patient_identifiers (tenant_id, system, value);

create table app.encounters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  patient_id uuid not null,
  mrn text,
  admitted_at timestamptz not null,
  discharged_at timestamptz,
  status text not null default 'active' check (status in ('active', 'discharged', 'transferred_out', 'deceased', 'cancelled')),
  created_by uuid not null references app.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (tenant_id, id),
  unique (tenant_id, hospital_id, id),
  foreign key (tenant_id, hospital_id) references app.hospitals (tenant_id, id),
  foreign key (tenant_id, patient_id) references app.patients (tenant_id, id),
  check (discharged_at is null or discharged_at >= admitted_at)
);
create index encounters_status_idx on app.encounters (tenant_id, hospital_id, status);
create trigger encounters_touch before update on app.encounters for each row execute function app.touch_updated_at();

create table app.location_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  encounter_id uuid not null,
  bed_id uuid,
  location_text text not null,
  from_at timestamptz not null default now(),
  to_at timestamptz,
  recorded_by uuid not null references app.users(id),
  foreign key (tenant_id, hospital_id, encounter_id) references app.encounters (tenant_id, hospital_id, id),
  foreign key (tenant_id, hospital_id, bed_id) references app.beds (tenant_id, hospital_id, id),
  check (to_at is null or to_at >= from_at)
);
create index location_history_enc_idx on app.location_history (tenant_id, encounter_id, from_at desc);

-- Acompanhamento de serviço: entrada/saída da neurologia, distinto de admissão/alta hospitalar.
create table app.service_episodes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  service_id uuid not null,
  encounter_id uuid not null,
  status text not null default 'requested' check (status in ('requested', 'accepted', 'active', 'closed', 'cancelled')),
  priority text check (priority in ('rotina', 'prioritaria', 'urgente')),
  priority_set_by uuid references app.users(id),
  requested_at timestamptz not null,
  due_at timestamptz,
  accepted_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  end_justification text,
  cancel_reason text,
  created_by uuid not null references app.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (tenant_id, id),
  unique (tenant_id, service_id, id),
  unique (tenant_id, id, encounter_id, service_id, hospital_id),
  foreign key (tenant_id, hospital_id, service_id) references app.services (tenant_id, hospital_id, id),
  foreign key (tenant_id, hospital_id, encounter_id) references app.encounters (tenant_id, hospital_id, id),
  check (status <> 'cancelled' or cancel_reason is not null),
  check (ended_at is null or started_at is null or ended_at >= started_at)
);
create unique index service_episodes_one_open on app.service_episodes (tenant_id, encounter_id, service_id)
  where status in ('requested', 'accepted', 'active');
create index service_episodes_worklist on app.service_episodes (tenant_id, service_id, status);
create trigger service_episodes_touch before update on app.service_episodes for each row execute function app.touch_updated_at();

create function app.service_episode_guard() returns trigger
language plpgsql set search_path = pg_catalog, app as $$
begin
  if new.tenant_id <> old.tenant_id or new.service_id <> old.service_id or new.encounter_id <> old.encounter_id
     or new.hospital_id <> old.hospital_id then
    raise exception 'escopo do acompanhamento não pode mudar' using errcode = 'P0001';
  end if;
  if new.status <> old.status and not (
       (old.status = 'requested' and new.status in ('accepted', 'active', 'cancelled'))
    or (old.status = 'accepted' and new.status in ('active', 'cancelled'))
    or (old.status = 'active' and new.status = 'closed')
  ) then
    raise exception 'transição de acompanhamento inválida: % → %', old.status, new.status using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger service_episodes_guard before update on app.service_episodes for each row execute function app.service_episode_guard();

-- Dados clínicos do acompanhamento ficam em tabela separada, protegida por clinical.read:
-- a secretária vê o censo, não o motivo da interconsulta.
create table app.episode_clinical (
  tenant_id uuid not null,
  service_id uuid not null,
  service_episode_id uuid primary key,
  reason text not null check (length(reason) between 1 and 2000),
  requester_text text,
  updated_by uuid not null references app.users(id),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, service_id, service_episode_id) references app.service_episodes (tenant_id, service_id, id)
);

create table app.care_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  service_id uuid not null,
  service_episode_id uuid not null,
  user_id uuid not null references app.users(id),
  from_at timestamptz not null default now(),
  until_at timestamptz,
  assigned_by uuid not null references app.users(id),
  foreign key (tenant_id, service_id, service_episode_id) references app.service_episodes (tenant_id, service_id, id)
);
create index care_assignments_current on app.care_assignments (tenant_id, service_episode_id) where until_at is null;

-- ---------------------------------------------------------------------------------------------
-- Problemas
-- ---------------------------------------------------------------------------------------------
create table app.problems (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  service_id uuid not null,
  encounter_id uuid not null,
  service_episode_id uuid not null,
  description text not null check (length(description) between 1 and 500),
  certainty text not null check (certainty in ('hipotese', 'diferencial', 'confirmado')),
  status text not null default 'ativo' check (status in ('ativo', 'em_investigacao', 'resolvido', 'suspenso')),
  created_by uuid not null references app.users(id),
  last_reviewed_by uuid references app.users(id),
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (tenant_id, id),
  unique (tenant_id, service_episode_id, id),
  foreign key (tenant_id, service_episode_id, encounter_id, service_id, hospital_id)
    references app.service_episodes (tenant_id, id, encounter_id, service_id, hospital_id)
);
create trigger problems_touch before update on app.problems for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Notas
-- ---------------------------------------------------------------------------------------------
create table app.notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  service_id uuid not null,
  encounter_id uuid not null,
  service_episode_id uuid not null,
  author_id uuid not null references app.users(id),
  note_type text not null default 'evolucao' check (note_type in ('evolucao', 'interconsulta_inicial')),
  status text not null default 'draft' check (status in ('draft', 'final')),
  attended_at timestamptz,
  content jsonb not null,
  version int not null default 1,
  last_edited_by uuid not null references app.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalized_at timestamptz,
  finalized_by uuid references app.users(id),
  final_version_id uuid,
  unique (tenant_id, id),
  unique (tenant_id, service_id, id),
  foreign key (tenant_id, service_episode_id, encounter_id, service_id, hospital_id)
    references app.service_episodes (tenant_id, id, encounter_id, service_id, hospital_id),
  check ((status = 'final') = (finalized_at is not null and finalized_by is not null and final_version_id is not null))
);
create index notes_episode_idx on app.notes (tenant_id, service_episode_id, created_at desc);
create trigger notes_touch before update on app.notes for each row execute function app.touch_updated_at();

create table app.note_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  service_id uuid not null,
  note_id uuid not null,
  version_no int not null,
  content jsonb not null,
  content_sha256 text not null,
  author_id uuid not null references app.users(id),
  attended_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  finalized_by uuid not null references app.users(id),
  warnings jsonb not null default '[]',
  warnings_justification text,
  unique (tenant_id, id),
  unique (note_id, version_no),
  foreign key (tenant_id, service_id, note_id) references app.notes (tenant_id, service_id, id)
);
create trigger note_versions_immutable before update or delete on app.note_versions
  for each row execute function app.forbid_mutation();

alter table app.notes add foreign key (tenant_id, final_version_id) references app.note_versions (tenant_id, id)
  deferrable initially deferred;

create table app.note_addenda (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  service_id uuid not null,
  note_id uuid not null,
  note_version_id uuid not null,
  author_id uuid not null references app.users(id),
  body text not null check (length(body) between 1 and 20000),
  reason text not null check (length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, service_id, note_id) references app.notes (tenant_id, service_id, id),
  foreign key (tenant_id, note_version_id) references app.note_versions (tenant_id, id)
);
create trigger note_addenda_immutable before update or delete on app.note_addenda
  for each row execute function app.forbid_mutation();

-- Imutabilidade e autoria da finalização no próprio banco (defesa em profundidade).
create function app.notes_guard() returns trigger
language plpgsql set search_path = pg_catalog, app as $$
begin
  if old.status = 'final' then
    raise exception 'nota finalizada é imutável; registre um adendo' using errcode = 'P0001';
  end if;
  if new.tenant_id <> old.tenant_id or new.service_id <> old.service_id or new.service_episode_id <> old.service_episode_id
     or new.encounter_id <> old.encounter_id or new.hospital_id <> old.hospital_id or new.author_id <> old.author_id then
    raise exception 'escopo/autoria da nota não pode mudar' using errcode = 'P0001';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'versão da nota deve ser incrementada' using errcode = 'P0001';
  end if;
  if new.status = 'final' then
    if new.finalized_by is distinct from old.author_id or new.finalized_by is distinct from app.current_user_id() then
      raise exception 'somente o autor finaliza a própria evolução' using errcode = '42501';
    end if;
    if not app.has_cap(new.tenant_id, new.service_id, 'note.finalize') then
      raise exception 'sem permissão para finalizar' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger notes_guard before update on app.notes for each row execute function app.notes_guard();

create function app.note_addenda_guard() returns trigger
language plpgsql set search_path = pg_catalog, app as $$
begin
  if not exists (select 1 from app.notes n where n.tenant_id = new.tenant_id and n.id = new.note_id
                 and n.status = 'final' and n.final_version_id = new.note_version_id) then
    raise exception 'adendo exige nota finalizada e versão correspondente' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger note_addenda_guard before insert on app.note_addenda for each row execute function app.note_addenda_guard();

-- ---------------------------------------------------------------------------------------------
-- Tarefas
-- ---------------------------------------------------------------------------------------------
create table app.tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  service_id uuid not null,
  encounter_id uuid not null,
  service_episode_id uuid not null,
  problem_id uuid,
  task_type text not null check (task_type in ('agendar_exame', 'confirmar_realizacao', 'obter_laudo', 'revisar_resultado',
                                               'contatar', 'reavaliar', 'documentar', 'outro')),
  action text not null check (length(action) between 1 and 500),
  completion_criterion text not null check (length(completion_criterion) between 1 and 500),
  contingency text,
  requested_by uuid not null references app.users(id),
  -- Nulo = fila do serviço (não atribuída), visível no painel de exceções.
  assignee_user_id uuid references app.users(id),
  due_at timestamptz,
  due_timezone text,
  priority text check (priority in ('baixa', 'normal', 'alta', 'critica')),
  status text not null default 'open' check (status in ('proposed', 'open', 'in_progress', 'blocked', 'done', 'cancelled')),
  status_reason text,
  source text not null default 'manual' check (source in ('manual', 'nota', 'passagem', 'proposta')),
  source_note_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  version int not null default 1,
  unique (tenant_id, id),
  unique (tenant_id, service_id, id),
  foreign key (tenant_id, service_episode_id, encounter_id, service_id, hospital_id)
    references app.service_episodes (tenant_id, id, encounter_id, service_id, hospital_id),
  foreign key (tenant_id, service_episode_id, problem_id) references app.problems (tenant_id, service_episode_id, id),
  foreign key (tenant_id, service_id, source_note_id) references app.notes (tenant_id, service_id, id),
  check (due_at is null or due_timezone is not null),
  check (status not in ('cancelled', 'blocked') or status_reason is not null)
);
create index tasks_service_due_idx on app.tasks (tenant_id, service_id, due_at, status);
create trigger tasks_touch before update on app.tasks for each row execute function app.touch_updated_at();

create function app.tasks_guard() returns trigger
language plpgsql set search_path = pg_catalog, app as $$
begin
  if new.tenant_id <> old.tenant_id or new.service_id <> old.service_id or new.service_episode_id <> old.service_episode_id then
    raise exception 'escopo da tarefa não pode mudar' using errcode = 'P0001';
  end if;
  if old.status in ('done', 'cancelled') then
    raise exception 'tarefa encerrada não pode ser alterada' using errcode = 'P0001';
  end if;
  if new.status <> old.status and not (
       (old.status = 'proposed' and new.status in ('open', 'cancelled'))
    or (old.status = 'open' and new.status in ('in_progress', 'blocked', 'done', 'cancelled'))
    or (old.status = 'in_progress' and new.status in ('open', 'blocked', 'done', 'cancelled'))
    or (old.status = 'blocked' and new.status in ('open', 'in_progress', 'cancelled'))
  ) then
    raise exception 'transição de tarefa inválida: % → %', old.status, new.status using errcode = 'P0001';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'versão da tarefa deve ser incrementada' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger tasks_guard before update on app.tasks for each row execute function app.tasks_guard();

create table app.task_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  service_id uuid not null,
  task_id uuid not null,
  actor_user_id uuid not null references app.users(id),
  event text not null check (event in ('created', 'accepted', 'status_changed', 'reassigned', 'due_changed', 'handoff_transferred')),
  from_status text,
  to_status text,
  at timestamptz not null default now(),
  foreign key (tenant_id, service_id, task_id) references app.tasks (tenant_id, service_id, id)
);
create trigger task_events_immutable before update or delete on app.task_events
  for each row execute function app.forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Passagem de caso (I-PASS como estrutura de comunicação)
-- ---------------------------------------------------------------------------------------------
create table app.handoffs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  service_id uuid not null,
  sender_id uuid not null references app.users(id),
  receiver_id uuid not null references app.users(id),
  status text not null default 'sent' check (status in ('sent', 'acknowledged', 'questioned', 'cancelled')),
  snapshot jsonb not null,
  sent_at timestamptz not null default now(),
  responded_at timestamptz,
  version int not null default 1,
  unique (tenant_id, id),
  unique (tenant_id, service_id, id),
  foreign key (tenant_id, hospital_id, service_id) references app.services (tenant_id, hospital_id, id),
  check (sender_id <> receiver_id)
);
create index handoffs_receiver_idx on app.handoffs (tenant_id, receiver_id, status);

create table app.handoff_tasks (
  tenant_id uuid not null,
  service_id uuid not null,
  handoff_id uuid not null,
  task_id uuid not null,
  transfer_ownership boolean not null default true,
  primary key (handoff_id, task_id),
  foreign key (tenant_id, service_id, handoff_id) references app.handoffs (tenant_id, service_id, id),
  foreign key (tenant_id, service_id, task_id) references app.tasks (tenant_id, service_id, id)
);

create table app.handoff_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  service_id uuid not null,
  handoff_id uuid not null,
  user_id uuid not null references app.users(id),
  decision text not null check (decision in ('accepted', 'questioned')),
  questions text,
  at timestamptz not null default now(),
  foreign key (tenant_id, service_id, handoff_id) references app.handoffs (tenant_id, service_id, id),
  check (decision <> 'questioned' or questions is not null)
);
create trigger handoff_ack_immutable before update or delete on app.handoff_acknowledgments
  for each row execute function app.forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Documentos (armazenamento privado; caminho sem nome de paciente) e exportações
-- ---------------------------------------------------------------------------------------------
create table app.source_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  service_id uuid not null,
  encounter_id uuid not null,
  service_episode_id uuid not null,
  uploaded_by uuid not null references app.users(id),
  kind text not null check (kind in ('laudo', 'exame', 'documento', 'outro')),
  storage_key text not null unique,
  mime_type text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null,
  status text not null default 'quarantine' check (status in ('quarantine', 'available', 'rejected')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, service_episode_id, encounter_id, service_id, hospital_id)
    references app.service_episodes (tenant_id, id, encounter_id, service_id, hospital_id)
);
create index source_documents_dup on app.source_documents (tenant_id, service_episode_id, sha256);

-- "Preparado", "exportado" e "incorporado ao prontuário oficial" são estados distintos (especificação 21).
create table app.note_exports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  service_id uuid not null,
  note_id uuid not null,
  note_version_id uuid not null,
  job_id uuid,
  requested_by uuid not null references app.users(id),
  status text not null default 'queued' check (status in ('queued', 'prepared', 'failed', 'exported', 'incorporated')),
  storage_key text unique,
  sha256 text,
  incorporated_confirmed_by uuid references app.users(id),
  incorporated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, service_id, note_id) references app.notes (tenant_id, service_id, id),
  foreign key (tenant_id, note_version_id) references app.note_versions (tenant_id, id),
  foreign key (tenant_id, job_id) references app.jobs (tenant_id, id)
);
create trigger note_exports_touch before update on app.note_exports for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Visibilidade de paciente/internação: existe acompanhamento de serviço autorizado.
-- ---------------------------------------------------------------------------------------------
create function app.can_see_encounter(p_tenant uuid, p_encounter uuid, p_cap text) returns boolean
language sql stable security definer set search_path = pg_catalog, app as $$
  select exists (
    select 1 from app.service_episodes e
    where e.tenant_id = p_tenant and e.encounter_id = p_encounter and app.has_cap(p_tenant, e.service_id, p_cap)
  )
$$;

create function app.can_see_patient(p_tenant uuid, p_patient uuid, p_cap text) returns boolean
language sql stable security definer set search_path = pg_catalog, app as $$
  select exists (
    select 1 from app.encounters en
    join app.service_episodes e on e.tenant_id = en.tenant_id and e.encounter_id = en.id
    where en.tenant_id = p_tenant and en.patient_id = p_patient and app.has_cap(p_tenant, e.service_id, p_cap)
  )
$$;

-- Pendência documental sem conteúdo clínico (visão da secretária).
create function app.pending_documentation(p_tenant uuid, p_service uuid, p_day_start timestamptz, p_day_end timestamptz)
returns table (service_episode_id uuid, has_final_note_in_period boolean, has_draft boolean)
language sql stable security definer set search_path = pg_catalog, app as $$
  select e.id,
    exists (select 1 from app.notes n where n.tenant_id = e.tenant_id and n.service_episode_id = e.id
            and n.status = 'final' and n.attended_at >= p_day_start and n.attended_at < p_day_end),
    exists (select 1 from app.notes n where n.tenant_id = e.tenant_id and n.service_episode_id = e.id and n.status = 'draft')
  from app.service_episodes e
  where e.tenant_id = p_tenant and e.service_id = p_service and e.status = 'active'
    and app.has_cap(p_tenant, p_service, 'documentation.pending.view')
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
alter table app.patients enable row level security;
alter table app.patient_identifiers enable row level security;
alter table app.encounters enable row level security;
alter table app.location_history enable row level security;
alter table app.service_episodes enable row level security;
alter table app.episode_clinical enable row level security;
alter table app.care_assignments enable row level security;
alter table app.problems enable row level security;
alter table app.notes enable row level security;
alter table app.note_versions enable row level security;
alter table app.note_addenda enable row level security;
alter table app.tasks enable row level security;
alter table app.task_events enable row level security;
alter table app.handoffs enable row level security;
alter table app.handoff_tasks enable row level security;
alter table app.handoff_acknowledgments enable row level security;
alter table app.source_documents enable row level security;
alter table app.note_exports enable row level security;

create policy patients_select on app.patients for select
  using (app.can_see_patient(tenant_id, id, 'patient.basic.read'));
create policy patients_insert on app.patients for insert
  with check (tenant_id = app.current_tenant_id() and created_by = app.current_user_id() and app.has_cap_any(tenant_id, 'patient.basic.write'));
create policy patients_update on app.patients for update
  using (app.can_see_patient(tenant_id, id, 'patient.basic.write'))
  with check (app.can_see_patient(tenant_id, id, 'patient.basic.write'));

create policy patient_identifiers_select on app.patient_identifiers for select
  using (app.can_see_patient(tenant_id, patient_id, 'patient.basic.read'));
create policy patient_identifiers_insert on app.patient_identifiers for insert
  with check (tenant_id = app.current_tenant_id() and created_by = app.current_user_id()
              and app.has_cap_any(tenant_id, 'patient.basic.write'));

create policy encounters_select on app.encounters for select
  using (app.can_see_encounter(tenant_id, id, 'patient.basic.read'));
create policy encounters_insert on app.encounters for insert
  with check (created_by = app.current_user_id() and app.has_cap_in_hospital(tenant_id, hospital_id, 'patient.basic.write'));
create policy encounters_update on app.encounters for update
  using (app.can_see_encounter(tenant_id, id, 'patient.basic.write'))
  with check (app.can_see_encounter(tenant_id, id, 'patient.basic.write'));

create policy location_select on app.location_history for select
  using (app.can_see_encounter(tenant_id, encounter_id, 'patient.basic.read'));
create policy location_insert on app.location_history for insert
  with check (recorded_by = app.current_user_id() and app.has_cap_in_hospital(tenant_id, hospital_id, 'patient.basic.write'));
create policy location_update on app.location_history for update
  using (app.can_see_encounter(tenant_id, encounter_id, 'patient.basic.write'))
  with check (app.can_see_encounter(tenant_id, encounter_id, 'patient.basic.write'));

create policy episodes_select on app.service_episodes for select
  using (app.has_cap(tenant_id, service_id, 'patient.basic.read'));
create policy episodes_insert on app.service_episodes for insert
  with check (created_by = app.current_user_id() and (app.has_cap(tenant_id, service_id, 'census.manage')
              or (status = 'requested' and app.has_cap(tenant_id, service_id, 'patient.basic.write'))));
create policy episodes_update on app.service_episodes for update
  using (app.has_cap(tenant_id, service_id, 'census.manage'))
  with check (app.has_cap(tenant_id, service_id, 'census.manage'));

create policy episode_clinical_select on app.episode_clinical for select
  using (app.has_cap(tenant_id, service_id, 'clinical.read'));
create policy episode_clinical_write on app.episode_clinical for insert
  with check (updated_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'clinical.write'));
create policy episode_clinical_update on app.episode_clinical for update
  using (app.has_cap(tenant_id, service_id, 'clinical.write'))
  with check (updated_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'clinical.write'));

create policy care_select on app.care_assignments for select
  using (app.has_cap(tenant_id, service_id, 'patient.basic.read'));
create policy care_insert on app.care_assignments for insert
  with check (assigned_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'census.manage')
              and app.user_has_cap(user_id, tenant_id, service_id, 'clinical.write'));
create policy care_update on app.care_assignments for update
  using (app.has_cap(tenant_id, service_id, 'census.manage'))
  with check (app.has_cap(tenant_id, service_id, 'census.manage'));

create policy problems_select on app.problems for select using (app.has_cap(tenant_id, service_id, 'clinical.read'));
create policy problems_insert on app.problems for insert
  with check (created_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'clinical.write'));
create policy problems_update on app.problems for update
  using (app.has_cap(tenant_id, service_id, 'clinical.write'))
  with check (app.has_cap(tenant_id, service_id, 'clinical.write'));

create policy notes_select on app.notes for select using (app.has_cap(tenant_id, service_id, 'clinical.read'));
create policy notes_insert on app.notes for insert
  with check (author_id = app.current_user_id() and last_edited_by = app.current_user_id() and status = 'draft'
              and app.has_cap(tenant_id, service_id, 'clinical.write'));
create policy notes_update on app.notes for update
  using (status = 'draft' and app.has_cap(tenant_id, service_id, 'clinical.write'))
  with check (last_edited_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'clinical.write'));

create policy note_versions_select on app.note_versions for select using (app.has_cap(tenant_id, service_id, 'clinical.read'));
create policy note_versions_insert on app.note_versions for insert
  with check (finalized_by = app.current_user_id() and author_id = app.current_user_id()
              and app.has_cap(tenant_id, service_id, 'note.finalize'));

create policy note_addenda_select on app.note_addenda for select using (app.has_cap(tenant_id, service_id, 'clinical.read'));
create policy note_addenda_insert on app.note_addenda for insert
  with check (author_id = app.current_user_id() and app.has_cap(tenant_id, service_id, 'note.addendum'));

create policy tasks_select on app.tasks for select using (app.has_cap(tenant_id, service_id, 'clinical.read'));
create policy tasks_insert on app.tasks for insert
  with check (requested_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'clinical.write')
              and (assignee_user_id is null or app.user_has_cap(assignee_user_id, tenant_id, service_id, 'clinical.write')));
create policy tasks_update on app.tasks for update
  using (app.has_cap(tenant_id, service_id, 'clinical.write'))
  with check (app.has_cap(tenant_id, service_id, 'clinical.write')
              and (assignee_user_id is null or app.user_has_cap(assignee_user_id, tenant_id, service_id, 'clinical.write')));

create policy task_events_select on app.task_events for select using (app.has_cap(tenant_id, service_id, 'clinical.read'));
create policy task_events_insert on app.task_events for insert
  with check (actor_user_id = app.current_user_id() and app.has_cap(tenant_id, service_id, 'clinical.write'));

create policy handoffs_select on app.handoffs for select
  using (app.has_cap(tenant_id, service_id, 'handoff.participate')
         and (sender_id = app.current_user_id() or receiver_id = app.current_user_id()
              or app.has_cap(tenant_id, service_id, 'coordination.view')));
create policy handoffs_insert on app.handoffs for insert
  with check (sender_id = app.current_user_id() and app.has_cap(tenant_id, service_id, 'handoff.participate')
              and app.user_has_cap(receiver_id, tenant_id, service_id, 'handoff.participate'));
create policy handoffs_update on app.handoffs for update
  using ((sender_id = app.current_user_id() or receiver_id = app.current_user_id())
         and app.has_cap(tenant_id, service_id, 'handoff.participate'))
  with check (app.has_cap(tenant_id, service_id, 'handoff.participate'));

create policy handoff_tasks_select on app.handoff_tasks for select
  using (app.has_cap(tenant_id, service_id, 'handoff.participate') and app.has_cap(tenant_id, service_id, 'clinical.read'));
create policy handoff_tasks_insert on app.handoff_tasks for insert
  with check (app.has_cap(tenant_id, service_id, 'handoff.participate'));

create policy handoff_ack_select on app.handoff_acknowledgments for select
  using (app.has_cap(tenant_id, service_id, 'handoff.participate'));
create policy handoff_ack_insert on app.handoff_acknowledgments for insert
  with check (user_id = app.current_user_id() and app.has_cap(tenant_id, service_id, 'handoff.participate'));

create policy documents_select on app.source_documents for select
  using (app.has_cap(tenant_id, service_id, 'clinical.read')
         or (uploaded_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'document.upload')));
create policy documents_insert on app.source_documents for insert
  with check (uploaded_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'document.upload'));

create policy exports_select on app.note_exports for select
  using (requested_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'clinical.read'));
create policy exports_insert on app.note_exports for insert
  with check (requested_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'clinical.read'));
create policy exports_update on app.note_exports for update
  using (requested_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'clinical.read'))
  with check (requested_by = app.current_user_id() and app.has_cap(tenant_id, service_id, 'clinical.read'));

-- ---------------------------------------------------------------------------------------------
-- Privilégios (sem DELETE)
-- ---------------------------------------------------------------------------------------------
grant select, insert, update on app.patients, app.encounters, app.location_history, app.service_episodes,
  app.episode_clinical, app.care_assignments, app.problems, app.notes, app.tasks, app.handoffs, app.note_exports to evolu_app;
grant select, insert on app.patient_identifiers, app.note_versions, app.note_addenda, app.task_events,
  app.handoff_tasks, app.handoff_acknowledgments, app.source_documents to evolu_app;

-- O worker executa jobs no contexto do solicitante (app.user_id), sujeito às mesmas políticas.
grant select on app.notes, app.note_versions, app.note_addenda, app.service_episodes, app.encounters, app.patients,
  app.patient_identifiers, app.handoffs, app.memberships, app.role_grants to evolu_worker;
grant select, update on app.note_exports to evolu_worker;

revoke all on all functions in schema app from public;
grant execute on all functions in schema app to evolu_app, evolu_worker;
