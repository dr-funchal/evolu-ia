import { NOTE_SECTIONS, type NoteContent } from "@evolu/contracts";
import { FIELD_STATE_LABELS, SECTION_LABELS } from "@evolu/domain";
import { z } from "zod";

/**
 * Instruções e formatos de resposta dos recursos de IA (ADR 0014). Regra comum a todos: a IA só
 * organiza o que foi dito/escrito; nunca completa informação ausente, nunca inventa valores e nunca
 * trata dado antigo como atual. Nome do paciente não é enviado.
 */

const BASE = [
  "Você apoia médicos em visitas hospitalares (interconsulta e acompanhamento). Escreva em português do Brasil.",
  "Use apenas o que está no material fornecido. Nunca invente, suponha ou complete dados ausentes (doses, valores, datas, exames, diagnósticos).",
  "Se algo não foi mencionado, deixe de fora. Não copie resultados antigos como se fossem atuais.",
  "Seja conciso: frases curtas, estilo nota clínica, abreviações médicas usuais são aceitas.",
].join("\n");

// Aceita lista de textos com tolerância: descarta vazios, corta tamanho e quantidade.
const Bullets = z
  .array(z.unknown())
  .catch([])
  .transform((a) =>
    a
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim().slice(0, 1000))
      .filter(Boolean)
      .slice(0, 30),
  )
  .default([]);

const Certainty = z.enum(["hipotese", "diferencial", "confirmado"]).catch("hipotese");

// ---------------------------------------------------------------------------------------------
// 1 e 2 — Ditado e escriba ambiente: notas clínicas de leitura rápida (não é SOAP).
// ---------------------------------------------------------------------------------------------
export const ScribeOutput = z.object({
  pontos: Bullets,
  antecedentes: Bullets,
  exames: Bullets,
  pendencias_condutas: Bullets,
  hipoteses: z
    .array(z.object({ descricao: z.string().trim().min(1).max(500), certeza: Certainty }))
    .catch([])
    .default([])
    .transform((a) => a.slice(0, 10)),
});
export type ScribeOutput = z.infer<typeof ScribeOutput>;

export function scribeMessages(transcript: string, mode: "ditado" | "conversa") {
  const source =
    mode === "conversa"
      ? "O texto é a transcrição de uma conversa entre médico, paciente e/ou familiares (vozes não identificadas). Extraia só o que for clinicamente relevante; ignore conversa social."
      : "O texto é um ditado do médico após a visita.";
  return [
    {
      role: "system" as const,
      content: `${BASE}
${source}
Organize em notas clínicas para leitura rápida — NÃO use formato SOAP. Responda somente JSON:
{"pontos":[...],"antecedentes":[...],"exames":[...],"pendencias_condutas":[...],"hipoteses":[{"descricao":"...","certeza":"hipotese|diferencial|confirmado"}]}
- pontos: pontos importantes do dia (queixas, intercorrências, achados de exame físico, evolução).
- antecedentes: antecedentes relevantes mencionados (comorbidades, cirurgias, alergias, medicações de uso contínuo).
- exames: exames relevantes com valor/data quando ditos (nunca complete valores).
- pendencias_condutas: condutas decididas e pendências (o que falta fazer, pedir, checar).
- hipoteses: hipóteses diagnósticas; "confirmado" só se foi dito explicitamente que está confirmado.
Cada item é uma linha curta. Lista vazia quando o assunto não apareceu.`,
    },
    { role: "user" as const, content: transcript },
  ];
}

