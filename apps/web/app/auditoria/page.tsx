"use client";

import { useEffect, useState } from "react";
import { useShell } from "@/components/Shell";
import { api } from "@/lib/client";
import { fmtDateTime } from "@/lib/format";

interface Ev {
  id: string;
  at: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  reason_code: string | null;
  request_id: string | null;
  actor_name: string | null;
  real_user_name: string | null;
}

const OUTCOME: Record<string, string> = { allow: "permitido", deny: "negado", error: "erro" };

export default function Auditoria() {
  const { ctx } = useShell();
  const [rows, setRows] = useState<Ev[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyDenied, setOnlyDenied] = useState(false);

  useEffect(() => {
    api("GET", "/v1/audit")
      .then((r) => setRows(r.events))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (!ctx.tenantCapabilities.includes("audit.read")) return <div className="alert warn">Sem permissão de auditoria nesta instituição.</div>;
  if (error) return <div className="alert bad">{error}</div>;
  if (!rows) return <p className="muted">Carregando…</p>;
  const shown = onlyDenied ? rows.filter((r) => r.outcome !== "allow") : rows;

  return (
    <>
      <div className="row between">
        <h1>Auditoria — {ctx.tenant.name}</h1>
        <label className="small">
          <input type="checkbox" checked={onlyDenied} onChange={(e) => setOnlyDenied(e.target.checked)} /> só negações
        </label>
      </div>
      <p className="muted small">Últimos 300 eventos. Registra quem, o quê e o resultado; não guarda conteúdo clínico.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Quando</th>
              <th>Quem</th>
              <th>Ação</th>
              <th>Recurso</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td className="small">{fmtDateTime(r.at, ctx.tenant.timezone)}</td>
                <td>
                  {r.actor_name ?? "—"}
                  {r.real_user_name && r.real_user_name !== r.actor_name && <div className="muted small">conta real: {r.real_user_name}</div>}
                </td>
                <td>
                  <code>{r.action}</code>
                </td>
                <td className="small">
                  {r.resource_type}
                  {r.resource_id && <span className="muted"> {r.resource_id.slice(0, 8)}</span>}
                </td>
                <td>
                  <span className={`badge ${r.outcome === "allow" ? "ok" : "bad"}`}>{OUTCOME[r.outcome] ?? r.outcome}</span>
                  {r.reason_code && <div className="muted small">{r.reason_code}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
