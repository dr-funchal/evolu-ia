-- 0010 — Evolução simples e contexto do paciente (ADR 0015).
-- * episode_clinical.context: um campo único de contexto por acompanhamento (história, antecedentes,
--   exames e evoluções externas lidos por foto). Texto livre editado pela equipe; versão otimista
--   própria (If-Match) para não sobrescrever a edição de outra pessoa.
-- * reason passa a ser opcional: o contexto pode existir antes de alguém registrar o motivo.
-- A evolução simples (schema 2) vive no mesmo jsonb de app.notes/note_versions; não muda tabela.

alter table app.episode_clinical alter column reason drop not null;
alter table app.episode_clinical drop constraint episode_clinical_reason_check;
alter table app.episode_clinical add constraint episode_clinical_reason_check check (reason is null or length(reason) between 1 and 2000);
alter table app.episode_clinical add column context text not null default '' check (length(context) <= 20000);
alter table app.episode_clinical add column context_version int not null default 0 check (context_version >= 0);
