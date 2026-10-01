"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ReportsPanel, SuggestTasksButton } from "@/components/AiEpisode";
import { ContextCard } from "@/components/ContextCard";
import { useShell } from "@/components/Shell";
import { TaskForm, TaskList, useTeam, type TaskRowData } from "@/components/Tasks";
import { api } from "@/lib/client";
import { ageFrom, CERTAINTY, fmtDate, fmtDateTime, label, PRIORITY } from "@/lib/format";

interface Episode {
  id: string;
  serviceId: string;
  status: string;
  version: number;
  priority: string | null;
  requested_at: string;
  service_name: string;
  hospital_name: string;
  timezone: string;
  mrn: string | null;
  admitted_at: string;
  full_name: string;
  birth_date: string | null;
  sex: string | null;
  identifiers: { system: string; value: string }[];
  location: string | null;
  careTeam: { userId: string; displayName: string }[];
  capabilities: Record<string, boolean>;
  clinical: {
    reason: string | null;
    context: string;
    contextVersion: number;
    requesterText: string | null;
    problems: { id: string; description: string; certainty: string; status: string; version: number; last_reviewed_at: string | null }[];
    notes: { id: string; note_type: string; status: string; attended_at: string | null; finalized_at: string | null; author_name: string; addenda: number }[];
    othersDrafts: number;
    tasks: TaskRowData[];
  } | null;
  documents: { id: string; kind: string; mime_type: string; size_bytes: number; created_at: string }[];
}

