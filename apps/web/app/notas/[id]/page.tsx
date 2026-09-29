"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { NOTE_SECTIONS, type NoteContent, type NoteField } from "@evolu/contracts";
import { FIELD_STATE_LABELS, SECTION_LABELS } from "@evolu/domain";
import { AiReview, FindingsPanel, ScribePanel } from "@/components/AiNote";
import { useShell } from "@/components/Shell";
import { api, ApiFailure, newKey } from "@/lib/client";
import { CERTAINTY, fmtDateTime, fromLocalInput, label, toLocalInput } from "@/lib/format";

interface Issue {
  code: string;
  message: string;
  section?: string;
}
interface Note {
  id: string;
  episodeId: string;
  serviceId: string;
  noteType: string;
  status: "draft" | "final";
  version: number;
  attendedAt: string | null;
  finalizedAt: string | null;
  author: { id: string; displayName: string };
  content: NoteContent;
  problems: { id: string; description: string; certainty: string; status: string }[];
  versions: { id: string; version_no: number; content_sha256: string; recorded_at: string; warnings: string[]; warnings_justification: string | null }[];
  addenda: { id: string; body: string; reason: string; created_at: string; author_name: string }[];
  exports: { id: string; status: string; created_at: string; incorporated_at: string | null }[];
  check: { blocking: Issue[]; warnings: Issue[] } | null;
  permissions: { edit: boolean; finalize: boolean; addendum: boolean };
}

const EDITABLE_STATES: NoteField["state"][] = ["informado", "nao_informado", "nao_avaliado", "nao_aplicavel"];

