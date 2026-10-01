"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

/**
 * Contexto do paciente (ADR 0015): um único campo livre (antecedentes, história, exames anteriores).
 * A foto de um exame ou de outra evolução é lida pela IA e vira uma proposta; só entra no contexto
 * quando o médico toca em "Adicionar ao contexto".
 */

interface Proposal {
  id: string;
  title: string;
  exam_date: string | null;
  summary: string;
  status: string;
  version: number;
  document_id: string;
}

export function ContextCard({
  episodeId,
  context,
  contextVersion,
  canWrite,
  canPhoto,
  onChanged,
}: {
  episodeId: string;
  context: string;
  contextVersion: number;
  canWrite: boolean;
  canPhoto: boolean;
  onChanged: () => void;
}) {
  const [text, setText] = useState(context);
  const [version, setVersion] = useState(contextVersion);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const dirty = text !== context;

  useEffect(() => {
    setText(context);
    setVersion(contextVersion);
  }, [context, contextVersion]);

  const loadProposals = useCallback(() => {
    if (!canPhoto) return;
    api<{ extractions: Proposal[] }>("GET", `/v1/episodes/${episodeId}/extractions`)
      .then((r) => setProposals(r.extractions.filter((x) => x.status === "proposed")))
      .catch(() => setProposals([]));
  }, [episodeId, canPhoto]);
  useEffect(loadProposals, [loadProposals]);

  async function save() {
    setBusy("save");
    setError(null);
    setSaved(false);
    try {
      const r = await api<{ contextVersion: number }>("PUT", `/v1/episodes/${episodeId}/context`, { body: { context: text }, ifMatch: version });
      setVersion(r.contextVersion);
      setSaved(true);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    setBusy("photo");
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", "exame");
      const r = await api<{ extractionError?: { message: string } }>("POST", `/v1/ai/episodes/${episodeId}/documents`, { form });
      if (r.extractionError) setError(`Foto guardada, mas a leitura falhou: ${r.extractionError.message}`);
      loadProposals();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function review(p: Proposal, add: boolean) {
    if (add && dirty && !confirm("Há alterações não salvas no contexto. Elas serão perdidas ao adicionar a leitura. Continuar?")) return;
    setBusy(p.id);
    setError(null);
    try {
      await api("PATCH", `/v1/extractions/${p.id}`, {
        body: add ? { action: "confirm", title: p.title, summary: p.summary, examDate: p.exam_date, target: "contexto", appendToContext: true } : { action: "discard" },
        ifMatch: p.version,
      });
      loadProposals();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const edit = (id: string, patch: Partial<Proposal>) => setProposals(proposals.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  return (
    <div className="card">
      <div className="card-head">
        <h2>Contexto do paciente</h2>
        {canPhoto && (
          <label className={`button ${busy === "photo" ? "disabled" : ""}`}>
            {busy === "photo" ? "Lendo…" : "📷 Foto de exame / evolução"}
            <input
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              capture="environment"
              hidden
              disabled={busy !== null}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
          </label>
        )}
      </div>
      <textarea
        className="big"
        aria-label="Contexto do paciente"
        placeholder="Antecedentes, história da internação, exames anteriores, o que já foi feito… A IA usa este campo ao organizar a evolução do dia."
        value={text}
        disabled={!canWrite}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
      />
      {canWrite && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" disabled={busy !== null || text === context} onClick={() => void save()}>
            {busy === "save" ? "Salvando…" : "Salvar contexto"}
          </button>
          {saved && <span className="pill ok">salvo</span>}
          <span className="muted small">{text.length.toLocaleString("pt-BR")}/20.000</span>
        </div>
      )}
      {error && <div className="alert bad">{error}</div>}

      {proposals.map((p) => (
        <div key={p.id} className="task-proposal column">
          <div className="row between" style={{ width: "100%" }}>
            <span className="pill warn">leitura da IA — confira</span>
            <a className="small" href={`/api/v1/documents/${p.document_id}/content`} target="_blank" rel="noopener">
              ver foto
            </a>
          </div>
          <div className="row" style={{ width: "100%" }}>
            <input aria-label="Título" value={p.title} onChange={(e) => edit(p.id, { title: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
            <input aria-label="Data do documento" type="date" value={p.exam_date ?? ""} onChange={(e) => edit(p.id, { exam_date: e.target.value || null })} />
          </div>
          {!p.exam_date && <div className="muted small">Data não encontrada no documento — informe se souber.</div>}
          <textarea aria-label="Resumo lido" value={p.summary} onChange={(e) => edit(p.id, { summary: e.target.value })} />
          <div className="row">
            <button className="primary" disabled={busy !== null || !canWrite} onClick={() => void review(p, true)}>
              Adicionar ao contexto
            </button>
            <button disabled={busy !== null || !canWrite} onClick={() => void review(p, false)}>
              Descartar
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
