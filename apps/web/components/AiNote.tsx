"use client";

import { useEffect, useRef, useState } from "react";
import { NOTE_SECTIONS, type NoteSection } from "@evolu/contracts";
import { SECTION_LABELS } from "@evolu/domain";
import { api, ApiFailure } from "@/lib/client";
import { CERTAINTY } from "@/lib/format";

/**
 * Recursos de IA na evolução (ADR 0014). Tudo aqui é proposta: o médico escolhe o que aplicar e
 * em qual seção; nada é salvo sem "Salvar rascunho" e nada é finalizado automaticamente.
 */

export interface ScribeNotes {
  pontos: string[];
  antecedentes: string[];
  exames: string[];
  pendenciasCondutas: string[];
  hipoteses: { descricao: string; certeza: string }[];
}

const BLOCKS: { key: Exclude<keyof ScribeNotes, "hipoteses">; title: string; target: NoteSection }[] = [
  { key: "pontos", title: "Pontos importantes", target: "intercorrencias" },
  { key: "antecedentes", title: "Antecedentes relevantes", target: "antecedentes" },
  { key: "exames", title: "Exames relevantes", target: "resultados_revistos" },
  { key: "pendenciasCondutas", title: "Pendências e condutas", target: "pendencias" },
];

const MAX_SECONDS = 10 * 60;

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported(m));
}

