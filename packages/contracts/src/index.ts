import { z } from "zod";

/**
 * Contratos de entrada da API (validação no servidor). Identificadores de tenant, paciente e
 * internação vêm da rota/contexto resolvido pelo servidor, nunca de campos livres do cliente.
 */

export const Uuid = z.uuid();
const Text = (max: number) => z.string().trim().min(1).max(max);
const IsoInstant = z.iso.datetime({ offset: true });
const IanaTz = z.string().min(1).max(64).refine((tz) => {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "timezone IANA inválida");

// ---------------------------------------------------------------------------------------------
// Nota clínica. Cada campo tem estado explícito: ausência de informação permanece visível.
// ---------------------------------------------------------------------------------------------
export const FIELD_STATES = ["nao_informado", "nao_avaliado", "informado", "nao_aplicavel", "historico"] as const;
export type FieldState = (typeof FIELD_STATES)[number];

export const NoteField = z
  .object({
    state: z.enum(FIELD_STATES),
    text: z.string().max(20000).optional(),
    /** Para "historico": versão finalizada de onde o texto veio. */
    sourceVersionId: Uuid.optional(),
  })
  .superRefine((f, ctx) => {
    if ((f.state === "informado" || f.state === "historico") && !f.text?.trim()) {
      ctx.addIssue({ code: "custom", message: "texto obrigatório quando o campo está informado" });
    }
    if (f.state === "historico" && !f.sourceVersionId) {
      ctx.addIssue({ code: "custom", message: "conteúdo histórico precisa indicar a versão de origem" });
    }
  });
export type NoteField = z.infer<typeof NoteField>;

export const NOTE_SECTIONS = [
  "contexto",
  "antecedentes",
  "estado_basal",
  "intercorrencias",
  "subjetivo",
  "exame",
  "resultados_revistos",
  "comunicacao",
  "pendencias",
  "destino",
] as const;
export type NoteSection = (typeof NOTE_SECTIONS)[number];

export const NoteProblemEntry = z.object({
  problemId: Uuid,
  avaliacao: NoteField,
  plano: NoteField,
});

export const NoteContent = z.object({
  schema: z.literal(1),
  sections: z.object(Object.fromEntries(NOTE_SECTIONS.map((s) => [s, NoteField])) as Record<NoteSection, typeof NoteField>),
  problems: z.array(NoteProblemEntry).max(50),
});
export type NoteContent = z.infer<typeof NoteContent>;

export const CreateNote = z.object({
  noteType: z.enum(["evolucao", "interconsulta_inicial"]).default("evolucao"),
  /** Traz contexto/antecedentes/estado basal da última nota final como "histórico" (nunca o exame). */
  prefillFromLast: z.boolean().default(false),
});

export const UpdateNote = z.object({
  content: NoteContent,
  attendedAt: IsoInstant.nullable(),
});

export const FinalizeNote = z.object({
  /** Justificativa para avisos não bloqueantes (ex.: exame não informado). */
  warningsJustification: z.string().trim().max(1000).optional(),
});

export const CreateAddendum = z.object({ body: Text(20000), reason: Text(500) });

// ---------------------------------------------------------------------------------------------
// Censo
// ---------------------------------------------------------------------------------------------
export const IDENTIFIER_SYSTEMS = ["prontuario", "cns", "cpf", "nome_mae", "data_nascimento", "outro"] as const;

export const CreateEncounter = z
  .object({
    hospitalId: Uuid,
    serviceId: Uuid,
    patientId: Uuid.optional(),
    patient: z
      .object({
        fullName: Text(200),
        birthDate: z.iso.date().optional(),
        sex: z.enum(["feminino", "masculino", "intersexo", "nao_informado"]).optional(),
        identifiers: z.array(z.object({ system: z.enum(IDENTIFIER_SYSTEMS), value: Text(120) })).max(5).default([]),
      })
      .optional(),
    confirmNotDuplicate: z.boolean().default(false),
    mrn: z.string().trim().max(60).optional(),
    admittedAt: IsoInstant,
    location: z.string().trim().max(120).optional(),
    bedId: Uuid.optional(),
    requestedAt: IsoInstant,
    dueAt: IsoInstant.optional(),
    priority: z.enum(["rotina", "prioritaria", "urgente"]).optional(),
    reason: z.string().trim().max(2000).optional(),
    requesterText: z.string().trim().max(200).optional(),
  })
  .refine((v) => Boolean(v.patientId) !== Boolean(v.patient), "informe patientId OU patient")
  .refine((v) => !v.patient || v.patient.identifiers.length >= 1 || v.patient.birthDate, {
    message: "paciente novo exige um segundo identificador (ex.: data de nascimento ou prontuário)",
  });

export const EpisodeTransition = z.object({
  action: z.enum(["accept", "activate", "close", "cancel"]),
  justification: z.string().trim().max(1000).optional(),
});

export const CreateProblem = z.object({
  description: Text(500),
  certainty: z.enum(["hipotese", "diferencial", "confirmado"]),
});
export const UpdateProblem = z.object({
  description: Text(500).optional(),
  certainty: z.enum(["hipotese", "diferencial", "confirmado"]).optional(),
  status: z.enum(["ativo", "em_investigacao", "resolvido", "suspenso"]).optional(),
  reviewed: z.boolean().optional(),
});

// ---------------------------------------------------------------------------------------------
// Tarefas e passagem
// ---------------------------------------------------------------------------------------------
export const TASK_TYPES = [
  "agendar_exame",
  "confirmar_realizacao",
  "obter_laudo",
  "revisar_resultado",
  "contatar",
  "reavaliar",
  "documentar",
  "outro",
] as const;

export const CreateTask = z
  .object({
    taskType: z.enum(TASK_TYPES),
    action: Text(500),
    completionCriterion: Text(500),
    contingency: z.string().trim().max(500).optional(),
    problemId: Uuid.optional(),
    assigneeUserId: Uuid.nullable().default(null),
    dueAt: IsoInstant.optional(),
    dueTimezone: IanaTz.optional(),
    priority: z.enum(["baixa", "normal", "alta", "critica"]).optional(),
    sourceNoteId: Uuid.optional(),
  })
  .refine((t) => !t.dueAt || t.dueTimezone, { message: "prazo exige timezone IANA", path: ["dueTimezone"] });

export const UpdateTask = z
  .object({
    status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]).optional(),
    statusReason: z.string().trim().max(500).optional(),
    assigneeUserId: Uuid.nullable().optional(),
    dueAt: IsoInstant.nullable().optional(),
    dueTimezone: IanaTz.optional(),
  })
  .refine((t) => !(t.status === "cancelled" || t.status === "blocked") || t.statusReason, {
    message: "cancelar ou bloquear exige motivo",
    path: ["statusReason"],
  });

