
Plataforma de visita hospitalar e coordenação de equipes
Especificação de produto e engenharia para implementação com Claude Code
Versão 1.0 • Pesquisa em 28/09/2026 • Idioma pt-BR • Contexto inicial: neurologia hospitalar no Brasil
1. Decisão executiva
Construir uma aplicação web responsiva instalável como PWA, centrada na internação, nos problemas ativos e nas tarefas assistenciais. A primeira especialidade é neurologia; identidade, permissões, escala, cobrança e motor de formulários devem nascer preparados para múltiplas especialidades e hospitais.
O produto deve responder, para cada paciente: por que estamos acompanhando; o que mudou; o que falta esclarecer; o que conferir hoje; qual é o próximo passo; quem o fará; até quando; o que fazer se houver mudança relevante.
Recomendação: monólito modular TypeScript, PostgreSQL, armazenamento privado de arquivos e processamento assíncrono de áudio/imagens. Separar documentação assistida, protocolos e apoio à decisão por funcionalidades e permissões. Começar com organização e documentação; liberar orientação clínica personalizada apenas após validação clínica e avaliação regulatória específica.
Este documento é uma proposta original de arquitetura, não um sistema implementado nem protocolo assistencial validado. As referências sustentam padrões e obrigações selecionados. Estimativas de esforço, metas de desempenho e exemplos financeiros são hipóteses de planejamento. Não constituem cotação, garantia de segurança, parecer jurídico ou indicação clínica.
2. Premissas e decisões a confirmar sem bloquear desenvolvimento
Tema	Premissa para o desenvolvimento	Confirmação antes do piloto real
Público inicial	Médicos de neurologia de pacientes adultos internados	Populações, especialidades e instituições participantes
Relação com hospital	Ferramenta complementar autorizada	Quem controla os dados, onde fica o registro oficial e autorização institucional
Tenant	Organização contratante sob uma fronteira de governança de dados	Hospital/rede ou empresa médica; não inferir apenas pelo CNPJ
Hospitais	Um tenant pode ter vários hospitais, com isolamento adicional por escopo	Se contratos exigem tenants separados
Assistente	Médico assistente por padrão	Se inclui residentes e profissionais não médicos; criar papéis distintos
Uso inicial	Conectado, com contingência manual	Qualidade do Wi-Fi/4G, aparelhos, política de dispositivos
Assinatura	Aprovação autenticada no app, sem alegar equivalência a assinatura qualificada	Requisitos do registro oficial, certificado e integração institucional
Financeiro	Apuração, cobrança e demonstrativos; sem movimentação bancária automática	Regras de contratos, impostos, repasses e documentos exigidos
IA	Prestadores configuráveis, nunca dados reais em ambiente de desenvolvimento	Contratos, região, retenção, suboperadores e avaliação de risco


Usar dados sintéticos enquanto as confirmações institucionais não existirem. Construir o produto completo por fases; não tratar respostas pendentes como licença para inventar regras.
3. Objetivos e indicadores
Objetivo	Indicador com definição	Meta inicial proposta
Continuidade	Tarefas ativas com responsável e prazo / tarefas ativas	100%, ou fila explicitamente não atribuída com escalonamento
Documentação ágil	Mediana e p90 entre abrir evolução e finalizar, por tipo de caso	Reduzir versus linha de base medida no piloto
Evitar omissões	Visitas finalizadas com itens obrigatórios respondidos ou justificados / finalizadas	100% para itens realmente obrigatórios
Segurança da IA	Erros clinicamente relevantes por 100 saídas revisadas, por tipo e gravidade	Nenhum erro crítico nos testes de liberação; monitoramento contínuo
Passagem efetiva	Passagens aceitas pelo receptor / passagens enviadas	Medir e corrigir falhas; abrir tela não equivale a aceitar
Cobertura	Turnos publicados sem profissional confirmado / turnos publicados	Zero lacunas não reconhecidas
Receita rastreável	Eventos elegíveis conciliados com cobrança / elegíveis	100% conciliados ou com motivo de exclusão
Confiabilidade	Sucesso de salvar rascunho e tempo de recuperação de falhas	Medir por serviço, dispositivo e conexão


Não usar volume de procedimentos ou quantidade de alertas aceitos como proxy de qualidade médica. Avaliar economia de tempo junto com omissões, retrabalho e incidentes.
4. Pesquisa aplicada e escolhas
I-PASS é uma referência de passagem estruturada: gravidade, síntese, tarefas, contingências e confirmação pelo receptor [R1]. Adotar esses elementos como estrutura de comunicação, adaptados e aprovados pelo hospital, sem alegar que a simples presença do formulário reproduz resultados de estudos.
RFC 5545 fornece representação de recorrências e exceções [R2]. PostgreSQL oferece políticas por linha, com exceções relevantes para superusuários e papéis privilegiados [R3]. OWASP recomenda isolar também arquivos, cache e processamento assíncrono [R4]. FHIR permite representar laudos e proveniência [R5–R6]. Estas referências orientam decisões; não substituem implementação, testes nem acordos com cada hospital.
Alternativa	Vantagem	Limitação	Decisão
Adaptar prontuário do hospital	Evita duplicação; integra com o registro oficial	Depende de fornecedor, contrato e flexibilidade	Investigar em paralelo ao piloto
Sistema próprio complementar	Fluxo específico de visita, escala e repasse	Risco de dois registros divergirem	Recomendado com reconciliação explícita
Prontuário hospitalar completo próprio	Controle amplo	Escopo, certificação, integrações e manutenção muito maiores	Fora do primeiro produto
PWA	Uma base para celular, tablet e computador	Capacidades de câmera, áudio e segundo plano variam por navegador	Primeira entrega; testar em iPhone real
App nativo	Mais controle do dispositivo e operação desconectada	Dois clientes e distribuição mais complexa	Evolução se o piloto justificar
Monólito modular	Menos operação, transações simples, implantação rápida	Requer fronteiras de código claras	Recomendado
Microsserviços	Isolamento e escalabilidade independentes	Mais custos e falhas distribuídas	Adiar; extrair apenas gargalos demonstrados


