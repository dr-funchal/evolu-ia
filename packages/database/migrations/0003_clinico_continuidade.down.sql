drop table if exists app.note_exports, app.source_documents, app.handoff_acknowledgments, app.handoff_tasks,
  app.handoffs, app.task_events, app.tasks, app.note_addenda, app.note_versions, app.notes, app.problems,
  app.care_assignments, app.episode_clinical, app.service_episodes, app.location_history, app.encounters,
  app.patient_identifiers, app.patients cascade;
drop function if exists app.pending_documentation(uuid, uuid, timestamptz, timestamptz);
drop function if exists app.can_see_patient(uuid, uuid, text);
drop function if exists app.can_see_encounter(uuid, uuid, text);
drop function if exists app.tasks_guard();
drop function if exists app.note_addenda_guard();
drop function if exists app.notes_guard();
drop function if exists app.service_episode_guard();
