/**
 * Matriz de papéis → capacidades (especificação, seção 6).
 *
 * Fonte única: a migration 0002 grava esta mesma tabela em app.role_capabilities, e o teste
 * tests/security/role-matrix.test.ts garante que código e banco não divergem. As políticas RLS
 * consultam o banco; a API consulta o banco via app.has_cap(). Este módulo serve para
 * projeção de campos, interface e testes.
 *
 * Capacidades não são concedidas pelo título: toda concessão tem escopo (tenant, hospital ou
 * serviço) e vigência em app.role_grants.
 */
export const CAPABILITIES = [
  // Cadastro administrativo mínimo: nome, segundo identificador, internação, leito.
  "patient.basic.read",
  "patient.basic.write",
  // Censo: admitir, transferir, encerrar acompanhamento.
  "census.manage",
  // Leitura de conteúdo clínico: motivo, problemas, notas, tarefas clínicas, passagens.
  "clinical.read",
  // Criar/editar rascunhos de evolução, problemas e tarefas.
  "clinical.write",
  // Finalizar a própria evolução (médico autorizado).
  "note.finalize",
  // Adendo a nota finalizada.
  "note.addendum",
  // Enviar/receber passagem de caso.
  "handoff.participate",
  // Enviar documento clínico (entrada restrita para secretária).
  "document.upload",
  // Painel de exceções da coordenação.
  "coordination.view",
  // Organização e vínculos.
  "org.manage",
  // Leitura da trilha de auditoria do tenant.
  "audit.read",
  // Escala.
  "schedule.draft",
  "schedule.publish",
  // Financeiro (fase 2).
  "finance.read",
  "finance.manage",
  // Pendência documental sem conteúdo clínico (visão da secretária).
  "documentation.pending.view",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const ROLES = [
  "tenant_admin",
  "clinical_coordinator",
  "attending_physician",
  "resident",
  "secretary",
  "finance",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  tenant_admin: "Administrador do tenant",
  clinical_coordinator: "Coordenador clínico",
  attending_physician: "Médico assistente",
  resident: "Médico residente",
  secretary: "Secretária",
  finance: "Financeiro",
};

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  // Administra organização; NÃO lê conteúdo clínico (precisa de concessão clínica separada).
  tenant_admin: ["org.manage", "audit.read", "patient.basic.read", "patient.basic.write", "schedule.draft", "schedule.publish"],
  clinical_coordinator: [
    "patient.basic.read",
    "patient.basic.write",
    "census.manage",
    "clinical.read",
    "clinical.write",
    "note.finalize",
    "note.addendum",
    "handoff.participate",
    "document.upload",
    "coordination.view",
    "documentation.pending.view",
    "schedule.draft",
    "schedule.publish",
  ],
  attending_physician: [
    "patient.basic.read",
    "patient.basic.write",
    "census.manage",
    "clinical.read",
    "clinical.write",
    "note.finalize",
    "note.addendum",
    "handoff.participate",
    "document.upload",
    "documentation.pending.view",
  ],
  // Residente: rascunho e solicitação de revisão; não finaliza (coassinatura é configuração futura).
  resident: ["patient.basic.read", "clinical.read", "clinical.write", "handoff.participate", "documentation.pending.view"],
  // Secretária: cadastro mínimo e pendências documentais, sem diagnóstico, evolução ou áudio.
  secretary: ["patient.basic.read", "patient.basic.write", "documentation.pending.view", "document.upload", "schedule.draft"],
  finance: ["finance.read", "finance.manage"],
};

export function roleHas(role: Role, cap: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(cap);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