5. Fronteiras organizacionais e multi-tenancy
5.1 Hierarquia
- Identidade global de usuário: autenticação única; nenhum prontuário associado diretamente à identidade global.
- Tenant: fronteira contratual e de dados.
- Hospital: estabelecimento dentro do tenant; cadastro local, sem compartilhamento automático com outro tenant.
- Serviço: hospital + especialidade + equipe operacional. Pode haver duas equipes da mesma especialidade no mesmo hospital.
- Unidade/leito: localização com histórico; leito jamais é identificador do paciente.
- Associação de usuário: vínculo com vigência, papel e escopo específico.
- Internação: episódio hospitalar; contém um ou mais acompanhamentos de serviços autorizados.
- Acompanhamento de serviço: entrada/saída da neurologia, por exemplo, distinta da admissão/alta hospitalar.
Exemplo sintético: Bruno coordena neurologia no Hospital A, clínica médica no Hospital A e neurologia no Hospital B. São três concessões de coordenação. Isso não dá acesso à cardiologia nem aos dados de outro contratante. Pode ter papel de assistente em um quarto serviço.
5.2 Regras obrigatórias
1. Toda entidade de negócio contém tenant_id; dados hospitalares também carregam hospital_id onde cabível. Usuários globais e catálogos públicos são exceções documentadas.
2. Cada relacionamento entre entidades tenant-scoped usa chave estrangeira composta com tenant; onde aplicável, validar também hospital, internação e serviço. tenant_id em uma coluna isolada não basta.
3. O servidor resolve o usuário autenticado e valida o tenant solicitado contra vínculos ativos. Header, URL, formulário e prompt não concedem autorização.
4. Autorizar por ação, papel, escopo, vínculo assistencial e período. Um usuário pode administrar contratos sem ler texto clínico.
5. Coordenador tem visão consolidada apenas dos escopos concedidos. Painéis entre tenants executam consultas autorizadas separadas e agregam somente campos permitidos.
6. Pacientes não têm índice global entre tenants. CPF não obrigatório, não chave primária, não motivo para fusão automática. Transferência entre hospitais cria vínculo de origem apenas se autorizado.
7. Acesso entre especialidades depende de participação no cuidado ou concessão hospitalar expressa. A equipe vê seus rascunhos; regras de acesso a notas finalizadas compartilhadas são institucionais.
8. Revogação de vínculo invalida sessões/autorizações e impede novos downloads, jobs e exportações. Histórico de autoria permanece.
9. Administrador da plataforma vê métricas operacionais, não prontuários. Suporte excepcional exige justificativa, escopo, duração e auditoria.
10. Acesso emergencial, se adotado, ocorre somente dentro de relações institucionais previamente permitidas, com motivo, prazo e revisão. Nunca atravessa tenants sem autorização.
6. Papéis e permissões
Legenda: E = somente escopo explicitamente concedido; P = somente próprio; N = não; C = capacidade adicional, independente do título.
Ação	Administrador tenant	Coordenador clínico	Médico assistente	Secretária	Financeiro
Configurar organização e vínculos	E	C	N	N	N
Ler dados clínicos	C	E	E	N	N
Criar evolução médica	Só se médico autorizado	E	E	N	N
Finalizar evolução própria	Só se médico autorizado	P	P	N	N
Alterar nota finalizada	N; apenas adendo autorizado	Adendo	Adendo próprio	N	N
Supervisionar residente	C médico	E	C	N	N
Montar escala em rascunho	E	E	Sugerir troca	E	N
Publicar escala	C	E	N	C	N
Cadastro administrativo mínimo	E	E	E	E	C
Importar documentos clínicos	C	E	E	C restrita à entrada	N
Confirmar extração clínica	C médico	E	E	N	N
Contratos e regra de repasse	C	C	Ver contrato próprio	C	E
Fechar competência	C	C	N	Preparar se permitido	E
Ver demonstrativo de médicos	C	C	P	C	E
Executar pagamento	Fora do MVP	Fora do MVP	N	N	Fora do MVP


Adicionar papel de residente com rascunho e solicitação de revisão; requisitos de coassinatura configurados pelo hospital. Não compartilhar credenciais. Secretária pode acompanhar “documentação pendente” sem receber diagnóstico, evolução ou áudio. Respostas de API devem projetar os campos autorizados; ocultar na interface não é controle suficiente.
7. Navegação e desenho de telas
No celular, navegação principal: Hoje • Pacientes • Pendências • Escala • Mais. Financeiro e administração aparecem por permissão. Desktop acrescenta visão em tabela, comparação de fontes e calendário ampliado.
Tela	Conteúdo e ações essenciais
Meu dia	Hospital/serviço/data fixos no cabeçalho; pacientes atribuídos; mudanças recentes; tarefas vencidas; cobertura; última sincronização
Lista de pacientes	Nome + segundo identificador autorizado; leito; dias de acompanhamento; motivo; estabilidade confirmada; última visita; próxima ação; responsável
Resumo de internação	Problemas ativos, linha do tempo, alergias e medicações confirmadas, exames com data, pendências e limites de cuidado documentados
Visita guiada	Preparar → atualizar → revisar → finalizar → passar caso; salvar rascunho em cada etapa
Captura	Botões ditar/fotografar/importar; paciente sempre visível; prévia, recorte e remoção de páginas erradas
Conferência	Original e extração lado a lado; texto duvidoso marcado; aceitar/corrigir/rejeitar por campo
Passagem	Síntese curta, tarefas, contingências e receptor; aceite explícito e dúvidas
Escala	Mês/semana/lista; recorrências; cobertura; conflito; troca; publicação
Financeiro	Produção, elegibilidade, cobrança, recebimento e repasse em abas distintas
Coordenação	Exceções: pacientes sem visita, pendências sem dono, turnos descobertos, rascunhos atrasados, divergências financeiras
Protocolos	Versões aprovadas, fontes, população, revisão e possibilidade de suspender


