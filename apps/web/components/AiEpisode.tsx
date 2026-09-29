"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { fmtDateTime } from "@/lib/format";

/** Recursos de IA na página do paciente (ADR 0014): leitura de documentos, tarefas sugeridas e relatório. */

const CATEGORY: Record<string, string> = {
  laboratorio: "Laboratório",
  imagem: "Imagem",
  laudo: "Laudo",
  medicacoes: "Medicações",
  relatorio_externo: "Relatório externo",
  outro: "Outro",
};
const TARGET: Record<string, string> = {
  resultados_revistos: "Resultados revistos",
  antecedentes: "Antecedentes",
  contexto: "Contexto",
  nenhum: "Não usar na evolução",
};

interface Extraction {
  id: string;
  document_id: string;
  category: string;
  target: string;
  title: string;
  exam_date: string | null;
  summary: string;
  items: { nome: string; valor: string; unidade: string | null; referencia: string | null; alterado: boolean | null }[];
  status: "proposed" | "confirmed" | "discarded";
  created_at: string;
  version: number;
  mime_type: string;
}

export function OcrPanel({ episodeId, timezone, canWrite, onChanged }: { episodeId: string; timezone: string; canWrite: boolean; onChanged: () => void }) {
  const [rows, setRows] = useState<Extraction[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ extractions: Extraction[] }>("GET", `/v1/episodes/${episodeId}/extractions`)
      .then((r) => setRows(r.extractions))
      .catch(() => setRows([]));
  }, [episodeId]);
  useEffect(load, [load]);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", "exame");
      const r = await api("POST", `/v1/ai/episodes/${episodeId}/documents`, { form });
      if (r.extractionError) setError(`Documento guardado, mas a leitura falhou: ${r.extractionError.message}`);
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const proposed = rows.filter((r) => r.status === "proposed");
  const confirmed = rows.filter((r) => r.status === "confirmed");
  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Exames e documentos lidos pela IA</h2>
        {canWrite && (
          <label className={`button primary ${busy ? "disabled" : ""}`} style={{ cursor: "pointer" }}>
            {busy ? "Lendo…" : "📷 Fotografar / enviar"}
            <input
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              capture="environment"
              hidden
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
          </label>
        )}
      </div>
      <p className="muted small">
        A IA lê a foto ou PDF, classifica e sugere onde usar. Nada entra na evolução sem a sua confirmação. Confira sempre a data do exame.
      </p>
      {error && <div className="alert bad">{error}</div>}
      {proposed.map((x) => (
        <ProposedExtraction key={x.id} x={x} timezone={timezone} canWrite={canWrite} onDone={load} />
      ))}
      {confirmed.length > 0 && (
        <>
          <h3>Confirmados</h3>
          <ul>
            {confirmed.map((x) => (
              <li key={x.id}>
                <strong>{x.title}</strong> <span className="muted small">({x.exam_date ? x.exam_date.split("-").reverse().join("/") : "sem data"} · {CATEGORY[x.category]})</span>{" "}
                <a className="small" href={`/api/v1/documents/${x.document_id}/content`} target="_blank" rel="noopener">
                  original
                </a>
                <div className="small">{x.summary}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      {rows.length === 0 && <p className="muted small">Nenhum documento lido.</p>}
    </div>
  );
}

function ProposedExtraction({ x, timezone, canWrite, onDone }: { x: Extraction; timezone: string; canWrite: boolean; onDone: () => void }) {
  const [f, setF] = useState({ title: x.title, summary: x.summary, category: x.category, target: x.target, examDate: x.exam_date ?? "" });
  const [error, setError] = useState<string | null>(null);
  async function review(action: "confirm" | "discard") {
    setError(null);
    try {
      await api("PATCH", `/v1/extractions/${x.id}`, {
        body: action === "discard" ? { action } : { action, ...f, examDate: f.examDate || null },
        ifMatch: x.version,
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="section" style={{ borderLeft: "3px solid var(--warn)" }}>
      <div className="row between small">
        <span className="badge warn">aguardando conferência</span>
        <span className="muted">
          lido em {fmtDateTime(x.created_at, timezone)} ·{" "}
          <a href={`/api/v1/documents/${x.document_id}/content`} target="_blank" rel="noopener">
            ver original
          </a>
        </span>
      </div>
      <div className="grid2">
        <div className="field">
          <label>Título</label>
          <input value={f.title} disabled={!canWrite} onChange={(e) => setF({ ...f, title: e.target.value })} style={{ width: "100%" }} />
        </div>
        <div className="field">
          <label>Data do exame</label>
          <input type="date" value={f.examDate} disabled={!canWrite} onChange={(e) => setF({ ...f, examDate: e.target.value })} />
          {!f.examDate && <div className="small muted">Data não encontrada no documento.</div>}
        </div>
        <div className="field">
          <label>Tipo</label>
          <select value={f.category} disabled={!canWrite} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {Object.entries(CATEGORY).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Usar na evolução em</label>
          <select value={f.target} disabled={!canWrite} onChange={(e) => setF({ ...f, target: e.target.value })}>
            {Object.entries(TARGET).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Resumo</label>
        <textarea value={f.summary} disabled={!canWrite} onChange={(e) => setF({ ...f, summary: e.target.value })} />
      </div>
      {x.items.length > 0 && (
        <details>
          <summary className="small">Valores lidos ({x.items.length})</summary>
          <table className="small">
            <tbody>
              {x.items.map((i, k) => (
                <tr key={k}>
                  <td>{i.nome}</td>
                  <td>
                    {i.alterado ? <strong>{i.valor}</strong> : i.valor} {i.unidade}
                  </td>
                  <td className="muted">{i.referencia}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {error && <div className="alert bad">{error}</div>}
      {canWrite && (
        <div className="row">
          <button className="primary" onClick={() => void review("confirm")}>
            Confirmar
          </button>
          <button className="link" onClick={() => void review("discard")}>
            Descartar leitura
          </button>
        </div>
      )}
    </div>
  );
}

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
