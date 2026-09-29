# ADR 0013 — IA por equipe via OpenRouter: chave cifrada, modelo escolhido pelo administrador

- **Status:** aceito (29/09/2026)
- **Contexto:** o responsável quer usar IA em todas as tarefas (resumos, OCR, voz) e vender o
  produto a outras equipes. Cada equipe paga o próprio uso e escolhe o modelo pelo custo.
- **Decisão:**
  - **Um agregador: OpenRouter** (API compatível com OpenAI; texto, visão, áudio e transcrição
    `/audio/transcriptions`). Cliente próprio mínimo em `packages/api/src/ai/openrouter.ts`, sem SDK.
  - **Chave por equipe**, informada em Administração → Inteligência artificial (`org.manage`).
    Validada no `GET /key` antes de salvar, cifrada com AES-256-GCM (`AI_SECRETS_KEY` fora do
    banco; o tenant é dado autenticado, então o texto cifrado não serve em outra equipe). O banco
    guarda cifra + 4 últimos caracteres; a API nunca devolve a chave.
  - **Modelos:** principal (texto; com imagem serve para OCR) e transcrição (opcional). O catálogo
    vem do `GET /models` público (cache de 1 h). O preço aparece por 1 M tokens e como estimativa
    por resumo de caso (4 mil tokens de entrada + 1 mil de saída). Transcrição tipo Whisper
    aparece por minuto. Modelos `:batch` ficam fora.
  - **Retenção zero por padrão:** pedidos de chat saem com `provider: { zdr: true,
    data_collection: "deny" }`. O administrador pode desligar. O endpoint de transcrição do
    OpenRouter ainda não aceita esse filtro, e a tela avisa isso.
  - **Acesso:** a tabela `app.tenant_ai_settings` só é lida e escrita por quem tem `org.manage`
    (RLS). Os recursos usados pela equipe leem a configuração ativa por `app.ai_config()`
    (security definer, exige vínculo ativo no tenant da transação). O contexto expõe
    `tenant.modules.ai`.
  - **Consumo:** `app.ai_usage` guarda recurso, modelo, tokens, custo (`usage.cost`) e sucesso,
    **nunca** o conteúdo. O administrador vê o total do mês.
  - **Chamada fora de transação:** `runChat()` lê a configuração, chama o provedor sem segurar
    conexão e registra o consumo em outra transação. Erros do provedor viram códigos
    `ai_*` sem ecoar o corpo da resposta.
  - `AI_PROVIDER=openrouter` liga na plataforma (exige `AI_SECRETS_KEY`). `none` desliga para
    todas as equipes.
- **Consequências:** perder `AI_SECRETS_KEY` obriga cada equipe a recadastrar a chave; ela precisa
  estar no backup do `.env`. Os recursos de IA (resumo, OCR, voz…) entram um a um sobre
  `runChat()`, sempre como proposta revisável (ADR 0010).