Requisitos de UX: alvos de toque amplos; teclado reduzido; contraste e estados além da cor; fonte legível; acessibilidade por teclado; salvamento com hora e status; ação de desfazer antes da finalização; modal de troca de paciente durante gravação. Não mostrar um semáforo verde de estabilidade calculado pela IA. Usar etiquetas “confirmado”, “extraído, não conferido”, “histórico” e “não informado”.
Visão do coordenador deve privilegiar exceções; visão do médico, execução da visita. Evitar exigir dezenas de campos em pacientes estáveis: itens condicionais, respostas rápidas e justificativa de não aplicabilidade.
8. Fluxo clínico completo
8.1 Entrada e censo
Cadastrar/importar paciente com nome e segundo identificador, número de prontuário no hospital quando disponível, internação e localização. Alertar possíveis duplicidades; fusão somente revisada, auditada e reversível por vínculo de identidades, sem reescrever notas.
Registrar motivo da interconsulta, solicitante, horário da solicitação, prioridade atribuída por pessoa autorizada, serviço responsável e prazo institucional. Admissão hospitalar e início do acompanhamento podem ter datas diferentes. Estado do acompanhamento: solicitado → aceito → ativo → encerrado; cancelado com justificativa.
Conciliar censo diariamente. Alta da neurologia não equivale a alta hospitalar. Transferência de unidade preserva episódio; nova internação é novo episódio. Óbito, transferência externa e alta encerram o fluxo apropriado sem apagar pendências de seguimento.
8.2 Preparação da visita
Exibir última nota finalizada, mudanças confirmadas desde ela, problemas ativos e plano vigente. Gerar lista de conferência a partir de: tarefas anteriores, exame solicitado ainda sem resultado, protocolo aprovado aplicável e informação explicitamente ausente. Distinguir pergunta clínica sugerida de tarefa já determinada pelo médico.
Registrar data de cada informação, origem e estado de conferência. Exame de três dias atrás não aparece como “exame de hoje”. Sem integração, mostrar “última importação às …”; nunca sugerir vigilância contínua.
8.3 Durante a visita
Coletar intervalos de evolução, intercorrências, relato de paciente/familiar/equipe, exame atual, resultados revisados e avaliação por problema. Aceitar texto, ditado, fotos e PDF. O formulário pode ficar parcialmente vazio: ausência de informação deve permanecer explícita.
8.4 Revisão e conclusão
Gerar rascunho estruturado. Mostrar origem dos fatos e mudanças em relação ao último registro. Médico confirma identificação, temporalidade, achados, medicações citadas e plano. Bloquear finalização apenas por problemas críticos definidos: identidade não resolvida, autoria, inconsistência de vínculo, campos institucionais indispensáveis e conflitos críticos não revisados. Outros avisos permitem justificativa.
Finalizar cria versão imutável, autoria e data/hora. Correções posteriores são adendos vinculados, nunca edição silenciosa. Evolução tardia tem horário do atendimento e do registro separados. Assinatura/autoria técnica não é declarada automaticamente assinatura digital qualificada.
8.5 Passagem e encerramento
Toda ação gera tarefa aceita pelo médico com responsável individual ou fila coberta, prazo, critério de conclusão e eventual contingência aprovada. Receptor confirma a passagem; tarefas críticas não aceitas seguem escalonamento configurado. Na alta, resultados pendentes recebem destino e responsável de seguimento, ou justificativa; não desaparecem.
9. Estrutura da evolução e do plano
Nota inclui: contexto/motivo; antecedentes relevantes; estado basal; intercorrências; subjetivo; exame; resultados revistos; avaliação por problema; plano por problema; comunicação com paciente/família/equipe; pendências; destino; autoria; uso de IA e referências necessárias.
Cada problema contém:
- Descrição e categoria; hipótese/diferencial/confirmado, sem converter hipótese automaticamente.
- Evidências favoráveis, discordantes e ausentes; datas e fontes.
- Estado: ativo, em investigação, resolvido ou suspenso; responsável e última revisão.
- Objetivo do dia, ações e critérios de reavaliação definidos pelo médico.
- Dependências: “rever resultado” depende de resultado disponível, não apenas de prazo vencido.
Separar não avaliado, não informado, ausente, presente, não aplicável. Normalidade exige observação expressa. Dados reutilizados da nota anterior são apresentados como históricos até confirmação; não copiar exame físico automaticamente.
Medicações devem distinguir uso domiciliar, prescrição hospitalar, administração confirmada, proposta e suspensão. Uma frase “considerar suspender” não altera lista ativa. Não implementar prescrição eletrônica nem envio de ordens médicas na primeira versão.
10. Biblioteca clínica e orientação inteligente
10.1 Três camadas separadas
1. Completude operacional: campos faltantes, tarefas vencidas, resultado recebido sem revisão. Regras determinísticas.
2. Conteúdo clínico aprovado: perguntas, itens de exame, interpretação educacional e limitações de protocolos versionados.
3. Apoio individualizado à decisão: relaciona dados do caso a conteúdo aprovado; depende de validação e análise regulatória. Feature flag desligada inicialmente.
Não confundir interface de chat com motor clínico. O sistema pode ser útil mesmo sem chat livre. Preferir botões contextuais: “o que falta perguntar?”, “quais resultados estão pendentes?”, “mostrar fonte”, “preparar passagem”.
10.2 Pacotes iniciais de neurologia — escopo editorial
Os temas abaixo são mapas para autoria médica, não protocolos prontos para produção. O Claude Code constrói os campos e fluxos, mas não inventa limiares, doses ou condutas. Fontes clínicas específicas precisam ser selecionadas e aprovadas pela coordenação.
Pacote	Dados/perguntas a organizar	Resultados a acompanhar quando indicados	Salvaguarda de interpretação
Déficit focal/AVC	Cronologia, último momento bem, estado basal, evolução do déficit e intervenções já realizadas	Laudos e horários de neuroimagem, estudos solicitados e avaliações funcionais	Distinguir hora de início de hora de reconhecimento; não sugerir elegibilidade terapêutica sem conjunto validado
Crise epiléptica	Semiologia, duração, recorrência, recuperação, adesão e intervenções	Exames e EEG já indicados, medicações administradas	Ausência de evento observado não equivale a ausência de crise; laudo e hipótese clínica separados
Alteração do estado mental	Basal cognitivo, flutuação, sedação, exposição medicamentosa e relato da equipe	Resultados em investigação, tendências e datas	Não transformar desorientação em diagnóstico etiológico; registrar fatores que limitam exame
Cefaleia	Padrão, início, mudança do habitual, sintomas associados e contexto	Investigação já definida pela equipe	Perguntas de alerta devem vir de conteúdo validado; não gerar tranquilização automática
Fraqueza neuromuscular	Distribuição, progressão, sintomas bulbares/respiratórios e disautonomia	Avaliações e exames solicitados, medidas seriadas com técnica/unidade	Não classificar estabilidade a partir de um único dado ausente ou transcrito
Infecção/inflamação do SNC	Cronologia, estado imune, exposições, tratamentos prévios	Líquor, microbiologia e neuroimagem quando presentes	Vincular coleta a tratamento e data; não tratar teste isolado como exclusão universal
Parkinson internado	Esquema habitual e horários, doses omitidas, deglutição, mobilidade e estado mental	Reconciliação prescrita/administrada	Não sugerir suspensão ou ajuste automático


