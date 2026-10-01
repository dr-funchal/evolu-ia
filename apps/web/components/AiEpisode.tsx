"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { fmtDateTime } from "@/lib/format";

/** Recursos de IA na página do paciente (ADR 0014): tarefas sugeridas e relatório. A leitura de fotos fica no ContextCard (ADR 0015). */

export function SuggestTasksButton({ episodeId, onDone }: { episodeId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="row">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const r = await api("POST", `/v1/ai/episodes/${episodeId}/task-suggestions`, { body: {} });
            setMsg(r.created ? `${r.created} sugestão(ões) aguardando sua aprovação na lista.` : "A IA não encontrou tarefas faltando.");
            onDone();
          } catch (e) {
            setMsg((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Analisando o caso…" : "Sugerir tarefas com IA"}
      </button>
      {msg && <span className="small muted">{msg}</span>}
    </span>
  );
}

interface ReportRow {
  id: string;
  purpose: "paciente" | "cobranca";
  status: "draft" | "issued";
  created_at: string;
  issued_at: string | null;
  author_name: string;
}

export function ReportsPanel({ episodeId, timezone, canWrite }: { episodeId: string; timezone: string; canWrite: boolean }) {
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ reports: ReportRow[] }>("GET", `/v1/episodes/${episodeId}/reports`)
      .then((r) => setRows(r.reports))
      .catch(() => setRows([]));
  }, [episodeId]);
  useEffect(load, [load]);
  async function create(purpose: "paciente" | "cobranca") {
    setBusy(purpose);
    setError(null);
    try {
      const r = await api("POST", `/v1/ai/episodes/${episodeId}/reports`, { body: { purpose } });
      window.location.href = `/relatorios/${r.id}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }
  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Relatório da internação</h2>
        {canWrite && (
          <span className="row">
            <button disabled={!!busy} onClick={() => void create("paciente")}>
              {busy === "paciente" ? "Redigindo…" : "Para o paciente"}
            </button>
            <button disabled={!!busy} onClick={() => void create("cobranca")}>
              {busy === "cobranca" ? "Redigindo…" : "Para cobrança"}
            </button>
          </span>
        )}
      </div>
      <p className="muted small">Rascunho redigido pela IA a partir das evoluções finalizadas. Você revisa, edita e emite; depois imprime/PDF ou envia por e-mail.</p>
      {error && <div className="alert bad">{error}</div>}
      <ul>
        {rows.map((r) => (
          <li key={r.id}>
            <Link href={`/relatorios/${r.id}`}>{r.purpose === "paciente" ? "Para o paciente" : "Para cobrança"}</Link>{" "}
            <span className={`badge ${r.status === "issued" ? "ok" : "warn"}`}>{r.status === "issued" ? "emitido" : "rascunho"}</span>{" "}
            <span className="muted small">
              {r.author_name} · {fmtDateTime(r.issued_at ?? r.created_at, timezone)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
