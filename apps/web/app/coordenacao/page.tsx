"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useShell } from "@/components/Shell";
import { api } from "@/lib/client";
import { fmtDateTime, label, PRIORITY } from "@/lib/format";

interface Ep {
  episode_id: string;
  full_name: string;
}
interface Data {
  day: string;
  overdueRequests: (Ep & { requested_at: string; due_at: string | null; priority: string | null })[];
  withoutNote: Ep[];
  withoutOwner: Ep[];
  tasks: { id: string; episode_id: string; status: string; due_at: string | null; assignee_name: string | null; unassigned: boolean }[];
  handoffs: { id: string; sent_at: string; status: string; receiver_name: string }[];
  staleDrafts: { id: string; episode_id: string; updated_at: string; author_name: string }[];
}

function Block({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="card">
      <h3>
        {title} <span className={`badge ${count ? "bad" : "ok"}`}>{count}</span>
      </h3>
      {count ? children : <p className="muted small">Nada pendente.</p>}
    </div>
  );
}

export default function Coordenacao() {
  const { service, ctx, setServiceId, can } = useShell();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allowed = service ? can("coordination.view") : false;

  useEffect(() => {
    if (!service || !allowed) return;
    setData(null);
    setError(null);
    api("GET", `/v1/coordination/exceptions?serviceId=${service.id}`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [service, allowed]);

  if (!service) return <p className="muted">Selecione um serviço.</p>;
  if (!allowed) {
    const other = ctx.services.find((s) => s.capabilities.includes("coordination.view"));
    return (
      <div className="alert warn">
        Você não coordena {service.name}.{" "}
        {!other && "Se você coordena em outra instituição, troque-a no seletor do topo."}
        {other && (
          <button className="link" onClick={() => setServiceId(other.id)}>
            Ir para {other.name}
          </button>
        )}
      </div>
    );
  }
  if (error) return <div className="alert bad">{error}</div>;
  if (!data) return <p className="muted">Carregando…</p>;
  const tz = service.timezone;
  const ep = (e: Ep) => <Link href={`/episodios/${e.episode_id}`}>{e.full_name}</Link>;

  return (
    <>
      <h1>Coordenação — {service.name}</h1>
      <p className="muted small">Exceções do dia {data.day.split("-").reverse().join("/")}. Mostra só o que foge do esperado.</p>
      <div className="grid2">
        <Block title="Solicitações atrasadas" count={data.overdueRequests.length}>
          <ul className="small">
            {data.overdueRequests.map((r) => (
              <li key={r.episode_id}>
                {ep(r)} · pedido {fmtDateTime(r.requested_at, tz)}
                {r.priority && r.priority !== "rotina" && <span className="badge bad"> {PRIORITY[r.priority]}</span>}
              </li>
            ))}
          </ul>
        </Block>
        <Block title="Ativos sem evolução finalizada hoje" count={data.withoutNote.length}>
          <ul className="small">{data.withoutNote.map((r) => <li key={r.episode_id}>{ep(r)}</li>)}</ul>
        </Block>
        <Block title="Ativos sem médico responsável" count={data.withoutOwner.length}>
          <ul className="small">{data.withoutOwner.map((r) => <li key={r.episode_id}>{ep(r)}</li>)}</ul>
        </Block>
        <Block title="Tarefas atrasadas, bloqueadas ou sem dono" count={data.tasks.length}>
          <ul className="small">
            {data.tasks.map((t) => (
              <li key={t.id}>
                <Link href={`/episodios/${t.episode_id}`}>{label(t.status)}</Link> · {t.assignee_name ?? "sem responsável"}
                {t.due_at && ` · prazo ${fmtDateTime(t.due_at, tz)}`}
              </li>
            ))}
          </ul>
        </Block>
        {ctx.tenant.modules.handoffs && (
          <Block title="Passagens sem aceite há mais de 1 h" count={data.handoffs.length}>
            <ul className="small">
              {data.handoffs.map((h) => (
                <li key={h.id}>
                  <Link href={`/passagens/${h.id}`}>{fmtDateTime(h.sent_at, tz)}</Link> → {h.receiver_name} ({label(h.status)})
                </li>
              ))}
            </ul>
          </Block>
        )}
        <Block title="Rascunhos parados há mais de 12 h" count={data.staleDrafts.length}>
          <ul className="small">
            {data.staleDrafts.map((n) => (
              <li key={n.id}>
                <Link href={`/episodios/${n.episode_id}`}>{n.author_name}</Link> · última edição {fmtDateTime(n.updated_at, tz)}
              </li>
            ))}
          </ul>
        </Block>
      </div>
    </>
  );
}