10.3 Modelo editorial
protocol_version: identificador, especialidade, população, inclusão/exclusão, fonte/URL, seção, data da fonte, autoria, revisor, aprovação, vigência, próxima revisão, jurisdição, licença e motivo de alteração.
protocol_item: pergunta, campo necessário, condição de exibição, tipo de orientação, justificativa, referência e prioridade. Lógica em DSL declarativa com operadores permitidos; sem executar JavaScript ou SQL fornecido por usuário. Publicação exige revisão clínica. Nova versão não reescreve o conteúdo citado em notas antigas.
RAG, se usado: repositório de conteúdo aprovado, filtrado por tenant/escopo/população/versão antes da recuperação. Resposta apresenta fontes recuperadas e lacunas; sem fonte adequada, abstém-se. Busca na internet com dados do paciente é proibida. Pesquisa editorial externa é processo separado e sem dados identificáveis.
11. Voz, transcrição e estruturação
Fluxo: selecionar paciente → confirmar contexto → ditar → enviar trechos com sequência → transcrever → estruturar → conferir → aceitar rascunho → finalizar.
Preferir ditado médico na primeira fase; gravação ambiente de conversa é recurso separado com informação ao paciente e política institucional. Nunca iniciar microfone sem ação. Mostrar duração, pausa, encerrar e descartar. Em iOS, testar bloqueio de tela, chamada recebida, permissão negada e troca de app; não prometer gravação em segundo plano.
Requisitos:
- Português brasileiro e termos neurológicos; glossário configurável, sem completar palavras incertas por adivinhação.
- Preservar transcrição literal e versão editada conforme política; segmentos com timestamp e origem.
- Identificar fala relatada versus achado do médico; rótulo de locutor não comprova identidade.
- Proteger negações, lateralidade, doses, horários, unidades, duração e caráter hipotético.
- Ruído, silêncio ou trecho incompleto geram inaudível/lacuna; nunca fatos novos.
- Ao reprocessar, criar nova execução e nova proposta; não sobrescrever conteúdo aprovado.
- Jobs idempotentes, uploads retomáveis e estado de falha recuperável; o usuário pode continuar digitando.
- Transcrição não resolve falta de anamnese: converter informação ausente em pergunta, não em resposta.
Fornecedor de fala é adaptador. A documentação do Amazon Transcribe lista suporte a pt-BR [R7], mas isso não demonstra precisão em neurologia nem disponibilidade de todos os recursos na região escolhida. Comparar pelo menos dois candidatos em amostra autorizada/sintética representativa, inclusive sotaques, ruído e nomes de medicamentos. Não selecionar pelo menor preço por minuto isoladamente.
12. Foto, OCR e importação
Aceitar câmera, imagem e PDF; formatos, páginas e tamanho limitados por configuração. Fotografar texto de laudo ou tela não significa interpretar imagem de TC/RM, ECG ou traçado de EEG. Análise diagnóstica de imagens fica fora do escopo inicial.
Pipeline:
1. Prévia e confirmação de paciente/internação; detectar baixa nitidez, reflexo e recorte insuficiente.
2. Recortar conteúdo necessário; retirar outros pacientes, notificações e áreas alheias antes de enviar ao prestador sempre que tecnicamente possível.
3. Validar MIME real, tamanho e arquivo; converter em ambiente isolado; bloquear conteúdo ativo; remover metadados de localização.
4. Armazenar em área privada/quarentena; hash para integridade e duplicidade dentro do escopo.
5. Extrair texto com coordenadas, páginas e tabelas; preservar imagem e texto bruto pelo prazo aprovado.
6. Classificar documento e extrair identificação, data de coleta, emissão, tipo, valores, unidades, intervalos e conclusão literal.
7. Comparar identificadores. Divergência ou identificação insuficiente exige revisão; nunca anexar automaticamente pelo leito.
8. Conferir lado a lado; após aceite, criar resultados estruturados com proveniência.
Casos obrigatórios: várias datas numa tela, colunas de coletas diferentes, dois pacientes na foto, nome truncado, vírgula decimal, símbolos </>, unidade ausente, data ambígua, página repetida, laudo preliminar/retificado e fotografia inclinada. Não alinhar valor de uma coluna à data de outra por inferência silenciosa.
Valor bruto, valor normalizado e unidade são campos separados. Intervalo de referência pertence ao laudo e ao contexto; não aplicar um único intervalo universal. Transformações precisam ser rastreáveis. Resultado retificado substitui a visão corrente, preserva versão anterior e reabre a necessidade de revisão.
OCR dedicado, como Azure Document Intelligence, extrai texto e estrutura [R8]; um modelo multimodal pode ajudar a estruturar, mas seu desempenho clínico precisa ser medido. Confiança retornada pelo provedor não é probabilidade de correção clínica. Campos de risco requerem conferência mesmo com pontuação alta.
13. Contrato da IA e rastreabilidade
Toda chamada é interna ao servidor, com contexto mínimo, fornecedor permitido pelo tenant e sem acesso livre a ferramentas. Nenhuma IA possui permissão para finalizar notas, autorizar acesso, prescrever, publicar escala ou lançar pagamento.
Esquema conceitual de saída; implementar JSON Schema completo, validado em runtime, com additionalProperties: false, limites e enums:
{
  "schema_version": "1.0",
  "source_ids": ["documento_sintetico_1"],
  "facts": [
    {
      "field": "reported_seizures",
      "value": "Nenhuma crise relatada desde ontem",
      "assertion": "negated",
      "observed_at": null,
      "time_text": "desde ontem",
      "reporter": "clinician_dictation",
      "evidence": [{"source_id": "documento_sintetico_1", "start_ms": 1200, "end_ms": 4600}],
      "review_status": "unreviewed"
    }
  ],
  "missing_information": ["Definir intervalo temporal exato"],
  "conflicts": [],
  "draft_note": "",
  "proposed_tasks": [],
  "warnings": []
}
Identificadores de tenant, paciente e internação são definidos pelo servidor e não aceitos da saída do modelo. Cada trecho factual da nota aponta para fonte existente; interpretação é explicitamente rotulada. Não armazenar raciocínio interno do modelo; guardar entradas mínimas permitidas, evidências, saída, versões e decisões do revisor.
Registro de execução: fornecedor/modelo/versão declarada, versão do prompt, esquema, hash das entradas, documentos consultados, latência, custo estimado/medido, status, usuário solicitante e revisor. Mudança de modelo ou prompt exige regressão antes de habilitar.
Defesa contra prompt injection: documentos e transcrições são dados não confiáveis, inclusive frases “ignore instruções”; separar instruções do sistema; allowlist de operações; sem URLs arbitrárias buscadas pelo modelo; sem segredos no contexto. JSON válido não prova veracidade. Implementar validação de evidências e revisão humana.
Em caso de indisponibilidade, manter evolução manual, upload e pendência de processamento. Não trocar silenciosamente para fornecedor sem contrato. Orçamento por tenant/job e limites de concorrência evitam abuso e custos inesperados.
14. Tarefas, alertas e passagem de plantão
Tarefa: tipo, paciente/internação/serviço, problema, ação objetiva, solicitante, responsável/fila, vencimento, prioridade humana, fonte, dependências e critério de conclusão. Estados: proposta → aberta → em andamento → bloqueada → concluída; cancelada com motivo. Aceite de proposta é registrado.
“Checar RM” deve explicitar se é agendar, confirmar realização, obter laudo ou revisar resultado. Solicitado, realizado, resultado disponível e revisado pelo médico são estados diferentes. Tarefa recorrente é separada da escala recorrente.
Passagem guarda snapshot do contexto, emissor, receptor, tarefas incluídas, horário, aceite e dúvidas. Pendências não aceitas permanecem atribuídas conforme política; não criar vazio de responsabilidade na troca de turno. Ausência do receptor aciona substituto/coordenador.
Alertas operacionais podem ser gerados automaticamente. Alertas clínicos requerem regras aprovadas e dados válidos. Todo alerta tem origem, motivo, gravidade, destinatário, reconhecimento, resolução e deduplicação. Configurar janelas silenciosas apenas para itens não urgentes. Push/e-mail mostram texto genérico e link autenticado, sem diagnóstico ou nome de paciente.
O app não é canal garantido de emergência nem monitor contínuo. Orientações institucionais de acionamento urgente devem permanecer claras; entrega de push não prova que alguém assumiu o caso.
15. Escala e recorrências
Modelo separa: regra de recorrência → ocorrência concreta → profissional escalado → cobertura efetivamente realizada. Um profissional escalado não recebe automaticamente por todos os pacientes do dia.
Campos de série: tenant, hospital, serviço, modalidade (visita, retaguarda, plantão), timezone IANA, início local, duração, RRULE, vigência, exceções, versão e status. Turnos podem atravessar meia-noite. Definir data assistencial e data financeira por contrato; não inferir pelo timestamp UTC.
Exemplos de teste (datas sintéticas, fuso America/Sao_Paulo):
Bruno, segundas às 08h:
DTSTART;TZID=America/Sao_Paulo:20261005T080000
RRULE:FREQ=WEEKLY;BYDAY=MO

