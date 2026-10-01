alter table app.episode_clinical drop column context_version;
alter table app.episode_clinical drop column context;
-- Linhas criadas só para guardar contexto não têm motivo: somem junto com o campo.
delete from app.episode_clinical where reason is null;
alter table app.episode_clinical drop constraint episode_clinical_reason_check;
alter table app.episode_clinical add constraint episode_clinical_reason_check check (length(reason) between 1 and 2000);
alter table app.episode_clinical alter column reason set not null;
