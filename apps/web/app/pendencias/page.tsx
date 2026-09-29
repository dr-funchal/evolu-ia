"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useShell } from "@/components/Shell";
import { api } from "@/lib/client";

interface Row {
  episode_id: string;
  full_name: string;
  location: string | null;
  has_final_note_in_period: boolean;
  has_draft: boolean;
}

/** Pendência documental sem conteúdo clínico: serve à secretária e à coordenação. */
export default function Pendencias() {
  const { service, can } = useShell();
  const allowed = service ? can("documentation.pending.view") : false;
  const [data, setData] = useState<{ day: string; timezone: string; items: Row[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!service || !allowed) return;
    setData(null);
    api("GET", `/v1/documentation/pending?serviceId=${service.id}`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [service, allowed]);

  if (!service) return <p className="muted">Selecione um serviço.</p>;
  if (!can("documentation.pending.view")) return <div className="alert warn">Seu papel neste serviço não inclui a visão de pendências.</div>;
  if (error) return <div className="alert bad">{error}</div>;
  if (!data) return <p className="muted">Carregando…</p>;
  const missing = data.items.filter((i) => !i.has_final_note_in_period);

  return (
    <>
      <h1>Pendências de documentação</h1>
      <p className="muted small">
        {service.name} · dia {data.day.split("-").reverse().join("/")} ({data.timezone}) · {missing.length} de {data.items.length} sem evolução finalizada
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Paciente</th>
              <th>Leito</th>
              <th>Situação</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.episode_id}>
                <td>
                  <Link href={`/episodios/${i.episode_id}`}>{i.full_name}</Link>
                </td>
                <td>{i.location ?? "—"}</td>
                <td>
                  {i.has_final_note_in_period ? (
                    <span className="badge ok">finalizada</span>
                  ) : i.has_draft ? (
                    <span className="badge warn">rascunho pendente</span>
                  ) : (
                    <span className="badge bad">sem evolução</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