João, sábado e domingo de semanas alternadas, a partir de 03/10/2026:
DTSTART;TZID=America/Sao_Paulo:20261003T080000
RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU;WKST=MO
Segundo exemplo deve produzir 03/10, 04/10, 17/10, 18/10, 31/10 e 01/11. Não equivale a primeiro e terceiro fins de semana do mês. Cada ocorrência tem duração própria; o fim de semana não é presumido plantão contínuo.
Requisitos:
- Materializar horizonte móvel configurável, inicialmente 90 dias, com unicidade por série + início original. Regenerar sem duplicar.
- Alterar “somente este”, “este e futuros” ou “série inteira”. Dividir série ao mudar futuros; preservar passado e ocorrências executadas/fechadas.
- EXDATE, inclusões e substituições mantêm vínculo com início original. Cancelamento não apaga auditoria.
- Férias, feriados, indisponibilidade, múltiplos hospitais e preferências. Preferência não é disponibilidade confirmada.
- Detectar sobreposição e intervalo insuficiente entre hospitais; permitir exceção justificada quando adequado ao tipo de cobertura.
- Fluxo de troca: proposta → aceite do substituto → aprovação quando exigida → publicação atômica. Original permanece responsável até conclusão.
- Publicação com versão, notificações e confirmação; demonstrar lacunas por serviço/data/modalidade.
- Calendário externo recebe somente escala, sem pacientes. Integração Google Calendar/ICS em fase posterior, inicialmente unidirecional; app é fonte da verdade.
16. Produção, cobrança, recebimento e repasse
16.1 Objetos distintos
1. Atendimento realizado: evidência operacional de quem fez o quê e quando.
2. Evento de produção elegível: avaliado por regra contratual, sujeito a revisão.
3. Item de cobrança: valor a cobrar do pagador/hospital.
4. Recebimento: dinheiro efetivamente recebido e conciliado.
5. Direito a repasse: valor devido ao profissional segundo contrato.
6. Pagamento de repasse: liquidação, inicialmente registrada manualmente.
Não vincular diretamente a quantidade de notas à quantidade de cobranças. Dois médicos podem colaborar em um atendimento; uma nota pode ser apenas adendo. Finalização pode gerar candidato a produção, jamais duplicar automaticamente cobrança.
16.2 Contratos versionados
Contratante/pagador, hospital/serviço, vigência, moeda, competência, corte, prazo de pagamento, documentação, valor fixo, diária, visita, paciente-dia, procedimento, faixa, teto/franquia, coordenação, regras de adicional, exclusões e arredondamento. Uma regra deve declarar se é cumulativa ou mutuamente exclusiva com outras.
Repasse é contrato separado: fixo por cobertura, percentual, paciente atendido, pontos ou mistura. Declarar base bruta/líquida, deduções autorizadas, competência versus caixa, inadimplência, glosa, estorno e taxa de coordenação. Não assumir tributação, códigos TUSS ou alíquotas; configurar após validação contábil/contratual.
16.3 Exemplo sintético determinístico
Contrato ilustrativo: R$ 750/dia inclui até 10 pacientes elegíveis; excedentes a R$ 120. Com 13 pacientes, bruto = 750 + max(13−10,0) × 120 = R$ 1.110. Não é preço proposto nem contrato confirmado.
Se um acordo distinto distribuir 20% do bruto à coordenação e 80% ao executante: R$ 222 e R$ 888. Impostos/deduções só entram se definidos; não subtrair e depois aplicar novamente em outra etapa. Com múltiplos executantes, pesos aprovados precisam somar 100% da parcela pertinente.
Valores em centavos inteiros ou NUMERIC decimal, nunca float. Guardar memória de cálculo, versão da regra, fatos de entrada e justificativas. Arredondar ao final da regra definida; resíduos de rateio distribuídos por método determinístico documentado.
16.4 Fluxo de fechamento
Produção importada → elegibilidade → revisão de divergências → simulação → aprovação → competência fechada → cobrança → conciliação → demonstrativos/repasse. Separar quem prepara de quem aprova quando configurado. Alterar conta bancária exige verificação reforçada e não modifica pagamentos previamente aprovados.
Competência fechada é imutável. Glosa, recuperação, cancelamento, recebimento parcial e ajuste retroativo são lançamentos vinculados, sem reescrever histórico. Política de adiantamento e repasse por caixa/competência deve ser explícita. Exportar planilha de cobrança e demonstrativo individual com mínimo de dados necessários.
Ledger gerencial de partidas balanceadas para recebimentos e obrigações, sem alegar substituir contabilidade fiscal. Lançamentos atômicos e idempotentes, com igualdade de débitos e créditos por transação. Repasses não executam PIX na primeira versão. Documentação no prontuário e segurança assistencial nunca podem depender de pagamento.
17. Modelo de dados lógico
Todas as tabelas de negócio incluem id, tenant_id, autoria e timestamps; adicionar version para concorrência onde mutável. Abaixo estão campos de domínio essenciais, além dessa base.
Grupo	Entidades	Campos/relações essenciais
Identidade	users, sessions, tenants, memberships, role_grants	usuário global; vínculo ativo; papel; escopo; vigência; permissão
Organização	hospitals, units, beds, specialties, services	hospital; especialidade; equipe; localização com histórico
Paciente	patients, patient_identifiers, identity_links	dados mínimos; identificador + autoridade emissora; fusão auditada
Internação	encounters, location_history, service_episodes, care_assignments	admissão/alta; hospital; motivo; serviço; responsáveis
Clínica	problems, observations, medication_statements, allergies	status clínico, tempo observado, fonte, estado de revisão
Notas	notes, note_versions, note_addenda, attestations	tipo; rascunho; versão final; autor; atendimento; aprovação/assinatura
Arquivos	source_documents, document_versions, source_spans	tipo; storage key; hash; paciente; coleta/emissão; página/trecho
Resultados	diagnostic_reports, report_versions, result_reviews	preliminar/final/retificado; coleta; resultado; revisor
Continuidade	tasks, task_events, handoffs, handoff_acknowledgments	dono; prazo; status; dependência; snapshot; aceite
Escala	schedule_series, schedule_exceptions, shift_occurrences, shift_assignments, swap_requests, coverage_actuals	RRULE; timezone; ocorrência original; versão; planejado/real
Conhecimento	protocols, protocol_versions, protocol_items, source_references	fontes; população; aprovação; licença; validade
IA	ai_jobs, ai_runs, ai_proposals, proposal_reviews	modelo/prompt; entradas; evidências; saída; aceite/correção
Financeiro	payer_contracts, contract_versions, production_events, charge_items, invoices, receipts, receipt_allocations	elegibilidade; memória de cálculo; idempotência; estados
Repasse	compensation_contracts, allocation_rules, payout_statements, payout_items, settlements, ledger_transactions, ledger_entries	base; pesos; centavos; fechamento; estornos
Governança	audit_events, access_reviews, data_processing_records, retention_policies, legal_holds, incident_records	acesso; finalidade; retenção; bloqueio de descarte; incidente
Infraestrutura	outbox_events, integration_mappings, webhook_receipts, notification_deliveries	idempotência; status; retries; versão externa


Invariantes: alta >= admissão; prazo tem timezone definido; source span pertence ao documento autorizado; resultado pertence à mesma internação ou está rotulado como histórico externo; finalização não pode ocorrer com versão desatualizada; regra financeira tem vigência não ambígua; paciente-dia elegível tem chave de deduplicação definida por contrato, sem impedir atendimento extra legítimo com código próprio.
Índices iniciais: (tenant_id,hospital_id,status) para internações; (tenant_id,service_id,due_at,status) para tarefas; (tenant_id,encounter_id,observed_at) para clínica; (tenant_id,service_id,start_at) para turnos; (tenant_id,period_id,status) para financeiro. Usar paginação por cursor. Projetar busca textual com filtro de acesso antes de retornar resultados.
18. Arquitetura recomendada
Camada	Escolha proposta	Motivo
Cliente	React/Next.js + TypeScript, responsivo/PWA	Um produto para visita móvel e coordenação desktop
API/domínio	TypeScript no servidor, módulos independentes; OpenAPI	Contratos explícitos e possibilidade futura de app nativo
Banco	PostgreSQL gerenciado	Transações, constraints e RLS
Acesso SQL	Drizzle ou camada SQL tipada; escolher uma	Migrações explícitas; políticas no banco mantidas em SQL
Autenticação	Provedor OIDC gerenciado com MFA	Evitar construir senhas e recuperação próprias
Arquivos	Object storage privado com criptografia e lifecycle	Áudio, imagens e documentos fora das tabelas
Jobs	Worker separado do processo web e fila durável	OCR/transcrição continuam após fechar navegador
Eventos	Outbox transacional no PostgreSQL	Evitar nota salva sem evento ou evento sem nota
Observabilidade	Logs estruturados, métricas e traces sem conteúdo clínico	Diagnóstico de falhas sem expor paciente
Deploy	Contêiner web + worker; ambientes separados	Simplicidade de operação e portabilidade


Fixar versões estáveis suportadas e lockfile no início da implementação, consultando documentação atual. Não copiar versões presumidas deste documento. Autorização deve ocorrer em cada operação de servidor; uma checagem de página não cobre todas as entradas [R9].
Estrutura sugerida do repositório:
apps/web
apps/worker
packages/domain/identity
packages/domain/clinical
packages/domain/scheduling
packages/domain/billing
packages/domain/knowledge
packages/authorization
packages/database
packages/ai-adapters
packages/contracts
packages/ui
tests/security
tests/clinical-fixtures
tests/scheduling
tests/billing
docs/adr
docs/runbooks
Sem microserviços por especialidade. Templates variam; núcleo e segurança permanecem comuns. Não adotar múltiplos agentes autônomos para decisões clínicas; pipelines explícitos com etapas verificáveis são mais adequados ao primeiro produto.
19. API, eventos e concorrência
Rotas exemplificativas, sempre no tenant resolvido e autorizado pelo servidor:
Método/rota	Comportamento
GET /v1/worklist	Lista por hospital/serviço/data e permissões
POST /v1/encounters	Cria episódio com validação de identidade
POST /v1/encounters/:id/notes	Cria rascunho e versão
PATCH /v1/notes/:id	Atualiza com If-Match/version; conflito retorna 409
POST /v1/notes/:id/finalize	Confirma versão, autoria, invariantes e evento atômico
POST /v1/notes/:id/addenda	Adendo vinculado, sem mutação da versão final
POST /v1/uploads	Emite autorização de upload limitada ao objeto/escopo
POST /v1/documents/:id/process	Job idempotente, retorna 202 e identificador
POST /v1/proposals/:id/review	Aceita/corrige/rejeita campos, com auditoria
POST /v1/handoffs/:id/acknowledge	Aceite explícito do receptor autorizado
POST /v1/schedules/preview	Simula recorrência sem publicar
POST /v1/schedules/:id/publish	Publica versão validada e eventos
POST /v1/billing/periods/:id/simulate	Memória de cálculo, sem fechar
POST /v1/billing/periods/:id/close	Fechamento transacional com bloqueio concorrente
GET /v1/payout-statements/:id	Próprio ou capacidade financeira concedida