export function ScribePanel({
  noteId,
  onApply,
  onAddProblem,
}: {
  noteId: string;
  onApply: (section: NoteSection, text: string) => void;
  onAddProblem: (description: string, certainty: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"ditado" | "conversa">("ditado");
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [notes, setNotes] = useState<ScribeNotes | null>(null);
  const [targets, setTargets] = useState<Record<string, NoteSection>>(() => Object.fromEntries(BLOCKS.map((b) => [b.key, b.target])));
  const [applied, setApplied] = useState<Set<string>>(new Set());
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

  const canRecord = mode === "ditado" || consent;

  async function send(blob: Blob) {
    setBusy("Transcrevendo e organizando…");
    setError(null);
    try {
      const form = new FormData();
      form.set("audio", blob, "audio");
      form.set("mode", mode);
      if (mode === "conversa") form.set("consent", consent ? "1" : "0");
      const r = await api<{ transcript: string; notes: ScribeNotes | null; structureError?: { message: string } }>(
        "POST",
        `/v1/ai/notes/${noteId}/transcribe`,
        { form },
      );
      setTranscript(r.transcript);
      setNotes(r.notes);
      setApplied(new Set());
      if (r.structureError) setError(`Transcrição pronta, mas a organização falhou: ${r.structureError.message} Use "Reorganizar".`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
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

  async function restructure() {
    setBusy("Organizando…");
    setError(null);
    try {
      const r = await api<{ notes: ScribeNotes }>("POST", `/v1/ai/notes/${noteId}/structure`, { body: { transcript, mode } });
      setNotes(r.notes);
      setApplied(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const mark = (k: string) => setApplied(new Set(applied).add(k));
  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Ditado / transcrição com IA</h2>
      <div className="row">
        <label className="small">
          <input type="radio" checked={mode === "ditado"} onChange={() => setMode("ditado")} disabled={recording} /> Ditado do médico
        </label>
        <label className="small">
          <input type="radio" checked={mode === "conversa"} onChange={() => setMode("conversa")} disabled={recording} /> Conversa com o paciente
        </label>
      </div>
      {mode === "conversa" && (
        <label className="small" style={{ display: "block", margin: "8px 0" }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={recording} /> O paciente (ou
          responsável) autorizou verbalmente a gravação desta conversa.
        </label>
      )}
      <div className="row" style={{ margin: "8px 0" }}>
        {!recording ? (
          <button className="primary" disabled={!canRecord || !!busy} onClick={() => void start()}>
            ● Gravar
          </button>
        ) : (
          <button className="primary" onClick={() => rec.current?.stop()}>
            ■ Parar ({mmss})
          </button>
        )}
        <label className={`button ${!canRecord || busy || recording ? "disabled" : ""}`} style={{ cursor: "pointer" }}>
          Enviar arquivo de áudio
          <input
            type="file"
            accept="audio/*"
            hidden
            disabled={!canRecord || !!busy || recording}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void send(f);
            }}
          />
        </label>
        {busy && <span className="muted small">{busy}</span>}
      </div>
      <p className="muted small">
        Até {MAX_SECONDS / 60} min por gravação. O áudio não é guardado: vai para transcrição e é descartado. O texto abaixo é proposta —
        confira antes de aplicar.
      </p>
      {error && <div className="alert bad">{error}</div>}

      {(transcript || notes) && (
        <details open={!notes}>
          <summary className="small">Transcrição (editável)</summary>
          <textarea aria-label="Transcrição" value={transcript} onChange={(e) => setTranscript(e.target.value)} style={{ minHeight: 120 }} />
          <button disabled={!!busy || transcript.trim().length === 0} onClick={() => void restructure()}>
            Reorganizar em notas
          </button>
        </details>
      )}

      {notes && (
        <div className="stack" style={{ marginTop: 12 }}>
          {BLOCKS.map((b) => {
            const items = notes[b.key];
            if (!items.length) return null;
            return (
              <div key={b.key} className="section">
                <div className="row between">
                  <strong>{b.title}</strong>
                  <span className="row small">
                    <select
                      aria-label={`Seção de destino de ${b.title}`}
                      value={targets[b.key]}
                      onChange={(e) => setTargets({ ...targets, [b.key]: e.target.value as NoteSection })}
                    >
                      {NOTE_SECTIONS.map((s) => (
                        <option key={s} value={s}>
                          {SECTION_LABELS[s]}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={applied.has(b.key)}
                      onClick={() => {
                        onApply(targets[b.key]!, items.map((i) => `- ${i}`).join("\n"));
                        mark(b.key);
                      }}
                    >
                      {applied.has(b.key) ? "Aplicado" : "Aplicar"}
                    </button>
                  </span>
                </div>
                <ul className="small" style={{ margin: "4px 0" }}>
                  {items.map((i, j) => (
                    <li key={j}>{i}</li>
                  ))}
                </ul>
              </div>
            );
          })}
          {notes.hipoteses.length > 0 && (
            <div className="section">
              <strong>Hipóteses diagnósticas</strong>
              <ul className="small" style={{ margin: "4px 0" }}>
                {notes.hipoteses.map((h, j) => (
                  <li key={j}>
                    {h.descricao} <span className="badge plain">{CERTAINTY[h.certeza] ?? h.certeza}</span>{" "}
                    <button
                      className="link small"
                      disabled={applied.has(`h${j}`)}
                      onClick={() =>
                        void onAddProblem(h.descricao, h.certeza)
                          .then(() => mark(`h${j}`))
                          .catch((e: Error) => setError(e.message))
                      }
                    >
                      {applied.has(`h${j}`) ? "adicionado" : "adicionar à lista de problemas"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface Extraction {
  id: string;
  title: string;
  exam_date: string | null;
  summary: string;
  target: string;
  category: string;
}

/** Achados de documentos já confirmados pelo médico, prontos para citar na evolução. */
export function FindingsPanel({ episodeId, onApply }: { episodeId: string; onApply: (section: NoteSection, text: string) => void }) {
  const [rows, setRows] = useState<Extraction[] | null>(null);
  const [used, setUsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    api<{ extractions: Extraction[] }>("GET", `/v1/episodes/${episodeId}/extractions?status=confirmed`)
      .then((r) => setRows(r.extractions))
      .catch(() => setRows([]));
  }, [episodeId]);
  if (!rows || rows.length === 0) return null;
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Achados confirmados de documentos</h2>
      <p className="muted small">Lidos pela IA e conferidos pela equipe. Inserir cita a data do exame — não o torna um exame de hoje.</p>
      {rows.map((x) => {
        const target: NoteSection = x.target === "antecedentes" || x.target === "contexto" ? x.target : "resultados_revistos";
        const when = x.exam_date ? x.exam_date.split("-").reverse().join("/") : "data não informada";
        return (
          <div key={x.id} className="section">
            <div className="row between">
              <strong>
                {x.title} <span className="muted small">({when})</span>
              </strong>
              <button
                disabled={used.has(x.id)}
                onClick={() => {
                  onApply(target, `${x.title} (${when}): ${x.summary}`);
                  setUsed(new Set(used).add(x.id));
                }}
              >
                {used.has(x.id) ? "Inserido" : `Inserir em ${SECTION_LABELS[target]}`}
              </button>
            </div>
            <div className="small readonly">{x.summary}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Revisão por IA do rascunho salvo. Só aponta; a checagem determinística continua valendo. */
export function AiReview({ noteId, save, dirty }: { noteId: string; save: () => Promise<number | null>; dirty: boolean }) {
  const [issues, setIssues] = useState<{ severity: string; section: NoteSection | null; message: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      if (dirty && (await save()) == null) return;
      const r = await api("POST", `/v1/ai/notes/${noteId}/review`, { body: {} });
      setIssues(r.issues);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Falha na revisão.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ marginTop: 12 }}>
      <button disabled={busy} onClick={() => void run()}>
        {busy ? "Revisando…" : "Revisar com IA"}
      </button>
      {error && <div className="alert bad">{error}</div>}
      {issues && issues.length === 0 && <p className="alert ok small">A IA não apontou inconsistências.</p>}
      {issues?.map((i, k) => (
        <div key={k} className={`alert ${i.severity === "atencao" ? "warn" : "plain"} small`}>
          {i.section && <strong>{SECTION_LABELS[i.section]}: </strong>}
          {i.message}
        </div>
      ))}
      {issues && <p className="muted small">Sugestões da IA; não bloqueiam a finalização e podem estar erradas.</p>}
    </div>
  );
}
