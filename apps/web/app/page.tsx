"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useShell } from "@/components/Shell";
import { api } from "@/lib/client";
import { ageFrom, fmtDateTime, label, PRIORITY } from "@/lib/format";

interface Item {
  episodeId: string;
  status: string;
  priority: string | null;
  location: string | null;
  mrn: string | null;
  patient: { id: string; fullName: string; birthDate: string | null };
  careTeam: { userId: string; displayName: string }[];
  documentation: { hasFinalNoteInPeriod: boolean; hasDraft: boolean } | null;
  clinical: {
    reason: string | null;
    problems: { id: string; description: string; certainty: string }[];
    myDraft: { id: string } | null;
    finalToday: number;
    drafts: number;
    openTasks: number;
    overdueTasks: number;
    lastFinalAt: string | null;
  } | null;
}

export default function PacientesDoDia() {
  const { service, ctx, me, can } = useShell();
  const [data, setData] = useState<{ day: string; items: Item[]; capabilities: Record<string, boolean>; service: { timezone: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"todos" | "meus" | "pendentes">("todos");

  useEffect(() => {
    if (!service) return;
    setData(null);
    api("GET", `/v1/worklist?serviceId=${service.id}`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [service]);

  if (!ctx.services.length)
    return (
      <div className="card">
        <h1>Sem serviço vinculado</h1>
        <p className="muted">Seu vínculo nesta instituição não inclui acesso a um serviço clínico.</p>
        {ctx.tenantCapabilities.includes("org.manage") && (
          <>
            <p>Como administrador, falta só a estrutura:</p>
            <ol>
              <li>cadastre o hospital e o serviço (ex.: “Visita”, “Interconsulta”);</li>
              <li>garanta que você tem um papel clínico que cubra o serviço — médico assistente ou coordenador clínico na “equipe inteira” já vale para todos.</li>
            </ol>
            <p>
              <Link href="/admin" className="button primary">
                Configurar em Administração
              </Link>
            </p>
          </>
        )}
      </div>
    );
  if (error) return <div className="alert bad">{error}</div>;
  if (!service || !data) return <p className="muted">Carregando censo…</p>;

  const caps = data.capabilities;
  const active = data.items.filter((i) => i.status === "active");
  const semEvolucao = active.filter((i) => i.documentation && !i.documentation.hasFinalNoteInPeriod).length;
  const atrasadas = data.items.reduce((n, i) => n + (i.clinical?.overdueTasks ?? 0), 0);
  const rascunhos = data.items.reduce((n, i) => n + (i.clinical?.drafts ?? 0), 0);
  const items = data.items.filter((i) => {
    if (filter === "meus") return i.careTeam.some((c) => c.userId === me.user.id);
    if (filter === "pendentes") return i.documentation && !i.documentation.hasFinalNoteInPeriod && i.status === "active";
    return true;
  });
  const tabs: [typeof filter, string][] = [
    ["todos", `Todos (${data.items.length})`],
    ["meus", "Sob meus cuidados"],
    ["pendentes", `Sem evolução hoje${caps["documentation.pending.view"] ? ` (${semEvolucao})` : ""}`],
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pacientes do dia</h1>
          <div className="muted small">
            {service.name} · {service.hospitalName} · {data.day.split("-").reverse().join("/")}
          </div>
        </div>
        {can("patient.basic.write") && (
          <Link className="button primary" href="/censo/novo">
            + Incluir paciente
          </Link>
        )}
      </div>

      <div className="stats">
        <div className="stat">
          <div className="label">Pacientes</div>
          <div className="value">{data.items.length}</div>
        </div>
        {caps["documentation.pending.view"] && (
          <div className={`stat ${semEvolucao ? "alert-val" : ""}`}>
            <div className="label">Sem evolução hoje</div>
            <div className="value">{semEvolucao}</div>
          </div>
        )}
        {caps["clinical.read"] && (
          <>
            <div className={`stat ${atrasadas ? "alert-val" : ""}`}>
              <div className="label">Tarefas atrasadas</div>
              <div className="value">{atrasadas}</div>
            </div>
            <div className="stat">
              <div className="label">Rascunhos</div>
              <div className="value">{rascunhos}</div>
            </div>
          </>
        )}
      </div>

      <div className="tabs" role="tablist">
        {tabs.map(([k, t]) => (
          <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>
            {t}
          </button>
        ))}
      </div>
      {!caps["clinical.read"] && (
        <div className="alert warn small">Seu papel neste serviço não inclui leitura clínica: você vê só cadastro e pendências.</div>
      )}
      <div className="card">
        {items.length === 0 && <p className="muted">Nenhum paciente neste filtro.</p>}
        {items.map((i) => (
          <div key={i.episodeId} className="patient-row">
            <div>
              <Link className="patient-name" href={`/episodios/${i.episodeId}`}>
                {i.patient.fullName}
              </Link>
              <div className="muted small">
                {i.location ?? "sem leito"} · {ageFrom(i.patient.birthDate)}
                {i.mrn ? ` · pront. ${i.mrn}` : ""}
                {i.careTeam.length ? ` · ${i.careTeam.map((c) => c.displayName).join(", ")}` : ""}
              </div>
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              {i.status !== "active" && <span className={`pill ${i.status === "requested" ? "warn" : "plain"}`}>{label(i.status)}</span>}
              {i.priority && i.priority !== "rotina" && <span className="pill bad">{PRIORITY[i.priority]}</span>}
              {i.documentation &&
                (i.documentation.hasFinalNoteInPeriod ? (
                  <span className="pill ok">evoluído hoje</span>
                ) : i.documentation.hasDraft ? (
                  <span className="pill warn">rascunho</span>
                ) : i.status === "active" ? (
                  <span className="pill bad">sem evolução</span>
                ) : null)}
              {!i.careTeam.length && <span className="pill plain">sem responsável</span>}
            </div>
            {i.clinical && (
              <div className="small" style={{ gridColumn: "1 / -1" }}>
                {i.clinical.reason && <div>{i.clinical.reason}</div>}
                <div className="row muted" style={{ gap: "4px 10px" }}>
                  <span>Última evolução: {fmtDateTime(i.clinical.lastFinalAt, service.timezone)}</span>
                  <span>· {i.clinical.openTasks} tarefa(s)</span>
                  {i.clinical.overdueTasks > 0 && <span className="pill bad">{i.clinical.overdueTasks} atrasada(s)</span>}
                  {i.clinical.myDraft && <Link href={`/notas/${i.clinical.myDraft.id}`}>continuar meu rascunho →</Link>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