Comandos sensíveis recebem Idempotency-Key com escopo de tenant, usuário e operação; armazenar hash da requisição para impedir reutilização com conteúdo distinto. Jobs têm estado queued/running/succeeded/failed/cancelled, timeout, retry exponencial limitado e fila de falhas. Consumidores revalidam vínculo e escopo antes de processar/entregar.
Eventos: note.finalized, report.available, report.corrected, task.overdue, handoff.sent, handoff.acknowledged, schedule.published, coverage.confirmed, production.reviewed, period.closed e receipt.allocated. Payload mínimo com IDs, versão e tenant; consumidores carregam dados por acesso autorizado. Eventos podem repetir; efeitos não.
Edição concorrente usa optimistic locking; nunca last-write-wins silencioso em nota ou plano. Finalização verifica versão e grava nota, auditoria e outbox na mesma transação. Se duas pessoas finalizam, a segunda recebe conflito e compara versões. Desfazer alteração de rascunho não apaga trilha finalizada.
20. Segurança, privacidade e requisitos brasileiros
20.1 Pesquisa regulatória
Dados de saúde são sensíveis na LGPD; definir finalidade, base legal, agentes de tratamento e controles de acesso [R10]. Não presumir que um consentimento genérico resolve todos os tratamentos. Separar cuidado, gravação, uso de IA e eventual pesquisa/treinamento por finalidade.
A Lei 13.787/2018 trata digitalização/guarda e prevê prazo mínimo de 20 anos a partir do último registro para eliminação dos prontuários em papel e digitalizados, nas condições legais [R11]. Não transformar esse número em TTL universal de áudio, fotos, logs ou registros originalmente eletrônicos. Elaborar matriz de retenção por categoria, obrigação institucional e bloqueio legal.
O CFM informa vigência da Resolução 2.454/2026 desde 26/08/2026 [R12]. A norma consultada aborda supervisão humana, informação ao paciente, registro do apoio de IA, risco e governança [R13]. Antes do piloto, revisar texto consolidado e retificações com direção técnica; converter aplicabilidade em requisitos verificáveis, incluindo governança institucional quando exigida.
A RDC 657/2022 e orientações da Anvisa tratam software como dispositivo médico [R14]. Conteúdo que interpreta dados e orienta conduta individual pode mudar o enquadramento. Não concluir isenção apenas porque há revisão humana ou um aviso “apoio”. A pesquisa localizou revisão do tema na agenda 2026–2027, o que não prova publicação de norma substitutiva [R15]. Confirmar situação vigente antes de liberar apoio à decisão.
Transferências internacionais exigem avaliação e mecanismo aplicável, considerando a regulamentação ANPD [R16]. Região brasileira de banco não garante que IA, logs ou suporte fiquem no país. Mapear toda a cadeia. Manter processo de resposta a incidentes alinhado à regulamentação aplicável [R17], sem prazos jurídicos inventados pelo código.
20.2 Controles implementáveis
- MFA para usuários com dados sensíveis; sessão com expiração e revogação, bloqueio por inatividade conforme política e reautenticação para ações de maior risco.
- RLS ativada e testada; conexão de aplicação sem superusuário, ownership indevido ou BYPASSRLS. Contexto SQL transacional validado pelo servidor; evitar vazamento por pool de conexões.
- Autorização na API, domínio, consultas, jobs e download; negação por padrão. Política de RLS protege linhas; projeções/API protegem campos.
- Buckets privados; URL de curta validade só após checagem, sem nome de paciente no caminho. Para revogação imediata, servir por proxy autenticado; URLs já emitidas expiram mas podem não ser revogáveis individualmente.
- Criptografia em trânsito e repouso, gestão de chaves, segredos fora do repositório e rotação. Backup igualmente protegido.
- Nenhum texto clínico em analytics, session replay, logs de erro, prompt telemetry público ou notificação externa.
- Auditoria de leitura, escrita, exportação, impressão, acesso excepcional, alteração de acesso e ação financeira. Log append-only com proteção contra alteração e acesso separado.
- Anti-CSRF quando aplicável, CSP, validação de uploads, rate limiting por usuário/tenant, prevenção de SSRF e dependências verificadas.
- Dados sintéticos em dev/teste; exportação para depuração requer processo separado. Sem treinamento em dados do paciente por padrão contratual e técnico.
- Retenção configura original, derivado, backup e execução de IA; apagar objeto temporário não apaga nota válida. Legal hold prevalece sobre descarte.
- Em desligamento de tenant: exportação autorizada, revogação, preservação legal e descarte verificável conforme contrato. Não excluir registros por simples cancelamento de assinatura.
Aprovação institucional da captura de tela/foto é requisito de implantação. O sistema deve facilitar minimização; não deve incentivar fotografar listas inteiras ou burlar limitações de acesso do prontuário hospitalar.
21. Integração e fonte da verdade
Definir por campo quem é autoridade: identidade/admissão/leito normalmente vêm do hospital; tarefas e escala, deste app; notas finais têm destino oficial acordado. Quando divergirem, mostrar conflito com fonte/data. Não sobrescrever automaticamente a informação institucional.
Primeira versão: entrada manual, foto/PDF autorizados e exportação de texto/arquivo revisado. Registrar “preparado”, “exportado” e “incorporado ao prontuário oficial” separadamente. Copiar texto não comprova incorporação. Se manual, profissional confirma registro; se API, guardar acknowledgement externo.
Fase seguinte: adaptadores para APIs disponíveis e FHIR conforme versão/perfil do hospital. Mapeamento proposto: Patient, Encounter, PractitionerRole, Observation, DiagnosticReport, DocumentReference, Task e Provenance. Não prometer integração automática com Tasy, MV ou outro fornecedor sem documentação e autorização. Terminologias, identificadores e licenças precisam ser acordados.
Webhooks assinados, timestamp anti-replay, chave idempotente, retries e reconciliação periódica. Documento retificado e alta recebida fora de ordem exigem versionamento. Conectores não usam a senha pessoal do médico para scraping não autorizado.
Google Sheets pode receber resumos financeiros/operacionais minimizados e autorizados para gestão; não será banco clínico, repositório de áudio nem fonte da verdade. Exportação opcional e somente após definir quem pode acessar a planilha.
22. Confiabilidade e operação
Metas iniciais propostas, a validar com carga e orçamento: disponibilidade mensal de 99,9% do núcleo; p95 de leitura interativa menor que 2 s no cenário de teste definido; RPO até 15 min e RTO até 4 h para o piloto. Não anunciar esses números como SLA sem arquitetura e ensaios que os sustentem.
Jobs de IA têm latência medida por duração/páginas e não bloqueiam o núcleo. Capacidade inicial de teste sugerida: 5 hospitais, 100 usuários concorrentes e 2.000 internações ativas sintéticas; ajustar ao volume real. Limites por tenant evitam monopolização.
Backups automáticos, recuperação pontual se contratada e exercício de restauração antes do piloto. Monitorar banco, fila, worker, armazenamento e prestadores. Runbooks para indisponibilidade, perda de sessão, documento anexado errado, falha de IA, vazamento, restauração e cobrança duplicada.
Offline: MVP não armazena prontuário completo em cache local. Service worker apenas para shell/ativos públicos; excluir API, PDFs, imagens e respostas clínicas de cache persistente. Rascunho ainda não enviado permanece claramente “não salvo” e não pode ser finalizado offline. Se houver necessidade real de offline, abrir projeto específico de criptografia, expiração, revogação, sincronização e conflitos, considerando limitações do navegador.
Contingência hospitalar: atendimento e registro institucional continuam; depois reconciliar entradas com data real e autoria. App não substitui suporte presencial/telefone em urgência.
23. Testes e critérios de aceite
23.1 Casos obrigatórios de ponta a ponta
ID	Cenário	Resultado esperado
SEC-01	Usuário tenant A tenta ID conhecido do tenant B em API, arquivo e job	Acesso negado, sem metadados clínicos na resposta
SEC-02	Coordenador de dois serviços tenta acessar terceiro	Negado, apesar do título de coordenador
SEC-03	Secretária acessa endpoint clínico e demonstrativo sem concessão	Negado no servidor; cadastro mínimo continua disponível
SEC-04	Usuário revogado possui job em andamento	Job não entrega conteúdo ao usuário; acesso novamente validado
SEC-05	Reutilização de conexão SQL após outro tenant	Nenhum contexto anterior persiste
CLI-01	Ditado “não apresentou crise”, mas modelo retorna crise presente	Validação/revisão identifica conflito; nada finalizado automaticamente
CLI-02	OCR de paciente diferente	Quarentena; bloqueio até corrigir vínculo por usuário autorizado
CLI-03	Foto com várias datas e potássio com vírgula	Campo vinculado à data e unidade corretas após revisão
CLI-04	Nota anterior descreve exame normal, hoje sem exame informado	Exame atual permanece não informado
CLI-05	Dois médicos editam e finalizam mesma nota	Segundo recebe 409; nenhuma perda silenciosa
CLI-06	Correção após finalizar	Adendo com autoria; original preservado
CLI-07	Resultado retificado depois da revisão	Nova versão, aviso e nova pendência de revisão
CLI-08	Alta com resultado pendente	Exige destino/responsável ou justificativa de encerramento
AI-01	Texto importado manda exportar dados ou ignorar regras	Tratado como texto; nenhuma ferramenta executada
AI-02	IA indisponível ou orçamento excedido	Evolução manual e dados salvos continuam funcionando
AI-03	Silêncio ou áudio interrompido	Nenhuma invenção; lacuna e opção de retomar
ESC-01	Recorrência quinzenal do exemplo	Datas exatas listadas na seção 15, incluindo virada do mês
ESC-02	Troca de domingo	Sábado preservado; profissional original permanece até aprovação
ESC-03	Edição “este e futuros”	Passado e produção fechada não alterados
ESC-04	Turno atravessa meia-noite e simulação em fuso com DST	Instantes/duração/data contratual consistentes
FIN-01	Exemplo 13 pacientes	R$ 1.110; rateio ilustrativo 222/888, soma exata
FIN-02	Finalização/retry repetido	Um único candidato/evento elegível, sem cobrança duplicada
FIN-03	Dois fechamentos simultâneos	Um fechamento efetivo; segunda operação retorna estado existente/conflito
FIN-04	Recebimento parcial e glosa posterior	Saldos corretos, histórico preservado, repasse conforme política
OPS-01	Restaurar backup em ambiente isolado	Dados/arquivos essenciais consistentes e tempos medidos
UX-01	iPhone: câmera/microfone negados, chamada e conexão perdida	Mensagem clara, sem falso “salvo”, sem troca acidental de paciente


