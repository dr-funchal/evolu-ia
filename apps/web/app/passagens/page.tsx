"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useShell } from "@/components/Shell";
import { api } from "@/lib/client";
import { fmtDateTime, label } from "@/lib/format";

interface Row {
  id: string;
  service_name: string;
  status: string;
  sent_at: string;
  responded_at: string | null;
  sender_name: string;
  receiver_name: string;
  patient_count: number;
}

export default function Passagens() {
  const { service, can } = useShell();
  const [box, setBox] = useState<"inbox" | "sent" | "all">("inbox");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!service) return;
    setRows(null);
    api("GET", `/v1/handoffs?serviceId=${service.id}&box=${box}`)
      .then((r) => setRows(r.handoffs))
      .catch((e: Error) => setError(e.message));
  }, [service, box]);

  if (!service) return <p className="muted">Selecione um serviço.</p>;
  return (
    <>
      <div className="row between">
        <h1>Passagens de caso</h1>
        <div className="row">
          <select aria-label="Caixa" value={box} onChange={(e) => setBox(e.target.value as typeof box)}>
            <option value="inbox">Recebidas</option>
            <option value="sent">Enviadas</option>
            <option value="all">Todas do serviço</option>
          </select>
          {can("handoff.participate") && can("clinical.read") && (
            <Link className="button primary" href="/passagens/nova">
              Nova passagem
            </Link>
          )}
        </div>
      </div>
      {error && <div className="alert bad">{error}</div>}
      {!rows ? (
        <p className="muted">Carregando…</p>
      ) : rows.length === 0 ? (
        <div className="card muted">Nenhuma passagem.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Enviada</th>
                <th>De</th>
                <th>Para</th>
                <th>Pacientes</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.id}>
                  <td>
                    <Link href={`/passagens/${h.id}`}>{fmtDateTime(h.sent_at, service.timezone)}</Link>
                  </td>
                  <td>{h.sender_name}</td>
                  <td>{h.receiver_name}</td>
                  <td>{h.patient_count}</td>
                  <td>
                    <span className={`badge ${h.status === "acknowledged" ? "ok" : h.status === "questioned" ? "bad" : "warn"}`}>{label(h.status)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
