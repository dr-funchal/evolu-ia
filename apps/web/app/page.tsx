"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useShell } from "@/components/Shell";
import { api } from "@/lib/client";
import { ageFrom, CERTAINTY, fmtDateTime, label, PRIORITY } from "@/lib/format";

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

export default function MeuDia() {
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
          <p>
            Como administrador, cadastre hospitais e serviços e atribua a si mesmo um papel clínico (por exemplo, médico assistente ou
            coordenador) em <Link href="/admin">Administração</Link>.
          </p>
        )}
      </div>
    );
  if (error) return <div className="alert bad">{error}</div>;
  if (!service || !data) return <p className="muted">Carregando censo…</p>;

  const caps = data.capabilities;
  const items = data.items.filter((i) => {
    if (filter === "meus") return i.careTeam.some((c) => c.userId === me.user.id);
    if (filter === "pendentes") return i.documentation && !i.documentation.hasFinalNoteInPeriod && i.status === "active";
    return true;
  });
  const pendentes = data.items.filter((i) => i.status === "active" && i.documentation && !i.documentation.hasFinalNoteInPeriod).length;

  return (
    <>
      <div className="row between">
        <div>
          <h1>Meu dia — {service.name}</h1>
          <p className="muted small">
            {service.hospitalName} · dia {data.day.split("-").reverse().join("/")} ({data.service.timezone}) · {data.items.length} {data.items.length === 1 ? "paciente" : "pacientes"}
            {caps["documentation.pending.view"] ? ` · ${pendentes} sem evolução finalizada hoje` : ""}
          </p>
        </div>
        <div className="row">
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Filtro">
            <option value="todos">Todos</option>
            <option value="meus">Sob meus cuidados</option>
            <option value="pendentes">Sem evolução hoje</option>
          </select>
          {can("patient.basic.write") && (
            <Link className="button primary" href="/censo/novo">
              Incluir paciente
            </Link>
          )}
        </div>
      </div>
      {!caps["clinical.read"] && (
        <div className="alert warn small">Seu papel neste serviço não inclui leitura clínica: você vê só cadastro e pendências.</div>
      )}
      {items.length === 0 && <div className="card muted">Nenhum paciente neste filtro.</div>}
      {items.map((i) => (
        <div key={i.episodeId} className="card">
          <div className="patient">
            <div>
              <Link className="name" href={`/episodios/${i.episodeId}`}>
                {i.patient.fullName}
              </Link>{" "}
              <span className="muted small">
                {ageFrom(i.patient.birthDate)} · {i.location ?? "sem leito"} {i.mrn ? `· pront. ${i.mrn}` : ""}
              </span>
            </div>
            <div className="row">
              <span className={`badge ${i.status === "requested" ? "warn" : "plain"}`}>{label(i.status)}</span>
              {i.priority && i.priority !== "rotina" && <span className="badge bad">{PRIORITY[i.priority]}</span>}
              {i.documentation &&
                (i.documentation.hasFinalNoteInPeriod ? (
                  <span className="badge ok">evolução de hoje finalizada</span>
                ) : i.documentation.hasDraft ? (
                  <span className="badge warn">rascunho pendente</span>
                ) : i.status === "active" ? (
                  <span className="badge bad">sem evolução hoje</span>
                ) : null)}
            </div>
            {i.clinical && (
              <div className="small" style={{ gridColumn: "1 / -1" }}>
                {i.clinical.reason && <div className="muted">{i.clinical.reason}</div>}
                {i.clinical.problems.length > 0 && (
                  <div>
                    {i.clinical.problems.map((p) => (
                      <span key={p.id} className="badge plain" style={{ marginRight: 4 }}>
                        {p.description} ({CERTAINTY[p.certainty] ?? p.certainty})
                      </span>
                    ))}
                  </div>
                )}
                <div className="row muted" style={{ marginTop: 4 }}>
                  <span>Última evolução: {fmtDateTime(i.clinical.lastFinalAt, service.timezone)}</span>
                  <span>· tarefas abertas: {i.clinical.openTasks}</span>
                  {i.clinical.overdueTasks > 0 && <span className="badge bad">{i.clinical.overdueTasks} atrasada(s)</span>}
                  {i.clinical.myDraft && <Link href={`/notas/${i.clinical.myDraft.id}`}>continuar meu rascunho</Link>}
                </div>
              </div>
            )}
            <div className="small muted" style={{ gridColumn: "1 / -1" }}>
              Equipe: {i.careTeam.length ? i.careTeam.map((c) => c.displayName).join(", ") : <span className="badge warn">sem responsável</span>}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
