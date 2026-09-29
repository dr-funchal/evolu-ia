# ADR 0006 — Continuidade: tarefas com responsável e passagem I-PASS com aceite

- **Status:** aceito
- **Decisão:** tarefa tem ação, critério de conclusão, contingência, responsável, prazo com
  timezone IANA e histórico (`task_events`). Passagem de plantão congela um snapshot I-PASS por
  paciente, pode transferir tarefas e só vale após aceite (ou "registrar dúvidas") do receptor.
  Tudo com versão otimista e chave de idempotência.
