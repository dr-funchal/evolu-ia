import { createHash } from "node:crypto";
import type { Sql } from "./client";

/**
 * Dados EXCLUSIVAMENTE sintéticos para desenvolvimento, testes e demonstração.
 * Nomes são fictícios e marcados "(sintético)". Recusa execução em production.
 */

export const MOCK_ISSUER = "urn:evolu:mock";

/** UUID determinístico (formato v4 válido) a partir de um rótulo, para fixtures reprodutíveis. */
export function sid(label: string): string {
  const h = createHash("sha256").update(`evolu-fixture:${label}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const FX = {
  tenantA: sid("tenant:aurora"),
  tenantB: sid("tenant:boreal"),
  hospA1: sid("hosp:aurora-centro"),
  hospA2: sid("hosp:aurora-norte"),
  hospB1: sid("hosp:boreal-sul"),
  neuroA1: sid("svc:neuro-a1"),
  clinA1: sid("svc:clin-a1"),
  cardioA1: sid("svc:cardio-a1"),
  neuroA2: sid("svc:neuro-a2"),
  neuroB1: sid("svc:neuro-b1"),
  users: {
    bruno: sid("user:bruno"),
    ana: sid("user:ana"),
    carla: sid("user:carla"),
    fabio: sid("user:fabio"),
    diana: sid("user:diana"),
    eduardo: sid("user:eduardo"),
    gabriela: sid("user:gabriela"),
    rafael: sid("user:rafael"),
  },
  // Episódios de acompanhamento (um por paciente sintético).
  ep: {
    neuroA1_1: sid("ep:neuro-a1-1"),
    neuroA1_2: sid("ep:neuro-a1-2"),
    neuroA1_3: sid("ep:neuro-a1-3"),
    clinA1_1: sid("ep:clin-a1-1"),
    cardioA1_1: sid("ep:cardio-a1-1"),
    neuroA2_1: sid("ep:neuro-a2-1"),
    neuroB1_1: sid("ep:neuro-b1-1"),
    neuroB1_2: sid("ep:neuro-b1-2"),
  },
} as const;

export type FixtureUser = keyof typeof FX.users;

const USERS: { key: FixtureUser; name: string; email: string }[] = [
  { key: "bruno", name: "Dr. Bruno Teixeira (sintético)", email: "bruno@exemplo.invalid" },
  { key: "ana", name: "Dra. Ana Moraes (sintético)", email: "ana@exemplo.invalid" },
  { key: "carla", name: "Carla Nunes — secretária (sintético)", email: "carla@exemplo.invalid" },
  { key: "fabio", name: "Fábio Lima — financeiro (sintético)", email: "fabio@exemplo.invalid" },
  { key: "diana", name: "Dra. Diana Prado (sintético)", email: "diana@exemplo.invalid" },
  { key: "eduardo", name: "Dr. Eduardo Rocha (sintético)", email: "eduardo@exemplo.invalid" },
  { key: "gabriela", name: "Gabriela Souza — admin (sintético)", email: "gabriela@exemplo.invalid" },
  { key: "rafael", name: "Dr. Rafael Costa — residente (sintético)", email: "rafael@exemplo.invalid" },
];

type Grant = { user: FixtureUser; tenant: string; role: string; hospital?: string; service?: string };
const GRANTS: Grant[] = [
  // Coordenador com múltiplos vínculos: dois serviços no hospital A1, um no A2 e assistente no tenant B.
  { user: "bruno", tenant: FX.tenantA, role: "clinical_coordinator", hospital: FX.hospA1, service: FX.neuroA1 },
  { user: "bruno", tenant: FX.tenantA, role: "clinical_coordinator", hospital: FX.hospA1, service: FX.clinA1 },
  { user: "bruno", tenant: FX.tenantA, role: "clinical_coordinator", hospital: FX.hospA2, service: FX.neuroA2 },
  { user: "bruno", tenant: FX.tenantB, role: "attending_physician", hospital: FX.hospB1, service: FX.neuroB1 },
  // Assistente restrita a um serviço.
  { user: "ana", tenant: FX.tenantA, role: "attending_physician", hospital: FX.hospA1, service: FX.neuroA1 },
  // Secretária em dois serviços.
  { user: "carla", tenant: FX.tenantA, role: "secretary", hospital: FX.hospA1, service: FX.neuroA1 },
  { user: "carla", tenant: FX.tenantA, role: "secretary", hospital: FX.hospA1, service: FX.clinA1 },
  // Financeiro no tenant inteiro (sem acesso clínico).
  { user: "fabio", tenant: FX.tenantA, role: "finance" },
  { user: "diana", tenant: FX.tenantA, role: "attending_physician", hospital: FX.hospA1, service: FX.cardioA1 },
  { user: "eduardo", tenant: FX.tenantB, role: "clinical_coordinator", hospital: FX.hospB1, service: FX.neuroB1 },
  // Administradora do tenant: organização, sem leitura clínica.
  { user: "gabriela", tenant: FX.tenantA, role: "tenant_admin" },
  { user: "rafael", tenant: FX.tenantA, role: "resident", hospital: FX.hospA1, service: FX.neuroA1 },
];

type Pt = {
  ep: string;
  tenant: string;
  hospital: string;
  service: string;
  name: string;
  birth: string;
  sex: "feminino" | "masculino";
  mrn: string;
  bed: string;
  daysAgo: number;
  reason: string;
  problems: { d: string; c: "hipotese" | "diferencial" | "confirmado" }[];
};

const PATIENTS: Pt[] = [
  {
    ep: FX.ep.neuroA1_1, tenant: FX.tenantA, hospital: FX.hospA1, service: FX.neuroA1,
    name: "Paciente Sintético Alfa", birth: "1958-03-14", sex: "feminino", mrn: "SINT-A-0001", bed: "UTI-2 leito 04", daysAgo: 3,
    reason: "Avaliação de déficit motor súbito à direita (caso sintético).",
    problems: [{ d: "AVC isquêmico em investigação (sintético)", c: "hipotese" }],
  },
  {
    ep: FX.ep.neuroA1_2, tenant: FX.tenantA, hospital: FX.hospA1, service: FX.neuroA1,
    name: "Paciente Sintético Bravo", birth: "1971-11-02", sex: "masculino", mrn: "SINT-A-0002", bed: "Enfermaria 3 leito 12", daysAgo: 1,
    reason: "Crise epiléptica em paciente internado por pneumonia (caso sintético).",
    problems: [{ d: "Crise epiléptica — etiologia a definir (sintético)", c: "diferencial" }],
  },
  {
    ep: FX.ep.neuroA1_3, tenant: FX.tenantA, hospital: FX.hospA1, service: FX.neuroA1,
    name: "Paciente Sintético Charlie", birth: "1985-06-21", sex: "feminino", mrn: "SINT-A-0003", bed: "Enfermaria 5 leito 02", daysAgo: 6,
    reason: "Cefaleia com sinais de alarme (caso sintético).",
    problems: [{ d: "Cefaleia secundária em investigação (sintético)", c: "hipotese" }],
  },
  {
    ep: FX.ep.clinA1_1, tenant: FX.tenantA, hospital: FX.hospA1, service: FX.clinA1,
    name: "Paciente Sintético Delta", birth: "1949-01-30", sex: "masculino", mrn: "SINT-A-0004", bed: "Enfermaria 1 leito 07", daysAgo: 2,
    reason: "Hiponatremia em acompanhamento (caso sintético).",
    problems: [{ d: "Hiponatremia (sintético)", c: "confirmado" }],
  },
  {
    ep: FX.ep.cardioA1_1, tenant: FX.tenantA, hospital: FX.hospA1, service: FX.cardioA1,
    name: "Paciente Sintético Eco", birth: "1962-09-09", sex: "feminino", mrn: "SINT-A-0005", bed: "Unidade coronariana leito 01", daysAgo: 4,
    reason: "Fibrilação atrial de início recente (caso sintético).",
    problems: [{ d: "Fibrilação atrial (sintético)", c: "confirmado" }],
  },
  {
    ep: FX.ep.neuroA2_1, tenant: FX.tenantA, hospital: FX.hospA2, service: FX.neuroA2,
    name: "Paciente Sintético Foxtrot", birth: "1990-12-12", sex: "masculino", mrn: "SINT-AN-0001", bed: "Enfermaria 2 leito 03", daysAgo: 2,
    reason: "Parestesias ascendentes (caso sintético).",
    problems: [{ d: "Polirradiculoneuropatia — hipótese (sintético)", c: "hipotese" }],
  },
  {
    ep: FX.ep.neuroB1_1, tenant: FX.tenantB, hospital: FX.hospB1, service: FX.neuroB1,
    name: "Paciente Sintético Golf", birth: "1977-04-04", sex: "feminino", mrn: "SINT-B-0001", bed: "Enfermaria 4 leito 09", daysAgo: 5,
    reason: "Rebaixamento do nível de consciência (caso sintético).",
    problems: [{ d: "Encefalopatia — diferencial amplo (sintético)", c: "diferencial" }],
  },
  {
    ep: FX.ep.neuroB1_2, tenant: FX.tenantB, hospital: FX.hospB1, service: FX.neuroB1,
    name: "Paciente Sintético Hotel", birth: "1966-08-18", sex: "masculino", mrn: "SINT-B-0002", bed: "UTI-1 leito 02", daysAgo: 1,
    reason: "Tremor e rigidez em avaliação (caso sintético).",
    problems: [{ d: "Síndrome parkinsoniana — hipótese (sintético)", c: "hipotese" }],
  },
];

export async function seedSynthetic(sql: Sql, opts: { appMode?: string } = {}): Promise<void> {
  const mode = opts.appMode ?? process.env.APP_MODE ?? "development";
  if (mode === "production") throw new Error("seed sintético recusado em APP_MODE=production");

  await sql.begin(async (tx) => {
    const tenants = [
      { id: FX.tenantA, name: "Rede Hospitalar Aurora (sintético)", slug: "aurora-sintetico" },
      { id: FX.tenantB, name: "Grupo Médico Boreal (sintético)", slug: "boreal-sintetico" },
    ];
    for (const t of tenants) {
      await tx`insert into app.tenants (id, name, slug, timezone, is_synthetic)
               values (${t.id}, ${t.name}, ${t.slug}, 'America/Sao_Paulo', true) on conflict (id) do nothing`;
    }
    const hospitals = [
      { id: FX.hospA1, t: FX.tenantA, name: "Hospital Aurora Centro (sintético)" },
      { id: FX.hospA2, t: FX.tenantA, name: "Hospital Aurora Norte (sintético)" },
      { id: FX.hospB1, t: FX.tenantB, name: "Hospital Boreal Sul (sintético)" },
    ];
    for (const h of hospitals) {
      await tx`insert into app.hospitals (id, tenant_id, name, timezone) values (${h.id}, ${h.t}, ${h.name}, 'America/Sao_Paulo')
               on conflict (id) do nothing`;
    }
    const specs = new Map<string, string>();
    for (const t of [FX.tenantA, FX.tenantB]) {
      for (const s of ["Neurologia", "Clínica Médica", "Cardiologia"]) {
        const id = sid(`spec:${t}:${s}`);
        specs.set(`${t}:${s}`, id);
        await tx`insert into app.specialties (id, tenant_id, name) values (${id}, ${t}, ${s}) on conflict (id) do nothing`;
      }
    }
    const services = [
      { id: FX.neuroA1, t: FX.tenantA, h: FX.hospA1, s: "Neurologia", name: "Neurologia — Aurora Centro" },
      { id: FX.clinA1, t: FX.tenantA, h: FX.hospA1, s: "Clínica Médica", name: "Clínica Médica — Aurora Centro" },
      { id: FX.cardioA1, t: FX.tenantA, h: FX.hospA1, s: "Cardiologia", name: "Cardiologia — Aurora Centro" },
      { id: FX.neuroA2, t: FX.tenantA, h: FX.hospA2, s: "Neurologia", name: "Neurologia — Aurora Norte" },
      { id: FX.neuroB1, t: FX.tenantB, h: FX.hospB1, s: "Neurologia", name: "Neurologia — Boreal Sul" },
    ];
    for (const s of services) {
      await tx`insert into app.services (id, tenant_id, hospital_id, specialty_id, name)
               values (${s.id}, ${s.t}, ${s.h}, ${specs.get(`${s.t}:${s.s}`)!}, ${s.name}) on conflict (id) do nothing`;
    }

    for (const u of USERS) {
      const id = FX.users[u.key];
      await tx`insert into app.users (id, display_name, email, is_synthetic) values (${id}, ${u.name}, ${u.email}, true)
               on conflict (id) do nothing`;
      await tx`insert into app.user_identities (user_id, issuer, subject) values (${id}, ${MOCK_ISSUER}, ${u.key})
               on conflict (issuer, subject) do nothing`;
    }

    for (const g of GRANTS) {
      const uid = FX.users[g.user];
      const mid = sid(`membership:${g.tenant}:${g.user}`);
      await tx`insert into app.memberships (id, tenant_id, user_id) values (${mid}, ${g.tenant}, ${uid})
               on conflict (tenant_id, user_id) do nothing`;
      const gid = sid(`grant:${g.tenant}:${g.user}:${g.role}:${g.service ?? g.hospital ?? "tenant"}`);
      await tx`insert into app.role_grants (id, tenant_id, membership_id, user_id, role, hospital_id, service_id, valid_from)
               values (${gid}, ${g.tenant}, ${mid}, ${uid}, ${g.role}, ${g.hospital ?? null}, ${g.service ?? null}, now() - interval '30 days')
               on conflict (id) do nothing`;
    }

    const creatorFor = (t: string) => (t === FX.tenantA ? FX.users.bruno : FX.users.eduardo);
    for (const p of PATIENTS) {
      const patientId = sid(`patient:${p.ep}`);
      const encId = sid(`enc:${p.ep}`);
      const by = creatorFor(p.tenant);
      const exists = await tx`select 1 from app.service_episodes where id = ${p.ep}`;
      if (exists.length) continue;
      await tx`insert into app.patients (id, tenant_id, full_name, birth_date, sex, created_by)
               values (${patientId}, ${p.tenant}, ${p.name}, ${p.birth}, ${p.sex}, ${by})`;
      await tx`insert into app.patient_identifiers (tenant_id, patient_id, system, value, created_by)
               values (${p.tenant}, ${patientId}, 'prontuario', ${p.mrn}, ${by})`;
      const admitted = new Date(Date.now() - (p.daysAgo + 1) * 86_400_000);
      const started = new Date(Date.now() - p.daysAgo * 86_400_000);
      await tx`insert into app.encounters (id, tenant_id, hospital_id, patient_id, mrn, admitted_at, created_by)
               values (${encId}, ${p.tenant}, ${p.hospital}, ${patientId}, ${p.mrn}, ${admitted}, ${by})`;
      await tx`insert into app.location_history (tenant_id, hospital_id, encounter_id, location_text, from_at, recorded_by)
               values (${p.tenant}, ${p.hospital}, ${encId}, ${p.bed}, ${admitted}, ${by})`;
      await tx`insert into app.service_episodes (id, tenant_id, hospital_id, service_id, encounter_id, status, priority, priority_set_by,
                 requested_at, accepted_at, started_at, created_by)
               values (${p.ep}, ${p.tenant}, ${p.hospital}, ${p.service}, ${encId}, 'active', 'rotina', ${by},
                 ${started}, ${started}, ${started}, ${by})`;
      await tx`insert into app.episode_clinical (tenant_id, service_id, service_episode_id, reason, requester_text, updated_by)
               values (${p.tenant}, ${p.service}, ${p.ep}, ${p.reason}, 'Equipe assistente (sintético)', ${by})`;
      for (const [i, pr] of p.problems.entries()) {
        await tx`insert into app.problems (id, tenant_id, hospital_id, service_id, encounter_id, service_episode_id, description, certainty, created_by)
                 values (${sid(`problem:${p.ep}:${i}`)}, ${p.tenant}, ${p.hospital}, ${p.service}, ${encId}, ${p.ep}, ${pr.d}, ${pr.c}, ${by})`;
      }
    }
  });
}