export default function NotePage() {
  const { id } = useParams<{ id: string }>();
  const { ctx } = useShell();
  const [note, setNote] = useState<Note | null>(null);
  const [content, setContent] = useState<NoteContent | null>(null);
  const [attended, setAttended] = useState("");
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [justification, setJustification] = useState("");
  const [finalizeKey, setFinalizeKey] = useState(newKey);
  const [busy, setBusy] = useState(false);

  const tz = ctx.services.find((s) => s.id === note?.serviceId)?.timezone ?? ctx.tenant.timezone;

  const load = useCallback(() => {
    api<Note>("GET", `/v1/notes/${id}`)
      .then((n) => {
        setNote(n);
        setContent(n.content);
        setDirty(false);
        setConflict(false);
      })
      .catch((e: Error) => setMsg({ kind: "bad", text: e.message }));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    if (note) setAttended(note.attendedAt ? toLocalInput(new Date(note.attendedAt), tz) : toLocalInput(new Date(), tz));
  }, [note, tz]);

  if (!note || !content) return msg ? <div className="alert bad">{msg.text}</div> : <p className="muted">Carregando…</p>;
  const editable = note.permissions.edit;

  const setSection = (s: (typeof NOTE_SECTIONS)[number], f: NoteField) => {
    setContent({ ...content, sections: { ...content.sections, [s]: f } });
    setDirty(true);
  };
  const setProblem = (i: number, k: "avaliacao" | "plano", f: NoteField) => {
    const problems = content.problems.map((p, j) => (j === i ? { ...p, [k]: f } : p));
    setContent({ ...content, problems });
    setDirty(true);
  };

  async function save(): Promise<number | null> {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api("PATCH", `/v1/notes/${id}`, {
        body: { content, attendedAt: attended ? fromLocalInput(attended, tz) : null },
        ifMatch: note!.version,
      });
      setNote({ ...note!, version: r.version, check: r.check, content: content! });
      setDirty(false);
      setMsg({ kind: "ok", text: "Rascunho salvo." });
      return r.version as number;
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "version_conflict") setConflict(true);
      setMsg({ kind: "bad", text: (e as Error).message });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function finalize() {
    const version = dirty ? await save() : note!.version;
    if (version == null) return;
    setBusy(true);
    try {
      await api("POST", `/v1/notes/${id}/finalize`, {
        body: { warningsJustification: justification || undefined },
        ifMatch: version,
        idempotencyKey: finalizeKey,
      });
      setMsg({ kind: "ok", text: "Evolução finalizada. A partir de agora, correções só por adendo." });
      load();
    } catch (e) {
      if (e instanceof ApiFailure && (e.code === "finalize_blocked" || e.code === "warnings_need_justification")) {
        setNote({ ...note!, version, check: e.details as Note["check"] });
        setFinalizeKey(newKey());
      }
      if (e instanceof ApiFailure && e.code === "version_conflict") setConflict(true);
      setMsg({ kind: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const aiOn = ctx.tenant.modules.ai && editable;
  /** Aplica texto proposto pela IA acrescentando ao que já existe na seção (nunca substitui). */
  const appendToSection = (s: (typeof NOTE_SECTIONS)[number], text: string) => {
    const cur = content.sections[s];
    const prev = cur.state === "informado" ? (cur.text ?? "").trim() : "";
    setSection(s, { state: "informado", text: prev ? `${prev}\n${text}` : text });
  };
  const addProblem = async (description: string, certainty: string) => {
    const r = await api<{ id: string }>("POST", `/v1/episodes/${note.episodeId}/problems`, { body: { description, certainty } });
    setNote({ ...note, problems: [...note.problems, { id: r.id, description, certainty, status: "ativo" }] });
    setContent({ ...content, problems: [...content.problems, { problemId: r.id, avaliacao: { state: "nao_informado" }, plano: { state: "nao_informado" } }] });
    setDirty(true);
  };

  const problemName = (pid: string) => note.problems.find((p) => p.id === pid);
  const missingProblems = note.problems.filter((p) => p.status !== "resolvido" && !content.problems.some((x) => x.problemId === p.id));

  return (
    <>
      <p className="small">
        <Link href={`/episodios/${note.episodeId}`}>← voltar ao paciente</Link>
      </p>
      <div className="card">
        <div className="row between">
          <h1 style={{ margin: 0 }}>{note.noteType === "evolucao" ? "Evolução" : "Interconsulta inicial"}</h1>
          <span className={`badge ${note.status === "final" ? "ok" : "warn"}`}>{label(note.status)}</span>
        </div>
        <p className="muted small">
          Autor: {note.author.displayName}
          {note.finalizedAt && ` · finalizada em ${fmtDateTime(note.finalizedAt, tz)}`}
        </p>
        <div className="field">
          <label htmlFor="att">Data/hora do atendimento ({tz})</label>
          {editable ? (
            <input id="att" type="datetime-local" value={attended} onChange={(e) => { setAttended(e.target.value); setDirty(true); }} />
          ) : (
            <div>{fmtDateTime(note.attendedAt, tz)}</div>
          )}
        </div>
        {conflict && (
          <div className="alert bad">
            Esta evolução foi alterada em outro lugar. Suas mudanças não foram salvas.{" "}
            <button onClick={load}>Recarregar a versão atual</button>
          </div>
        )}
      </div>

      {aiOn && <ScribePanel noteId={note.id} onApply={appendToSection} onAddProblem={addProblem} />}
      {aiOn && <FindingsPanel episodeId={note.episodeId} onApply={appendToSection} />}

      <div className="card">
        {NOTE_SECTIONS.map((s) => (
          <FieldEditor key={s} title={SECTION_LABELS[s]} field={content.sections[s]} editable={editable} onChange={(f) => setSection(s, f)} />
        ))}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Avaliação e plano por problema</h2>
        {content.problems.map((p, i) => {
          const pr = problemName(p.problemId);
          return (
            <div key={p.problemId} className="stack" style={{ marginBottom: 12 }}>
              <h3>
                {pr?.description ?? "Problema"} {pr && <span className="badge plain">{CERTAINTY[pr.certainty] ?? pr.certainty}</span>}
                {editable && (
                  <button className="link small" style={{ marginLeft: 8 }} onClick={() => { setContent({ ...content, problems: content.problems.filter((_, j) => j !== i) }); setDirty(true); }}>
                    remover desta nota
                  </button>
                )}
              </h3>
              <FieldEditor title="Avaliação" field={p.avaliacao} editable={editable} onChange={(f) => setProblem(i, "avaliacao", f)} />
              <FieldEditor title="Plano" field={p.plano} editable={editable} onChange={(f) => setProblem(i, "plano", f)} />
            </div>
          );
        })}
        {editable && missingProblems.length > 0 && (
          <select
            aria-label="Incluir problema"
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              setContent({ ...content, problems: [...content.problems, { problemId: e.target.value, avaliacao: { state: "nao_informado" }, plano: { state: "nao_informado" } }] });
              setDirty(true);
            }}
          >
            <option value="">incluir problema do paciente…</option>
            {missingProblems.map((p) => (
              <option key={p.id} value={p.id}>
                {p.description}
              </option>
            ))}
          </select>
        )}
      </div>

      {note.status === "draft" && note.check && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Revisão antes de finalizar</h2>
          {note.check.blocking.length === 0 && note.check.warnings.length === 0 && <p className="alert ok">Nenhuma pendência encontrada.</p>}
          {note.check.blocking.map((b, i) => (
            <div key={`b${i}`} className="alert bad">
              {b.message}
            </div>
          ))}
          {note.check.warnings.map((w, i) => (
            <div key={`w${i}`} className="alert warn">
              {w.message}
            </div>
          ))}
          {note.check.warnings.length > 0 && note.permissions.finalize && (
            <div className="field">
              <label htmlFor="just">Justificativa para os avisos</label>
              <textarea id="just" value={justification} onChange={(e) => setJustification(e.target.value)} />
            </div>
          )}
          <p className="muted small">A checagem é determinística (completude e estados explícitos). Ela não interpreta o conteúdo clínico.</p>
          {aiOn && <AiReview noteId={note.id} save={save} dirty={dirty} />}
        </div>
      )}

      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}
      {editable && (
        <div className="row" style={{ marginBottom: 16 }}>
          <button onClick={() => void save()} disabled={busy || !dirty}>
            Salvar rascunho
          </button>
          {note.permissions.finalize ? (
            <button className="primary" disabled={busy} onClick={() => { if (confirm("Finalizar? A nota ficará imutável; correções só por adendo.")) void finalize(); }}>
              Revisar e finalizar
            </button>
          ) : (
            <span className="muted small">Seu papel não permite finalizar; peça a revisão de um médico assistente.</span>
          )}
        </div>
      )}

      {note.status === "final" && <FinalPanel note={note} tz={tz} onChanged={load} />}
    </>
  );
}