export const HandoffPatient = z.object({
  episodeId: Uuid,
  /** I-PASS: gravidade atribuída pelo médico, sem cálculo automático. */
  illnessSeverity: z.enum(["estavel", "atencao", "instavel"]),
  summary: Text(2000),
  situationAwareness: z.string().trim().max(2000).optional(),
});

export const CreateHandoff = z.object({
  serviceId: Uuid,
  receiverId: Uuid,
  patients: z.array(HandoffPatient).min(1).max(60),
  taskIds: z.array(Uuid).max(200).default([]),
});

export const AcknowledgeHandoff = z
  .object({ decision: z.enum(["accepted", "questioned"]), questions: z.string().trim().max(2000).optional() })
  .refine((a) => a.decision !== "questioned" || a.questions, { message: "dúvidas exigem texto", path: ["questions"] });

export const SetPersona = z.object({ userId: Uuid.nullable() });

// ---------------------------------------------------------------------------------------------
// Administração do tenant e da plataforma.
// ---------------------------------------------------------------------------------------------
export const ADMIN_ROLES = ["tenant_admin", "clinical_coordinator", "attending_physician", "resident", "secretary", "finance"] as const;
const Email = z.string().trim().toLowerCase().pipe(z.email()).refine((e) => e.length <= 200, "e-mail longo demais");
const PersonName = Text(200);

