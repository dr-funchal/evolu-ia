drop function if exists app.service_team(uuid, uuid, text);
drop function if exists app.possible_duplicate_patients(uuid, text, date);
drop function if exists app.my_service_capabilities();
drop function if exists app.my_scopes();
revoke select on app.problems from evolu_worker;
