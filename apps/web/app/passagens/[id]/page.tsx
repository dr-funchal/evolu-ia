"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useShell } from "@/components/Shell";
import { api } from "@/lib/client";
import { CERTAINTY, fmtDateTime, label } from "@/lib/format";

interface Snap {
  serviceName: string;
  sentAt: string;
  patients: {
    episodeId: string;
    patientName: string;
    location: string | null;
    illnessSeverity: string;
    summary: string;
    situationAwareness: string | null;
    problems: { description: string; certainty: string }[];
    pendingTasks: { id: string; action: string; due_at: string | null; status: string }[];
  }[];
}
interface Handoff {
  id: string;
  status: string;
  version: number;
  snapshot: Snap;
  sent_at: string;
  sender_name: string;
  receiver_name: string;
  isReceiver: boolean;
  tasks: { id: string; action: string; status: string }[];
  acknowledgments: { decision: string; questions: string | null; at: string; display_name: string }[];
}

const SEVERITY: Record<string, string> = { estavel: "Estável", atencao: "Atenção", instavel: "Instável" };

export default function PassagemDetalhe() {
  const { id } = useParams<{ id: string }>();
  const { service, refresh } = useShell();
  const [h, setH] = useState<Handoff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    api("GET", `/v1/handoffs/${id}`)
      .then(setH)
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  async function ack(decision: "accepted" | "questioned") {
    if (!h) return;
    setError(null);
    if (decision === "questioned" && !questions.trim()) return setError("Descreva as dúvidas.");
    try {
      const r = await api("POST", `/v1/handoffs/${id}/acknowledge`, {
        ifMatch: h.version,
        body: { decision, questions: decision === "questioned" ? questions : undefined },
      });
      setMsg(decision === "accepted" ? `Passagem aceita. ${r.transferredTasks} tarefa(s) agora sob sua responsabilidade.` : "Dúvidas registradas e enviadas.");
      setQuestions("");
      load();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error && !h) return <div className="alert bad">{error}</div>;
  if (!h) return <p className="muted">Carregando…</p>;
  const tz = service?.timezone;
  const open = h.status === "sent" || h.status === "questioned";

  return (
    <>
      <p className="small">
        <Link href="/passagens">← Passagens</Link>
      </p>
      <h1>Passagem — {h.snapshot.serviceName}</h1>
      <p className="muted small">
        De {h.sender_name} para {h.receiver_name} · enviada {fmtDateTime(h.sent_at, tz)} ·{" "}
        <span className="badge plain">{label(h.status)}</span>
      </p>
      <div className="alert small">Conteúdo congelado no momento do envio. Mudanças posteriores no prontuário não aparecem aqui.</div>
      {h.snapshot.patients.map((p) => (
        <div key={p.episodeId} className="card">
          <div className="row between">
            <Link className="name" href={`/episodios/${p.episodeId}`}>
              {p.patientName}
            </Link>
            <span className={`badge ${p.illnessSeverity === "instavel" ? "bad" : p.illnessSeverity === "atencao" ? "warn" : "ok"}`}>
              {SEVERITY[p.illnessSeverity] ?? p.illnessSeverity}
            </span>
          </div>
          <div className="muted small">{p.location ?? "sem leito"}</div>
          <p style={{ whiteSpace: "pre-wrap" }}>{p.summary}</p>
          {p.situationAwareness && (
            <p className="small" style={{ whiteSpace: "pre-wrap" }}>
              <strong>Consciência situacional:</strong> {p.situationAwareness}
            </p>
          )}
          {p.problems.length > 0 && (
            <div className="small">
              {p.problems.map((x, i) => (
                <span key={i} className="badge plain" style={{ marginRight: 4 }}>
                  {x.description} ({CERTAINTY[x.certainty] ?? x.certainty})
                </span>
              ))}
            </div>
          )}
          {p.pendingTasks.length > 0 && (
            <ul className="small">
              {p.pendingTasks.map((t) => (
                <li key={t.id}>
                  {t.action} — {label(t.status)}
                  {t.due_at ? ` · prazo ${fmtDateTime(t.due_at, tz)}` : ""}
                  {h.tasks.some((x) => x.id === t.id) && <span className="badge warn"> transferida no aceite</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {h.acknowledgments.length > 0 && (
        <div className="card">
          <h3>Respostas</h3>
          {h.acknowledgments.map((a, i) => (
            <p key={i} className="small">
              {fmtDateTime(a.at, tz)} — {a.display_name}: <strong>{a.decision === "accepted" ? "aceitou" : "registrou dúvidas"}</strong>
              {a.questions && <span style={{ whiteSpace: "pre-wrap" }}> · {a.questions}</span>}
            </p>
          ))}
        </div>
      )}
      {msg && <div className="alert ok">{msg}</div>}
      {error && <div className="alert bad">{error}</div>}
      {h.isReceiver && open && (
        <div className="card">
          <h3>Sua resposta</h3>
          <div className="field">
            <label>Dúvidas (obrigatório para devolver com dúvidas)</label>
            <textarea rows={2} value={questions} onChange={(e) => setQuestions(e.target.value)} />
          </div>
          <div className="row">
            <button className="primary" onClick={() => void ack("accepted")}>
              Aceitar passagem
            </button>
            <button onClick={() => void ack("questioned")}>Registrar dúvidas</button>
          </div>
        </div>
      )}
    </>
  );
}
