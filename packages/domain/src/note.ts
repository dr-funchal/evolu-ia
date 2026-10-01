import { NOTE_SECTIONS, type NoteContent, type NoteField, type NoteSection, type SimpleNote, type StructuredNote } from "@evolu/contracts";

export const SECTION_LABELS: Record<NoteSection, string> = {
  contexto: "Contexto / motivo",
  antecedentes: "Antecedentes relevantes",
  estado_basal: "Estado basal",
  intercorrencias: "Intercorrências",
  subjetivo: "Subjetivo",
  exame: "Exame",
  resultados_revistos: "Resultados revistos",
  comunicacao: "Comunicação com paciente/família/equipe",
  pendencias: "Pendências",
  destino: "Destino",
};

export const FIELD_STATE_LABELS: Record<NoteField["state"], string> = {
  nao_informado: "não informado",
  nao_avaliado: "não avaliado",
  informado: "informado",
  nao_aplicavel: "não aplicável",
  historico: "histórico (não reconfirmado)",
};

/**
 * Seções que podem ser trazidas da última nota finalizada como "histórico".
 * Exame, subjetivo, intercorrências e resultados NUNCA são copiados: descrevem o dia da visita
 * (especificação 9 e CLI-04: "exame atual permanece não informado").
 */
export const CARRY_FORWARD_SECTIONS: readonly NoteSection[] = ["contexto", "antecedentes", "estado_basal"];

const empty = (): NoteField => ({ state: "nao_informado" });

export function emptyNoteContent(problemIds: string[] = []): StructuredNote {
  return {
    schema: 1,
    sections: Object.fromEntries(NOTE_SECTIONS.map((s) => [s, empty()])) as StructuredNote["sections"],
    problems: problemIds.map((problemId) => ({ problemId, avaliacao: empty(), plano: empty() })),
  };
}

export function prefillFromPrevious(previous: NoteContent, previousVersionId: string, problemIds: string[]): StructuredNote {
  const next = emptyNoteContent(problemIds);
  if (previous.schema !== 1) return next; // evolução simples não tem seções a herdar
  for (const s of CARRY_FORWARD_SECTIONS) {
    const f = previous.sections[s];
    if ((f.state === "informado" || f.state === "historico") && f.text?.trim()) {
      next.sections[s] = { state: "historico", text: f.text, sourceVersionId: f.sourceVersionId ?? previousVersionId };
    }
  }
  return next;
}

export interface FinalizeIssue {
  code: string;
  message: string;
  section?: NoteSection;
}

export interface FinalizeCheck {
  /** Impedem a finalização (identidade, autoria, vínculo, campo institucional indispensável, conteúdo herdado). */
  blocking: FinalizeIssue[];
  /** Permitem finalizar com justificativa registrada. */
  warnings: FinalizeIssue[];
}

/**
 * Checagem determinística antes de finalizar (especificação 8.4). Não interpreta conteúdo clínico:
 * só verifica completude e estados explícitos.
 */