export const UpdateTenant = z.object({ name: Text(200).optional(), timezone: IanaTz.optional() });
export const CreateHospital = z.object({ name: Text(200), timezone: IanaTz });
export const UpdateHospital = z.object({ name: Text(200).optional(), timezone: IanaTz.optional(), active: z.boolean().optional() });
export const CreateService = z.object({ hospitalId: Uuid, name: Text(200), specialty: Text(120) });
export const UpdateService = z.object({ name: Text(200).optional(), active: z.boolean().optional() });

/** Escopo: tenant inteiro (sem hospital/serviço), hospital, ou serviço (com o hospital dele). */
export const GrantInput = z
  .object({ role: z.enum(ADMIN_ROLES), hospitalId: Uuid.nullable().optional(), serviceId: Uuid.nullable().optional() })
  .refine((g) => !g.serviceId || g.hospitalId, { message: "serviço exige hospital", path: ["hospitalId"] })
  .refine((g) => !(g.role === "tenant_admin" || g.role === "finance") || (!g.hospitalId && !g.serviceId), {
    message: "administração e financeiro valem para a instituição inteira",
    path: ["role"],
  });
export type GrantInput = z.infer<typeof GrantInput>;

export const InviteMember = z.object({ email: Email, name: PersonName, grants: z.array(GrantInput).min(1).max(30) });
export const AddGrant = GrantInput;
export const UpdateMembership = z.object({ status: z.enum(["active", "suspended", "revoked"]) });

export const CreateTenant = z.object({
  name: Text(200),
  timezone: IanaTz,
  /** Primeiro administrador; ausente = o próprio operador da plataforma. */
  admin: z.object({ email: Email, name: PersonName }).nullable().optional(),
});

// ---------------------------------------------------------------------------------------------
// Escala. Datas e horas são locais (fuso do hospital); a RRULE é montada no servidor.
// ---------------------------------------------------------------------------------------------
export const MODALITIES = ["visita", "retaguarda", "plantao"] as const;
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data AAAA-MM-DD");
const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "hora HH:MM");
const LocalDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, "AAAA-MM-DDTHH:MM");

export const Repeat = z.discriminatedUnion("freq", [
  z.object({ freq: z.literal("none") }),
  z.object({ freq: z.literal("daily"), interval: z.number().int().min(1).max(30) }),
  z.object({
    freq: z.literal("weekly"),
    interval: z.number().int().min(1).max(8),
    byDay: z.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])).min(1).max(7),
  }),
]);
export type Repeat = z.infer<typeof Repeat>;

export const ScheduleSeriesInput = z
  .object({
    serviceId: Uuid,
    modality: z.enum(MODALITIES),
    assigneeUserId: Uuid,
    startDate: LocalDate,
    startTime: LocalTime,
    durationMinutes: z.number().int().min(15).max(2880),
    repeat: Repeat,
    untilDate: LocalDate.nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine((s) => !s.untilDate || s.untilDate >= s.startDate, { message: "término antes do início", path: ["untilDate"] });
export type ScheduleSeriesInput = z.infer<typeof ScheduleSeriesInput>;

/** "Esta e as próximas": a série original termina na véspera de `fromDate`; a nova começa nela. */
export const SplitSeries = z.object({ fromDate: LocalDate, changes: ScheduleSeriesInput });
export const EndSeries = z.object({ lastDate: LocalDate });

export const ScheduleException = z
  .object({
    originalStart: LocalDateTime,
    kind: z.enum(["cancelled", "reassigned", "none"]),
    assigneeUserId: Uuid.nullable().optional(),
    reason: z.string().trim().max(300).nullable().optional(),
  })
  .refine((e) => (e.kind === "reassigned") === Boolean(e.assigneeUserId), { message: "troca exige profissional", path: ["assigneeUserId"] });