export default function EpisodePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [ep, setEp] = useState<Episode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Episode>("GET", `/v1/episodes/${id}`)
      .then(setEp)
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  const team = useTeam(ep?.serviceId);
  const { ctx } = useShell();
  const aiOn = ctx.tenant.modules.ai;

  if (error) return <div className="alert bad">{error}</div>;
  if (!ep) return <p className="muted">Carregando…</p>;
  const caps = ep.capabilities;
  const c = ep.clinical;
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const transition = (action: string) => {
    let justification: string | undefined;
    if (action === "close" || action === "cancel") {
      justification = prompt(action === "close" ? "Motivo do encerramento (alta, óbito, fim do acompanhamento…):" : "Motivo do cancelamento:") ?? undefined;
      if (!justification) return;
    }
    void run(() => api("POST", `/v1/episodes/${id}/transition`, { body: { action, justification }, ifMatch: ep.version }));
  };

  const canWrite = Boolean(caps["clinical.write"]);
  const open = ["active", "accepted"].includes(ep.status);
  const newNote = (format?: "estruturada") =>
    void run(async () => {
      const r = await api("POST", `/v1/episodes/${id}/notes`, { body: format ? { format } : {} });
      router.push(`/notas/${r.id}`);
    });

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/" className="back">
            ← Pacientes
          </Link>
          <h1>{ep.full_name}</h1>
          <div className="muted small">
            {ep.location ?? "sem leito"} · {ageFrom(ep.birth_date)} · nasc. {fmtDate(ep.birth_date)} · {ep.sex ?? "sexo não informado"}
          </div>
          <div className="muted small">
            {ep.service_name} · {ep.hospital_name} · admissão {fmtDateTime(ep.admitted_at, ep.timezone)}
            {ep.identifiers.map((i) => ` · ${i.system}: ${i.value}`)}
          </div>
        </div>
        <div className="row">
          <span className={`pill ${ep.status === "active" ? "ok" : "plain"}`}>{label(ep.status)}</span>
          {ep.priority && <span className="pill warn">{PRIORITY[ep.priority] ?? ep.priority}</span>}
        </div>
      </div>
      {caps["census.manage"] && (
        <div className="row" style={{ marginBottom: 16 }}>
          {ep.status === "requested" && <button onClick={() => transition("accept")}>Aceitar solicitação</button>}
          {(ep.status === "requested" || ep.status === "accepted") && <button onClick={() => transition("activate")}>Iniciar acompanhamento</button>}
          {ep.status === "active" && <button onClick={() => transition("close")}>Encerrar acompanhamento</button>}
          {["requested", "accepted"].includes(ep.status) && (
            <button className="danger" onClick={() => transition("cancel")}>
              Cancelar
            </button>
          )}
        </div>
      )}
      {msg && <div className="alert warn">{msg}</div>}

      {c ? (
        <>
          <div className="card">
            <div className="card-head">
              <h2>Evoluções</h2>
              {canWrite && open && (
                <button className="primary" onClick={() => newNote()}>
                  + Nova evolução
                </button>
              )}
            </div>
            {c.othersDrafts > 0 && <p className="muted small">{c.othersDrafts} rascunho(s) de outras pessoas (não visíveis).</p>}
            {c.notes.length === 0 && <p className="muted small">Nenhuma evolução ainda. Toque em “Nova evolução” e dite ou escreva o dia.</p>}
            <ul className="list">
              {c.notes.map((n) => (
                <li key={n.id}>
                  <Link href={`/notas/${n.id}`} className="strong-link">
                    {n.note_type === "evolucao" ? "Evolução" : "Interconsulta inicial"} — {fmtDateTime(n.attended_at, ep.timezone)}
                  </Link>
                  <span className="muted small">
                    {n.author_name}
                    {n.addenda ? ` · ${n.addenda} adendo(s)` : ""}
                  </span>
                  <span className={`pill ${n.status === "final" ? "ok" : "warn"}`}>{label(n.status)}</span>
                </li>
              ))}
            </ul>
            {canWrite && open && (
              <button className="link small" onClick={() => newNote("estruturada")} title="Formato antigo, com seções e problemas separados.">
                Usar formato estruturado (seções)
              </button>
            )}
          </div>

          <ContextCard
            episodeId={id}
            context={c.context}
            contextVersion={c.contextVersion}
            canWrite={canWrite}
            canPhoto={Boolean(aiOn && canWrite && caps["document.upload"])}
            onChanged={load}
          />

          <div className="card">
            <div className="card-head">
              <h2>Tarefas</h2>
              {aiOn && canWrite && open && <SuggestTasksButton episodeId={id} onDone={load} />}
            </div>
            <TaskList tasks={c.tasks} timezone={ep.timezone} canEdit={canWrite} onChanged={load} />
            {canWrite && (
              <details className="more">
                <summary>+ Nova tarefa</summary>
                <TaskForm episodeId={id} serviceId={ep.serviceId} timezone={ep.timezone} problems={c.problems.filter((p) => p.status !== "resolvido")} onCreated={load} />
              </details>
            )}
          </div>
        </>
      ) : (
        <div className="alert warn">Seu papel neste serviço não inclui leitura clínica.</div>
      )}

      <details className="card more">
        <summary>Mais: equipe, documentos{c ? ", problemas e relatórios" : ""}</summary>
        {c?.reason && (
          <p>
            <strong>Motivo:</strong> {c.reason}
          </p>
        )}
        <h3>Equipe responsável</h3>
        {ep.careTeam.length ? (
          <ul>
            {ep.careTeam.map((m) => (
              <li key={m.userId}>
                {m.displayName}{" "}
                {caps["census.manage"] && (
                  <button className="link small" onClick={() => void run(() => api("POST", `/v1/episodes/${id}/assignments`, { body: { userId: m.userId, action: "remove" } }))}>
                    remover
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="pill warn">sem responsável</p>
        )}
        {caps["census.manage"] && (
          <select
            aria-label="Adicionar à equipe"
            value=""
            onChange={(e) => e.target.value && void run(() => api("POST", `/v1/episodes/${id}/assignments`, { body: { userId: e.target.value, action: "add" } }))}
          >
            <option value="">adicionar pessoa…</option>
            {team
              .filter((t) => !ep.careTeam.some((m) => m.userId === t.userId))
              .map((t) => (
                <option key={t.userId} value={t.userId}>
                  {t.displayName}
                </option>
              ))}
          </select>
        )}
        {(caps["census.manage"] || canWrite) && (
          <p>
            <button
              className="link small"
              onClick={() => {
                const location = prompt("Nova localização / leito:", ep.location ?? "");
                if (location) void run(() => api("POST", `/v1/episodes/${id}/location`, { body: { location } }));
              }}
            >
              Atualizar leito
            </button>
          </p>
        )}

        <h3>Documentos</h3>
        {ep.documents.length === 0 && <p className="muted small">Nenhum documento.</p>}
        <ul>
          {ep.documents.map((d) => (
            <li key={d.id}>
              <a href={`/api/v1/documents/${d.id}/content`} target="_blank" rel="noopener">
                {d.kind} · {d.mime_type} · {Math.round(d.size_bytes / 1024)} KB
              </a>{" "}
              <span className="muted small">{fmtDateTime(d.created_at, ep.timezone)}</span>
            </li>
          ))}
        </ul>
        {caps["document.upload"] && <Upload episodeId={id} onDone={load} />}

        {c && (
          <>
            <h3>Problemas</h3>
            <Problems episodeId={id} problems={c.problems} canWrite={canWrite} onChanged={load} />
          </>
        )}
        {c && aiOn && <ReportsPanel episodeId={id} timezone={ep.timezone} canWrite={canWrite} />}
      </details>
    </>
  );
}

function Problems({ episodeId, problems, canWrite, onChanged }: {
  episodeId: string;
  problems: NonNullable<Episode["clinical"]>["problems"];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [desc, setDesc] = useState("");
  const [certainty, setCertainty] = useState("hipotese");
  const [error, setError] = useState<string | null>(null);
  const patch = async (p: { id: string; version: number }, body: Record<string, unknown>) => {
    setError(null);
    try {
      await api("PATCH", `/v1/problems/${p.id}`, { body, ifMatch: p.version });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      {problems.length === 0 && <p className="muted small">Nenhum problema cadastrado.</p>}
      <ul>
        {problems.map((p) => (
          <li key={p.id}>
            {p.description} <span className="badge plain">{CERTAINTY[p.certainty] ?? p.certainty}</span>{" "}
            <span className="muted small">{p.status}</span>{" "}
            {canWrite && (
              <select aria-label="Alterar problema" value="" onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                if (v === "reviewed") void patch(p, { reviewed: true });
                else if (v.startsWith("c:")) void patch(p, { certainty: v.slice(2) });
                else void patch(p, { status: v });
              }}>
                <option value="">alterar…</option>
                <option value="reviewed">marcar revisado hoje</option>
                <option value="c:confirmado">confirmar diagnóstico</option>
                <option value="c:hipotese">voltar a hipótese</option>
                <option value="resolvido">resolvido</option>
                <option value="ativo">ativo</option>
                <option value="suspenso">suspenso</option>
              </select>
            )}
          </li>
        ))}
      </ul>
      {error && <div className="alert bad">{error}</div>}
      {canWrite && (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await api("POST", `/v1/episodes/${episodeId}/problems`, { body: { description: desc, certainty } });
              setDesc("");
              onChanged();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <input required placeholder="Novo problema" value={desc} onChange={(e) => setDesc(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <select value={certainty} onChange={(e) => setCertainty(e.target.value)}>
            <option value="hipotese">hipótese</option>
            <option value="diferencial">diferencial</option>
            <option value="confirmado">confirmado</option>
          </select>
          <button type="submit">Adicionar</button>
        </form>
      )}
    </>
  );
}

function Upload({ episodeId, onDone }: { episodeId: string; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        const formEl = e.currentTarget;
        setError(null);
        setBusy(true);
        try {
          await api("POST", `/v1/episodes/${episodeId}/documents`, { form: new FormData(formEl) });
          formEl.reset();
          onDone();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <select name="kind" defaultValue="laudo">
        <option value="laudo">laudo</option>
        <option value="exame">exame</option>
        <option value="documento">documento</option>
        <option value="outro">outro</option>
      </select>
      <input type="file" name="file" required accept="application/pdf,image/png,image/jpeg" />
      <button type="submit" disabled={busy}>
        Anexar
      </button>
      {error && <div className="alert bad">{error}</div>}
    </form>
  );
}
