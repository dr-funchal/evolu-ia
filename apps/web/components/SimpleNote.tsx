"use client";

import { useEffect, useRef, useState } from "react";
import type { SimpleNote } from "@evolu/contracts";
import { api } from "@/lib/client";
import { fmtDateTime } from "@/lib/format";

/**
 * Evolução simples (ADR 0015): um campo de texto do dia (digitado ou ditado). "Organizar com IA"
 * usa o texto + o contexto do paciente e devolve a evolução organizada, os destaques e tarefas
 * para checar amanhã — tudo proposta: o médico edita, aprova as tarefas e finaliza.
 */

const MAX_SECONDS = 10 * 60;

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported(m));
}

/** Botão de ditado: grava, transcreve (sem reorganizar) e devolve o texto. O áudio não é guardado. */
export function DictateButton({ noteId, disabled, onText }: { noteId: string; disabled?: boolean; onText: (text: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
      rec.current?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  async function send(blob: Blob) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("audio", blob, "audio");
      form.set("mode", "ditado");
      form.set("structure", "0");
      const r = await api<{ transcript: string }>("POST", `/v1/ai/notes/${noteId}/transcribe`, { form });
      onText(r.transcript);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMime();
      const r = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timer.current) clearInterval(timer.current);
        setRecording(false);
        void send(new Blob(chunks.current, { type: r.mimeType }));
      };
      rec.current = r;
      r.start(1000);
      setSeconds(0);
      setRecording(true);
      timer.current = setInterval(
        () =>
          setSeconds((s) => {
            if (s + 1 >= MAX_SECONDS && rec.current?.state === "recording") rec.current.stop();
            return s + 1;
          }),
        1000,
      );
    } catch {
      setError("Não foi possível acessar o microfone. Verifique a permissão do navegador.");
    }
  }

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <>
      {recording ? (
        <button type="button" className="rec" onClick={() => rec.current?.stop()}>
          ■ Parar · {mmss}
        </button>
      ) : (
        <button type="button" disabled={disabled || busy} onClick={() => void start()}>
          {busy ? "Transcrevendo…" : "🎙 Ditar"}
        </button>
      )}
      {error && <span className="alert bad inline">{error}</span>}
    </>
  );
}

interface ProposedTask {
  id: string;
  action: string;
  completionCriterion: string;
  priority: string;
  dueAt: string;
  version: number;
  state?: "approved" | "discarded";
}

export function SimpleNoteEditor({
  noteId,
  content,
  editable,
  aiOn,
  tz,
  onChange,
}: {
  noteId: string;
  content: SimpleNote;
  editable: boolean;
  aiOn: boolean;
  tz: string;
  onChange: (c: SimpleNote) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<ProposedTask[]>([]);
  const [skipped, setSkipped] = useState(0);

  const appendText = (t: string) => {
    const cur = content.transcricao.trimEnd();
    onChange({ ...content, transcricao: cur ? `${cur}\n${t}` : t });
  };

  async function organize() {
    if (content.evolucao.trim() && !confirm("Substituir a evolução organizada atual pela nova proposta da IA?")) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ destaques: string[]; evolucao: string; tasks: ProposedTask[]; tasksSkipped: number }>(
        "POST",
        `/v1/ai/notes/${noteId}/organize`,
        { body: { transcricao: content.transcricao } },
      );
      onChange({ ...content, evolucao: r.evolucao, destaques: r.destaques });
      setTasks((prev) => [...r.tasks, ...prev]);
      setSkipped(r.tasksSkipped);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function review(t: ProposedTask, approve: boolean) {
    setError(null);
    try {
      await api("PATCH", `/v1/tasks/${t.id}`, {
        body: approve ? { status: "open" } : { status: "cancelled", statusReason: "Sugestão da IA descartada" },
        ifMatch: t.version,
      });
      setTasks(tasks.map((x) => (x.id === t.id ? { ...x, state: approve ? "approved" : "discarded" } : x)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const organized = content.evolucao.trim() || content.destaques.length > 0;

  if (!editable) {
    return (
      <div className="card">
        {content.destaques.length > 0 && <Highlights items={content.destaques} />}
        <div className="readonly">{content.evolucao.trim() || content.transcricao}</div>
        {content.evolucao.trim() && content.transcricao.trim() && (
          <details className="small" style={{ marginTop: 12 }}>
            <summary>Texto original do dia</summary>
            <div className="readonly muted">{content.transcricao}</div>
          </details>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Evolução do dia</h2>
          {aiOn && <DictateButton noteId={noteId} disabled={busy} onText={appendText} />}
        </div>
        <textarea
          className="big"
          aria-label="Evolução do dia"
          placeholder="Dite ou escreva livremente: como o paciente está, exame, resultados, o que foi decidido, o que falta…"
          value={content.transcricao}
          onChange={(e) => onChange({ ...content, transcricao: e.target.value })}
        />
        {aiOn && (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" disabled={busy || !content.transcricao.trim()} onClick={() => void organize()}>
              {busy ? "Organizando…" : "✨ Organizar com IA"}
            </button>
            <span className="muted small">Usa o texto do dia + o contexto do paciente. Cria as tarefas para checar amanhã como sugestão.</span>
          </div>
        )}
        {error && <div className="alert bad">{error}</div>}
      </div>

      {(organized || !aiOn) && (
        <div className="card">
          <div className="card-head">
            <h2>{aiOn ? "Evolução organizada" : "Evolução"}</h2>
            {aiOn && <span className="pill warn">proposta — revise</span>}
          </div>
          {content.destaques.length > 0 && (
            <Highlights items={content.destaques} onRemove={(i) => onChange({ ...content, destaques: content.destaques.filter((_, j) => j !== i) })} />
          )}
          <textarea
            className="big"
            aria-label="Evolução organizada"
            placeholder={aiOn ? "" : "Opcional: versão final da evolução. Se ficar vazio, vale o texto do dia."}
            value={content.evolucao}
            onChange={(e) => onChange({ ...content, evolucao: e.target.value })}
          />
        </div>
      )}

      {(tasks.length > 0 || skipped > 0) && (
        <div className="card">
          <div className="card-head">
            <h2>Checar amanhã</h2>
            <span className="pill warn">sugestões da IA</span>
          </div>
          {tasks.map((t) => (
            <div key={t.id} className={`task-proposal ${t.state ?? ""}`}>
              <div>
                <strong>{t.action}</strong>
                <div className="muted small">
                  Concluída quando: {t.completionCriterion} · prioridade {t.priority} · {fmtDateTime(t.dueAt, tz)}
                </div>
              </div>
              {t.state ? (
                <span className={`pill ${t.state === "approved" ? "ok" : "plain"}`}>{t.state === "approved" ? "aprovada" : "descartada"}</span>
              ) : (
                <div className="row">
                  <button className="primary" onClick={() => void review(t, true)}>
                    Aprovar
                  </button>
                  <button onClick={() => void review(t, false)}>Descartar</button>
                </div>
              )}
            </div>
          ))}
          {skipped > 0 && (
            <p className="muted small">
              {skipped} sugestão(ões) não foram criadas: já há 5 aguardando aprovação neste paciente. Aprove ou descarte as pendentes.
            </p>
          )}
        </div>
      )}
    </>
  );
}

function Highlights({ items, onRemove }: { items: string[]; onRemove?: (i: number) => void }) {
  return (
    <ul className="highlights">
      {items.map((d, i) => (
        <li key={i}>
          <span>{d}</span>
          {onRemove && (
            <button className="link small" aria-label="Remover destaque" onClick={() => onRemove(i)}>
              ✕
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
