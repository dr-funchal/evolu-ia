import type { Tx } from "@evolu/database";
import { notFound } from "./http";

export interface EpisodeScope {
  id: string;
  tenant_id: string;
  hospital_id: string;
  service_id: string;
  encounter_id: string;
  patient_id: string;
  status: string;
  version: number;
}

/**
 * Carrega o acompanhamento visível ao usuário (RLS: patient.basic.read no serviço). Inexistente e
 * fora de escopo produzem o mesmo 404 — não revelamos a existência de registros de outro escopo.
 */
export async function loadEpisode(tx: Tx, id: string): Promise<EpisodeScope> {
  const [e] = await tx<EpisodeScope[]>`
    select e.id, e.tenant_id, e.hospital_id, e.service_id, e.encounter_id, en.patient_id, e.status, e.version
    from app.service_episodes e
    join app.encounters en on en.tenant_id = e.tenant_id and en.id = e.encounter_id
    where e.id = ${id}`;
  if (!e) throw notFound();
  return e;
}

export async function hospitalTimezone(tx: Tx, hospitalId: string): Promise<string> {
  const [h] = await tx<{ timezone: string }[]>`select timezone from app.hospitals where id = ${hospitalId}`;
  return h?.timezone ?? "America/Sao_Paulo";
}
