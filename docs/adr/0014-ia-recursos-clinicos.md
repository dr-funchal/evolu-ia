# ADR 0014 — Recursos clínicos de IA: transcrição, leitura de documentos, relatório, tarefas, resumo e revisão

- **Status:** aceito (29/09/2026)
- **Contexto:** com a base da ADR 0013 (chave e modelo por equipe), o responsável escolheu, das 10
  sugestões, os recursos 1, 2, 3, 6, 8, 9 e 10. O app é passagem de caso, não prontuário: as notas
  servem para leitura rápida, não para formato SOAP.
- **Decisão (regra comum: a IA só propõe; o médico confirma — ADR 0010):**
  1. **Ditado** e 2. **escriba da conversa** — `POST /v1/ai/notes/:id/transcribe` (multipart,
     só o autor, só rascunho, `clinical.write`). Transcrição pelo modelo de transcrição da equipe e
     organização em **notas clínicas**: pontos importantes, antecedentes relevantes, exames
     relevantes, pendências e condutas, hipóteses diagnósticas. Nada entra na evolução sozinho:
     cada bloco tem "Aplicar" numa seção escolhida (acrescenta, nunca substitui) e cada hipótese
     pode virar problema. A conversa exige marcar que o **paciente autorizou verbalmente**; isso
     fica auditado (`ai.scribe.consent`). **O áudio não é guardado** (só memória durante a
     chamada). Até 10 min / 25 MB por gravação. Formato conferido pela assinatura do arquivo.
  3. **Leitura de documento (OCR)** — `POST /v1/ai/episodes/:id/documents`: a foto/PDF é guardada
     como documento do episódio e lida pelo modelo principal (precisa ler imagem; senão
     `ai_no_vision`). Resultado em `app.document_extractions`: categoria, destino sugerido
     (resultados revistos, antecedentes, contexto), título, **data do exame impressa** (nunca a de
     hoje), resumo e valores. Nasce `proposed`; confirmar/descartar com If-Match; revisada é
     imutável (gatilho). Na nota, o achado confirmado é inserido citando a data do exame, para não
     virar "exame atual".
  6. **Relatório da internação** (não é resumo de alta) — para o paciente ou para cobrança.
     Cabeçalho (paciente, hospital, período) e, na cobrança, a relação de atendimentos vêm do
     sistema; a IA recebe o material **sem nome** e redige só o corpo. Rascunho visível e editável
     só pelo autor; **emitir** exige `note.finalize` e congela o texto com SHA-256 (gatilho impede
     alteração). Envio é feito pelo médico: imprimir/salvar PDF ou abrir no próprio e-mail
     (não há SMTP na plataforma).
  8. **Tarefas sugeridas** — a partir do motivo, problemas, exames confirmados e últimas
     evoluções. Criadas com `status = 'proposed'`, `source = 'ia'` (gatilho recusa `ia` aberta);
     o médico **aprova** (→ aberta) ou descarta. No máximo 5 sugestões pendentes por episódio.
  9. **Resumo da coordenação** — `coordination.view`; até 60 pacientes enviados como P1..Pn
     (sem nome/prontuário); a resposta volta mapeada no servidor; só pontos de atenção.
  10. **Revisão antes de finalizar** — aponta até 8 inconsistências; não bloqueia nem altera.
- **Segurança:** toda rota confere capacidade no servidor e audita negação; entrada validada por
  contrato; nenhum conteúdo clínico em log, auditoria ou `ai_usage`. Chamadas ao provedor fora de
  transação. nginx: `/api/v1/ai/` aceita 26 MB e 190 s.
- **Consequências / limitações:** o endpoint de transcrição do OpenRouter ainda não aceita o filtro
  de retenção zero; relatórios longos vão por PDF ou colando o texto no e-mail; o resumo cobre no
  máximo 60 pacientes; a qualidade depende do modelo escolhido pela equipe.