function FieldEditor({ title, field, editable, onChange }: { title: string; field: NoteField; editable: boolean; onChange: (f: NoteField) => void }) {
  const hasText = field.state === "informado" || field.state === "historico";
  return (
    <div className={`section ${field.state}`}>
      <div className="row between">
        <strong>{title}</strong>
        {editable && field.state !== "historico" ? (
          <select
            aria-label={`Estado de ${title}`}
            value={field.state}
            onChange={(e) => {
              const state = e.target.value as NoteField["state"];
              onChange(state === "informado" ? { state, text: field.text ?? "" } : { state });
            }}
          >
            {EDITABLE_STATES.map((s) => (
              <option key={s} value={s}>
                {FIELD_STATE_LABELS[s]}
              </option>
            ))}
          </select>
        ) : (
          <span className={`badge ${field.state === "historico" ? "warn" : "plain"}`}>{FIELD_STATE_LABELS[field.state]}</span>
        )}
      </div>
      {field.state === "historico" && (
        <div className="small muted">
          Copiado de nota anterior — precisa ser reconfirmado ou descartado antes de finalizar.
          {editable && (
            <>
              {" "}
              <button className="link" onClick={() => onChange({ state: "informado", text: field.text ?? "" })}>
                confirmar como atual
              </button>{" "}
              <button className="link" onClick={() => onChange({ state: "nao_informado" })}>
                descartar
              </button>
            </>
          )}
        </div>
      )}
      {hasText &&
        (editable && field.state === "informado" ? (
          <textarea aria-label={title} value={field.text ?? ""} onChange={(e) => onChange({ state: "informado", text: e.target.value })} />
        ) : (
          <div className="readonly">{field.text}</div>
        ))}
    </div>
  );
}

function FinalPanel({ note, tz, onChanged }: { note: Note; tz: string; onChanged: () => void }) {
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Versão finalizada</h2>
        {note.versions.map((v) => (
          <div key={v.id} className="small">
            Versão {v.version_no} · registrada {fmtDateTime(v.recorded_at, tz)} · SHA-256 <code>{v.content_sha256.slice(0, 16)}…</code>
            {v.warnings_justification && <div className="muted">Avisos justificados: {v.warnings_justification}</div>}
          </div>
        ))}
        <p className="muted small">
          Integridade por hash do conteúdo. Não é assinatura digital qualificada (ICP-Brasil).
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Adendos</h2>
        {note.addenda.length === 0 && <p className="muted small">Nenhum adendo.</p>}
        {note.addenda.map((a) => (
          <div key={a.id} className="section">
            <div className="small muted">
              {a.author_name} · {fmtDateTime(a.created_at, tz)} · motivo: {a.reason}
            </div>
            <div className="readonly">{a.body}</div>
          </div>
        ))}
        {note.permissions.addendum && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api("POST", `/v1/notes/${note.id}/addenda`, { body: { body, reason } });
                setBody("");
                setReason("");
              });
            }}
          >
            <div className="field">
              <label>Adendo</label>
              <textarea required value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            <div className="field">
              <label>Motivo</label>
              <input required value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: "100%" }} />
            </div>
            <button type="submit">Registrar adendo</button>
          </form>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Exportar para o prontuário do hospital</h2>
        <p className="muted small">Gera texto para colar no prontuário oficial. Marque como incorporado depois de conferir lá.</p>
        <button onClick={() => void run(() => api("POST", `/v1/notes/${note.id}/exports`, { body: {} }))}>Preparar exportação</button>
        <ul>
          {note.exports.map((x) => (
            <li key={x.id}>
              {fmtDateTime(x.created_at, tz)} · {label(x.status)}{" "}
              {x.status === "queued" && <span className="muted small">(processando…)</span>}
              {(x.status === "prepared" || x.status === "exported") && (
                <a href={`/api/v1/exports/${x.id}/download`} onClick={() => setTimeout(onChanged, 800)}>
                  baixar texto
                </a>
              )}{" "}
              {x.status === "exported" && (
                <button className="link small" onClick={() => void run(() => api("POST", `/v1/exports/${x.id}/incorporated`, { body: {} }))}>
                  marcar como incorporado
                </button>
              )}
              {x.incorporated_at && <span className="badge ok">incorporado {fmtDateTime(x.incorporated_at, tz)}</span>}
            </li>
          ))}
        </ul>
        {error && <div className="alert bad">{error}</div>}
      </div>
    </>
  );
}
