# ADR 0012 — Escala: séries recorrentes, rascunho → publicação e exceções por ocorrência

- **Status:** aceito (29/09/2026)
- **Contexto:** a equipe precisa saber quem faz visita, retaguarda ou plantão em cada serviço, com
  padrões como "Bruno toda segunda" ou "João sábado e domingo em fins de semana alternados", trocas
  pontuais e mudanças "daqui para a frente". Escala não é dado clínico, mas é dado da equipe.
- **Decisão:**
  - **Série + regra, sem ocorrências materializadas.** `app.schedule_series` guarda início local
    (`timestamp` sem fuso) + fuso IANA do hospital + duração + subconjunto de RRULE (RFC 5545:
    `FREQ=DAILY|WEEKLY`, `INTERVAL`, `BYDAY`, `WKST=MO`; sem `COUNT`/`MONTHLY`) + `until` inclusivo.
    As ocorrências são calculadas na leitura (`packages/domain/src/recurrence.ts`), mantendo o
    horário de parede através do horário de verão. "Alternado" é por semana ISO contada a partir
    da semana do início, não "1º e 3º fim de semana do mês". Cada ocorrência tem a duração da
    série: sábado + domingo são dois turnos, não um plantão contínuo. Janela de leitura ≤ 93 dias.
  - **Exceções ancoradas no início local original** (`app.schedule_exceptions`, única por
    série + início): `cancelled`, `reassigned` (outro profissional) ou `none` (desfeita — sem
    DELETE). "Esta e as próximas" = dividir: a série termina na véspera e nasce outra com
    `split_from`. "Série inteira" = editar a regra (vale também para o passado).
  - **Rascunho → publicado → cancelado.** Montar exige `schedule.draft` no serviço (coordenador,
    secretária, admin); publicar ou alterar algo já publicado exige `schedule.publish`
    (coordenador, admin). A RLS repete a regra nas políticas de insert/update das duas tabelas.
    Médico assistente não monta escala.
  - **Visibilidade.** Escala publicada é visível a todo membro ativo do tenant (serve para saber
    quem chamar); rascunho só para quem monta naquele serviço. Serviços listados por
    `app.tenant_active_services()`; escaláveis por `app.schedule_assignable(serviço)` = membros
    ativos com `patient.basic.read` no serviço (só para quem monta, sem e-mail).
  - **Conflito** = mesma pessoa em dois turnos sobrepostos (qualquer serviço visível), marcado na
    resposta, não bloqueante.
  - **Avisos.** Publicação e mudanças em escala publicada geram outbox (`schedule.published`,
    `schedule.changed`) com texto genérico; o worker revalida o vínculo do destinatário.
- **Consequências:** sem tabela de ocorrências, relatórios de horas precisarão expandir as séries
  (ou materializar numa competência fechada, junto com o financeiro — ainda pendente em F2-01).
  Mudar o fuso de um hospital não reescreve séries antigas (o fuso fica gravado na série).