export function checkFinalize(content: NoteContent, attendedAt: Date | null, now: Date = new Date()): FinalizeCheck {
  const blocking: FinalizeIssue[] = [];
  const warnings: FinalizeIssue[] = [];
  if (!attendedAt) {
    blocking.push({ code: "attended_at_missing", message: "Informe a data/hora do atendimento." });
  } else if (attendedAt.getTime() > now.getTime() + 5 * 60_000) {
    blocking.push({ code: "attended_at_future", message: "Horário do atendimento está no futuro." });
  }
  if (content.schema === 2) {
    // Evolução simples: só exige conteúdo. Sem campos obrigatórios por seção.
    if (!content.evolucao.trim() && !content.transcricao.trim()) {
      blocking.push({ code: "empty_note", message: "A evolução está vazia." });
    }
    return { blocking, warnings };
  }
  for (const s of NOTE_SECTIONS) {
    if (content.sections[s].state === "historico") {
      blocking.push({
        code: "historical_not_confirmed",
        section: s,
        message: `${SECTION_LABELS[s]}: conteúdo herdado da nota anterior precisa ser reconfirmado ou removido.`,
      });
    }
  }
  for (const p of content.problems) {
    for (const f of [p.avaliacao, p.plano]) {
      if (f.state === "historico") {
        blocking.push({ code: "historical_not_confirmed", message: "Avaliação/plano herdado precisa ser reconfirmado." });
      }
    }
  }
  const exam = content.sections.exame.state;
  if (exam === "nao_informado" || exam === "nao_avaliado") {
    warnings.push({ code: "exam_not_documented", section: "exame", message: "Exame atual não documentado." });
  }
  const informed = NOTE_SECTIONS.filter((s) => content.sections[s].state === "informado").length;
  if (informed === 0 && !content.problems.some((p) => p.avaliacao.state === "informado" || p.plano.state === "informado")) {
    blocking.push({ code: "empty_note", message: "A evolução não tem nenhum conteúdo informado." });
  }
  if (content.problems.length > 0 && content.problems.every((p) => p.plano.state !== "informado")) {
    warnings.push({ code: "plan_not_documented", message: "Nenhum problema tem plano informado." });
  }
  return { blocking, warnings };
}

/** Texto para exportação da versão finalizada (preparado ≠ incorporado ao prontuário oficial). */
export function renderNoteText(
  content: NoteContent,
  meta: {
    patientName: string;
    authorName: string;
    attendedAt: string;
    recordedAt: string;
    versionNo: number;
    problems: Map<string, string>;
    addenda?: { authorName: string; createdAt: string; reason: string; body: string }[];
  },
): string {
  const lines: string[] = [];
  lines.push(`EVOLUÇÃO — ${meta.patientName}`);
  lines.push(`Atendimento: ${meta.attendedAt} | Registro: ${meta.recordedAt} | Versão ${meta.versionNo}`);
  lines.push(`Autoria técnica: ${meta.authorName} (não constitui assinatura digital qualificada)`);
  lines.push("");
  if (content.schema === 2) {
    lines.push(...simpleNoteLines(content));
    for (const a of meta.addenda ?? []) {
      lines.push(`ADENDO (${a.createdAt}, ${a.authorName}) — motivo: ${a.reason}`, a.body, "");
    }
    return lines.join("\n");
  }
  const fieldText = (f: NoteField) => (f.state === "informado" ? (f.text ?? "") : `[${FIELD_STATE_LABELS[f.state]}]`);
  for (const s of NOTE_SECTIONS) {
    lines.push(`${SECTION_LABELS[s]}:`);
    lines.push(fieldText(content.sections[s]));
    lines.push("");
  }
  if (content.problems.length) {
    lines.push("Avaliação e plano por problema:");
    for (const p of content.problems) {
      lines.push(`- ${meta.problems.get(p.problemId) ?? "Problema"}`);
      lines.push(`  Avaliação: ${fieldText(p.avaliacao)}`);
      lines.push(`  Plano: ${fieldText(p.plano)}`);
    }
    lines.push("");
  }
  for (const a of meta.addenda ?? []) {
    lines.push(`ADENDO (${a.createdAt}, ${a.authorName}) — motivo: ${a.reason}`);
    lines.push(a.body);
    lines.push("");
  }
  return lines.join("\n");
}

/** Texto da evolução simples: destaques e evolução organizada (ou o texto livre, se não organizada). */
export function simpleNoteLines(content: SimpleNote): string[] {
  const lines: string[] = [];
  if (content.destaques.length) {
    lines.push("Destaques:", ...content.destaques.map((d) => `- ${d}`), "");
  }
  const body = content.evolucao.trim() || content.transcricao.trim();
  if (body) lines.push(body, "");
  return lines;
}

export function emptySimpleNote(): SimpleNote {
  return { schema: 2, transcricao: "", evolucao: "", destaques: [] };
}