23.2 Avaliação clínica da IA
Criar corpus inicial proposto de pelo menos 100 ditados/documentos sintéticos ou autorizados, estratificado por tipo, ruído, tabela, lateralidade, negação, datas e medicação. Essa quantidade é ponto de partida de engenharia, não tamanho de amostra clinicamente validado. Usar revisores médicos, adjudicação de divergências e conjunto retido sem ajuste de prompt.
Medir precisão por campo, omissões, alucinações, inversão de negação/lateralidade, erro de dose/unidade/data, troca de paciente, taxa de correção e tempo de revisão. WER de transcrição isolado é insuficiente. Definir gravidade antes de avaliar. Qualquer erro crítico bloqueia liberação daquele fluxo até correção e regressão; ausência de erros no conjunto não prova risco zero.
Critério de conclusão de fase: funcionalidade demonstrável, testes relevantes passando, migrations reversíveis ou plano de recuperação, autorização negativa testada e documentação de limitações. Tela bonita com API simulada não é entrega funcional; mocks devem estar explicitamente rotulados e bloqueados em produção.
24. Roadmap por dependência, impacto e esforço
Estimativas abaixo são faixas orientativas para equipe experiente, revisadas após discovery. Claude Code acelera implementação, mas não substitui revisão de segurança, clínica e institucional.
Fase	Entrega	Impacto/esforço	Faixa indicativa e gate
0	Mapa de processos, contratos, desenho de telas, dados sintéticos e decisões de governança	Alto/baixo-médio	1–2 semanas; registro oficial e escopos definidos
1	Identidade, tenant, hospital/serviço, permissões, censo, nota manual, tarefas, auditoria	Muito alto/alto	3–5 semanas; isolamento e backup aprovados
2	Escala recorrente, trocas, passagem e produção/financeiro básico	Alto/médio-alto	2–4 semanas; recorrência e cálculos validados
3	Ditado e OCR com revisão e rastreabilidade	Alto/alto	2–4 semanas; benchmark e contratos de prestadores aprovados
4	Piloto supervisionado em um hospital/serviço	Muito alto/médio	2–4 semanas; medir tempos, omissões e retrabalho
5	Protocolos aprovados e apoio contextual habilitado gradualmente	Alto/alto	Prazo depende de conteúdo, validação e enquadramento regulatório
6	Integrações hospitalares, expansão e eventual nativo/offline	Variável/alto	Orçamento por integração e requisito real


As faixas não incluem eventuais prazos regulatórios e contratação. Multi-tenancy existe na fase 1 mesmo com um único piloto. Voz e OCR entram no primeiro ciclo completo do produto, após o núcleo confiável. Não esperar integrar todos os hospitais para testar o fluxo, nem levar dados reais a um protótipo sem controles.
25. Custos e dimensionamento
Não há cotação de infraestrutura ou APIs nesta especificação. Elaborar planilha de cenários com entradas: hospitais, médicos ativos, pacientes-dia, minutos ditados por visita, páginas/fotos por visita, chamadas de estruturação, tamanho de contexto, retenção e volume de exportações.
custo mensal = infraestrutura fixa + minutos × tarifa_STT + páginas × tarifa_OCR + tokens_entrada × tarifa_entrada + tokens_saida × tarifa_saida + armazenamento + tráfego + observabilidade + suporte.
Exemplo de volume, não de preço: 30 pacientes/dia × 30 dias × 3 minutos = 2.700 minutos/mês; duas imagens por paciente-dia = 1.800 imagens/mês. Reprocessamentos e internações mais complexas ampliam uso. Medir custo por visita aceita, incluindo retrabalho e revisão, não apenas custo da primeira resposta.
Otimizações: templates determinísticos, resumo incremental com referências, cache por versão dentro do tenant, deduplicação de arquivos autorizados e modelo menor apenas quando não comprometer validação. Nunca economizar apagando auditoria ou reduzindo revisão de campos críticos.
26. Principais riscos e respostas
Risco	Efeito	Resposta de projeto
Vazamento entre instituições	Violação de sigilo em grande escala	Escopo explícito, RLS, chaves compostas e testes negativos em todas as superfícies
Documento de paciente errado	Conduta baseada em dado incorreto	Dois identificadores, quarentena e confirmação
Alucinação/omissão de IA	Registro clínico falso ou incompleto	Evidência por campo, revisão, benchmarks e desligamento por recurso
Duplicação com prontuário hospitalar	Planos divergentes e retrabalho	Fonte da verdade e confirmação de incorporação
Copiar nota antiga	Achados não examinados parecem atuais	Marcação de conteúdo herdado e reconfirmação
Excesso de alertas	Ignorar pendências relevantes	Prioridade, deduplicação e métricas de utilidade
Escala confundida com assistência	Cobertura aparente sem execução	Planejado, confirmado e realizado separados
Cobrança repetida	Conflito financeiro	Idempotência, elegibilidade e fechamento imutável
Sugestão clínica sem validação	Risco assistencial e regulatório	Conteúdo aprovado, feature flags e avaliação de finalidade
Wi-Fi/dispositivo falha	Perda de registro	Estado de salvamento claro, contingência e reconciliação
Expansão prematura	Sistema amplo e pouco confiável	Piloto único, gates e módulos com limites claros