// ---------------------------------------------------------------------------------------------
// 3 — Leitura de foto/PDF (OCR): classifica e sugere onde guardar.
// ---------------------------------------------------------------------------------------------
export const ExtractionOutput = z.object({
  legivel: z.boolean().catch(true).default(true),
  category: z.enum(["laboratorio", "imagem", "laudo", "medicacoes", "relatorio_externo", "outro"]).catch("outro"),
  target: z.enum(["resultados_revistos", "antecedentes", "contexto", "nenhum"]).catch("resultados_revistos"),
  title: z.string().trim().min(1).catch("Documento").transform((s) => s.slice(0, 200)),
  exam_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .catch(null)
    .default(null),
  summary: z.string().trim().catch("").transform((s) => s.slice(0, 8000)),
  items: z
    .array(
      z.object({
        nome: z.string().trim().min(1).max(200),
        valor: z.string().trim().max(200).catch(""),
        unidade: z.string().trim().max(50).nullable().catch(null).default(null),
        referencia: z.string().trim().max(200).nullable().catch(null).default(null),
        alterado: z.boolean().nullable().catch(null).default(null),
      }),
    )
    .catch([])
    .default([])
    .transform((a) => a.slice(0, 80)),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

export const EXTRACTION_SYSTEM = `${BASE}
Você recebe a foto ou PDF de um documento clínico (exame laboratorial, laudo de imagem, receita/lista de medicações, relatório externo etc.).
Transcreva e classifique. Responda somente JSON:
{"legivel":true,"category":"laboratorio|imagem|laudo|medicacoes|relatorio_externo|outro","target":"resultados_revistos|antecedentes|contexto|nenhum","title":"...","exam_date":"AAAA-MM-DD ou null","summary":"...","items":[{"nome":"...","valor":"...","unidade":"...","referencia":"...","alterado":true}]}
- target: onde a informação deve ficar na evolução. Exames e laudos → resultados_revistos; medicações de uso contínuo e histórico → antecedentes; relatório de outro serviço/motivo → contexto; nada útil → nenhum.
- title: curto (ex.: "Hemograma + bioquímica", "TC de crânio").
- exam_date: data da coleta/realização impressa no documento; null se não houver. Nunca use a data de hoje.
- summary: resumo em linhas curtas, destacando alterações; para laudos, a conclusão/impressão.
- items: valores numéricos de laboratório exatamente como impressos (sem converter unidades). alterado=true só se fora da referência impressa ou marcado no documento; null se não dá para saber.
- Não copie nome, documento ou endereço do paciente para nenhum campo.
- Se ilegível ou não for documento clínico, legivel=false e explique no summary.`;

// ---------------------------------------------------------------------------------------------
// 6 — Relatório da internação (paciente ou cobrança). O cabeçalho é montado pelo sistema.
// ---------------------------------------------------------------------------------------------
export function reportSystem(purpose: "paciente" | "cobranca") {
  if (purpose === "paciente") {
    return `${BASE}
Escreva o corpo de um relatório do acompanhamento durante a internação, para ser entregue ao próprio paciente/família.
Linguagem clara e acessível (explique termos técnicos entre parênteses), tom respeitoso. Texto simples, sem markdown pesado; use títulos em linha própria.
Seções, nesta ordem, omitindo as que não tiverem conteúdo:
Motivo do acompanhamento
Principais problemas e diagnósticos
Exames relevantes
O que foi feito
Situação na última avaliação
Orientações e pendências para seguimento
Não inclua nome, datas de nascimento ou cabeçalho (o sistema adiciona). Não dê orientação que não esteja registrada.`;
  }
  return `${BASE}
Escreva o corpo de um relatório para cobrança/faturamento de honorários de acompanhamento durante a internação (convênio ou particular).
Objetivo e técnico. Texto simples, títulos em linha própria. Seções, omitindo as sem conteúdo:
Justificativa do acompanhamento
Diagnósticos/problemas acompanhados (inclua CID-10 apenas quando o diagnóstico registrado permitir sem dúvida, marcado "(conferir)")
Complexidade e intercorrências
Procedimentos e condutas realizados pela equipe
Não liste as datas de visita (o sistema adiciona a relação). Não inclua nome nem cabeçalho.`;
}

// ---------------------------------------------------------------------------------------------
// 8 — Tarefas sugeridas: nascem 'proposed' e só valem depois de aprovadas pelo médico.
// ---------------------------------------------------------------------------------------------
export const TaskSuggestions = z.object({
  tarefas: z
    .array(
      z.object({
        taskType: z.enum(["agendar_exame", "confirmar_realizacao", "obter_laudo", "revisar_resultado", "contatar", "reavaliar", "documentar", "outro"]).catch("outro"),
        action: z.string().trim().min(3).transform((s) => s.slice(0, 500)),
        completionCriterion: z.string().trim().min(3).transform((s) => s.slice(0, 500)),
        priority: z.enum(["baixa", "normal", "alta", "critica"]).catch("normal"),
        dueInHours: z.number().int().min(1).max(168).nullable().catch(null).default(null),
        problem: z.number().int().min(1).nullable().catch(null).default(null),
      }),
    )
    .catch([])
    .default([]),
});

export function taskSuggestionSystem(max: number) {
  return `${BASE}
A partir do caso, sugira no máximo ${max} tarefas de continuidade que AINDA NÃO existem na lista de tarefas abertas.
Só sugira o que decorre do registrado (pendências, planos, exames sem resultado revisto, reavaliações combinadas). Nada de conduta terapêutica nova.
Responda somente JSON: {"tarefas":[{"taskType":"agendar_exame|confirmar_realizacao|obter_laudo|revisar_resultado|contatar|reavaliar|documentar|outro","action":"verbo no infinitivo, curto","completionCriterion":"como saber que terminou","priority":"baixa|normal|alta|critica","dueInHours":24,"problem":1}]}
problem = número do problema na lista (ou null). dueInHours null se não houver prazo claro. Lista vazia se nada faltar.`;
}

// ---------------------------------------------------------------------------------------------
// 9 — Resumo da coordenação: bem curto, só atenção.
// ---------------------------------------------------------------------------------------------
export const BriefOutput = z.object({
  atencao: z
    .array(z.object({ ref: z.string().trim().regex(/^P\d{1,3}$/), texto: z.string().trim().min(1).transform((s) => s.slice(0, 300)) }))
    .catch([])
    .default([])
    .transform((a) => a.slice(0, 12)),
  geral: Bullets.transform((a) => a.slice(0, 5)),
});

export const BRIEF_SYSTEM = `${BASE}
Você recebe o panorama de um serviço (pacientes identificados só como P1, P2...). Produza um resumo MUITO curto para a coordenação:
apenas pontos relevantes e de atenção (sem evolução do dia, sem repetir o que está em ordem).
Priorize: sem evolução hoje, tarefas atrasadas/bloqueadas/sem responsável, pendências críticas, piora registrada, internação longa sem definição de destino.
Responda somente JSON: {"atencao":[{"ref":"P3","texto":"uma linha"}],"geral":["até 3 linhas sobre o serviço como um todo"]}
Máximo 8 itens em atencao. Se nada exigir atenção, listas vazias.`;

// ---------------------------------------------------------------------------------------------
// 10 — Revisão da evolução antes de finalizar (não bloqueia).
// ---------------------------------------------------------------------------------------------
export const ReviewOutput = z.object({
  issues: z
    .array(
      z.object({
        severity: z.enum(["atencao", "info"]).catch("info"),
        section: z.string().trim().max(40).nullable().catch(null).default(null),
        message: z.string().trim().min(1).transform((s) => s.slice(0, 300)),
      }),
    )
    .catch([])
    .default([])
    .transform((a) => a.slice(0, 8)),
});

export const REVIEW_SYSTEM = `${BASE}
Revise o rascunho de evolução abaixo e aponte, no máximo, 8 problemas objetivos para o médico conferir antes de finalizar:
contradições entre seções, pendência sem conduta/responsável, hipótese sem plano, resultado alterado sem menção na avaliação,
problema listado sem avaliação, informação marcada como herdada que parece desatualizada, erros de digitação que mudem sentido (doses, lateralidade).
Não sugira conteúdo novo nem conduta; só aponte. Não repita avisos de campos vazios (o sistema já faz).
Responda somente JSON: {"issues":[{"severity":"atencao|info","section":"chave da seção ou null","message":"uma linha"}]}. Lista vazia se estiver consistente.`;

// ---------------------------------------------------------------------------------------------
// Texto de uma nota para contexto da IA (só campos com conteúdo).
// ---------------------------------------------------------------------------------------------
export function noteAsText(content: NoteContent, problems: Map<string, string>, maxChars = 3000): string {
  const out: string[] = [];
  for (const s of NOTE_SECTIONS) {
    const f = content.sections[s];
    if ((f.state === "informado" || f.state === "historico") && f.text?.trim()) {
      out.push(`${SECTION_LABELS[s]}${f.state === "historico" ? ` (${FIELD_STATE_LABELS.historico})` : ""}: ${f.text.trim()}`);
    }
  }
  for (const p of content.problems) {
    const name = problems.get(p.problemId) ?? "Problema";
    const parts = [p.avaliacao, p.plano].map((f, i) =>
      (f.state === "informado" || f.state === "historico") && f.text?.trim() ? `${i === 0 ? "avaliação" : "plano"}: ${f.text.trim()}` : null,
    );
    if (parts.some(Boolean)) out.push(`[${name}] ${parts.filter(Boolean).join(" | ")}`);
  }
  const text = out.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Rascunho completo para revisão (inclui o estado de cada campo, com a chave da seção). */
export function draftForReview(content: NoteContent, problems: Map<string, string>): string {
  const out: string[] = [];
  for (const s of NOTE_SECTIONS) {
    const f = content.sections[s];
    out.push(`[${s}] ${SECTION_LABELS[s]} (${FIELD_STATE_LABELS[f.state]}): ${f.text?.trim() || "—"}`);
  }
  for (const p of content.problems) {
    out.push(`Problema "${problems.get(p.problemId) ?? "?"}": avaliação (${FIELD_STATE_LABELS[p.avaliacao.state]}): ${p.avaliacao.text?.trim() || "—"}; plano (${FIELD_STATE_LABELS[p.plano.state]}): ${p.plano.text?.trim() || "—"}`);
  }
  return out.join("\n").slice(0, 20000);
}
