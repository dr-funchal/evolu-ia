# ADR 0015 — Evolução simples, contexto do paciente, cadastro por foto e novo visual

- **Status:** aceito (01/10/2026)
- **Contexto:** no celular, a evolução estruturada (seções, problemas, campos obrigatórios) era
  lenta de preencher. O responsável pediu: um único campo de texto do dia (ditado ou digitado)
  que a IA organiza, destacando o importante e criando o que checar no dia seguinte; um único
  campo de contexto do paciente, alimentado também por fotos de exames ou de outras evoluções;
  inclusão de paciente por foto (nome, nascimento, leito); e o visual do projeto NeuroFinance.
- **Decisão (a regra continua: a IA só propõe, o médico confirma — ADR 0010):**
  1. **Evolução simples** — `content.schema = 2` no mesmo jsonb da nota:
     `{ transcricao, evolucao, destaques[] }`. É o formato padrão de `POST /v1/episodes/:id/notes`;
     `format: "estruturada"` (ou `prefillFromLast`) mantém o formato antigo (schema 1). Para
     finalizar basta horário de atendimento e algum texto (`empty_note`); não há seções obrigatórias.
     O ditado usa a transcrição já existente com `structure=0` (só texto, áudio não guardado).
  2. **Organizar com IA** — `POST /v1/ai/notes/:id/organize` (autor, rascunho, `clinical.write`).
     Material enviado **sem nome do paciente**: data de hoje, motivo, contexto (marcado como
     registrado antes), problemas ativos, exames confirmados **com a data impressa**, última
     evolução final (marcada "NÃO é de hoje") e tarefas abertas, seguidos do texto do dia. A IA
     devolve a evolução organizada e até 8 destaques — a nota **não** é alterada no servidor; o
     médico revisa, edita e salva. Até 5 tarefas "checar amanhã" entram como `proposed`/`ia`
     (vencimento amanhã 10:00 no fuso do hospital), respeitando o limite de sugestões pendentes;
     cada uma é aprovada ou descartada pelo médico.
  3. **Contexto do paciente** — migration `0010_contexto_paciente`: `episode_clinical.context`
     (texto, até 20 000) e `context_version`; `reason` passa a ser opcional. Edição por
     `PUT /v1/episodes/:id/context` com **If-Match** (versão 0 quando ainda não existe) e auditoria.
     Foto de exame/evolução usa a leitura de documento da ADR 0014; ao confirmar com
     `appendToContext: true`, o servidor acrescenta `[título — data do documento]` + resumo ao
     contexto **na mesma transação** (sem data impressa: "sem data no documento").
  4. **Paciente por foto** — `POST /v1/ai/services/:id/patient-photo` (`patient.basic.write`,
     multipart `file`, formato pela assinatura, modelo com visão). Devolve nome, nascimento, leito,
     prontuário e sexo **como sugestão** para o formulário; nada é cadastrado sem "Incluir", e
     **a foto não é guardada**. Ilegível → `{ legivel: false }`.
  5. **Visual** — padrão NeuroFinance: fundo creme, cartões brancos arredondados, acento terracota,
     marca em serifa, menu lateral com seções "Principal"/"Sistema" no desktop e barra superior +
     gaveta no celular, cartões de números, abas sublinhadas, pílulas coloridas, botões escuros e
     barra de ação fixa no rodapé do celular. Página do paciente reorganizada: Evoluções →
     Contexto → Tarefas; equipe, documentos, problemas e relatórios ficam em "Mais".
- **Consequências:** notas antigas (schema 1) continuam abrindo no editor estruturado. A tela
  de leitura de exames da ADR 0014 saiu da página do paciente (a foto agora vai para o contexto);
  a rota continua a mesma. Testes em `tests/security/evolucao-simples.test.ts`.