27. Prompt de início para o Claude Code
Copiar o bloco abaixo para o Claude Code e disponibilizar este arquivo no repositório. Ele descreve trabalho de implementação, não autorização para implantar dados reais ou emitir condutas médicas.
Você vai implementar a plataforma descrita em ESPECIFICACAO_APP_VISITA_HOSPITALAR_CLAUDE_CODE.md.

Leia o documento inteiro antes de propor a estrutura. Trate-o como contrato de produto, segurança e domínio. Inspecione o repositório existente antes de modificar. Respeite AGENTS.md e convenções presentes. Não crie agentes autônomos clínicos.

Comece pela fase 0 e pelo núcleo da fase 1. Entregue fatias funcionais de ponta a ponta, preservando o roadmap completo em backlog rastreável. Não gere apenas telas com dados fake. Fixtures são permitidas no modo demo, explicitamente sinalizado; produção deve rejeitar provedores mock.

Primeira entrega:
1. Registre ADRs: fronteira tenant/hospital/serviço, fonte da verdade, autorização, finalização de nota, fila/outbox e precisão financeira.
2. Gere backlog com IDs e critérios de aceite ligados às seções deste documento.
3. Configure TypeScript, lint, checagem de tipos, testes, migrations e CI com versões estáveis verificadas e lockfile.
4. Implemente autenticação por adaptador OIDC, papéis por escopo e banco PostgreSQL com RLS. Não escreva seu próprio sistema de senhas.
5. Crie dois tenants sintéticos, pelo menos três serviços, coordenador com múltiplos vínculos, assistente restrito, secretária e financeiro. Inclua tentativas negadas entre escopos.
6. Entregue fluxo real de censo → abrir paciente → nota manual → salvar rascunho → revisão → finalizar → tarefa → passagem/aceite. Finalização imutável e concorrência com conflito explícito.
7. Prove isolamento por testes de API, SQL, arquivos e jobs; não utilize conexão que contorne RLS nos caminhos de usuário.
8. Documente como executar, migrar, restaurar e testar. Use .env.example sem segredos reais.

Nas entregas seguintes implemente escala RFC 5545, produção/cobrança/repasse e voz/OCR com revisão, conforme dependências. Use adaptadores para prestadores; não invente endpoints, recursos, modelos, preços ou garantias de privacidade. Registre pendências que dependem de contratos e credenciais.

Regras inegociáveis:
- Identidade global não concede acesso clínico. Tenant/hospital/serviço são validados no servidor.
- Não preencher informação clínica ausente nem copiar exame físico antigo como atual.
- IA só propõe; médico confirma. Nada de finalizar, prescrever, pagar ou compartilhar automaticamente.
- Protocolos clínicos de exemplo permanecem rascunhos não publicados até aprovação médica.
- Dados clínicos não entram em logs, analytics, replays, notificações ou fixtures públicas.
- Dinheiro em centavos/decimal; regras versionadas; competência fechada não é reescrita.
- Interface pt-BR, datas locais, timezone IANA; timestamps persistidos de forma consistente.
- Não afirmar conformidade legal, assinatura qualificada ou certificação apenas por implementar telas.

Ao fim de cada fatia, informe arquivos alterados, comportamento disponível, testes executados, limitações e próxima dependência. Não faça deploy público com dados reais. Execute as verificações necessárias e não declare concluído o que depende de implementação simulada.
28. Checklist para liberação do piloto real
1. Hospital e direção técnica aprovam finalidade, captura/importação e relação com prontuário oficial.
2. Responsabilidades sobre dados, contratos de prestadores e bases legais documentadas.
3. Matriz de acesso conferida com cenários reais; isolamento entre tenants/hospitais comprovado.
4. Registro médico final e requisitos de assinatura definidos; exportação/incorporação testadas.
5. Backup restaurado; runbooks, contingência e responsáveis de suporte conhecidos.
6. Fluxo manual estável; escala e financeiro conciliados em dados sintéticos.
7. IA avaliada no português e documentos locais; funções não aprovadas continuam desligadas.
8. Informação ao paciente, possibilidade de fluxo sem IA e registro de uso implementados conforme aplicabilidade.
9. Avaliação regulatória do apoio à decisão concluída antes de liberá-lo.
10. Piloto pequeno, com revisão diária inicial e canal de incidente; expansão condicionada a resultados.
29. Referências consultadas
URLs de fontes primárias consultadas em 28/09/2026. Revalidar normas, retificações e documentação na implantação. Não foi realizada auditoria de conformidade nem validação de protocolos clínicos por doença.
- R1 — AHRQ, ferramenta I-PASS. Base de comunicação estruturada, não prova de eficácia deste produto.
- R2 — RFC 5545, iCalendar. Recorrência e exceções.
- R3 — PostgreSQL, Row Security Policies. Políticas por linha e limitações de papéis privilegiados.
- R4 — OWASP, Multi-Tenant Security. Referência de isolamento e autorização.
- R5 — HL7 FHIR R4, DiagnosticReport. Estrutura de laudos.
- R6 — HL7 FHIR R4, Provenance. Rastreabilidade de origem.
- R7 — AWS, idiomas e recursos do Amazon Transcribe. Suporte de idioma não é validação clínica.
- R8 — Microsoft, Azure Document Intelligence. OCR e estrutura de documentos.
- R9 — Next.js, autenticação e autorização. Autorização em operações do servidor.
- R10 — LGPD, Lei 13.709/2018, texto compilado.
- R11 — Lei 13.787/2018. Digitalização e guarda de prontuários.
- R12 — CFM, entrada em vigor das regras de IA.
- R13 — Resolução CFM 2.454/2026, PDF oficial. Conferir versão consolidada e retificações antes da implantação.
- R14 — Anvisa, perguntas e respostas sobre RDC 657/2022.
- R15 — Anvisa, temas regulatórios preliminares 2026–2027. Agenda não equivale a norma publicada.
- R16 — ANPD, transferências internacionais.
- R17 — ANPD, regulamentações. Consultar regras aplicáveis de incidentes e proteção de dados.
30. Questões para a primeira reunião de implantação
Confirmar hospital e prontuário utilizado; número inicial de pacientes/dia e médicos; forma atual de passagem; quem solicita interconsulta; duração/horários das coberturas; se haverá residentes; contratos de cobrança e repasse; assinatura exigida; captura autorizada; conectividade e aparelhos; quem aprova protocolos e quem responde por incidentes.
Estas respostas refinam configurações e planejamento. Não devem alterar os princípios de isolamento, proveniência, revisão humana, continuidade e rastreabilidade financeira definidos aqui.
