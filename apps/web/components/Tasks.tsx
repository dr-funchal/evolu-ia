"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { fmtDateTime, fromLocalInput, label } from "@/lib/format";

export interface TaskRowData {
  id: string;
  action: string;
  completion_criterion: string;
  contingency: string | null;
  status: string;
  status_reason: string | null;
  priority: string | null;
  due_at: string | null;
  due_timezone: string | null;
  version: number;
  assignee_user_id: string | null;
  assignee_name: string | null;
  patient_name?: string;
  service_episode_id?: string;
  overdue?: boolean;
}

export const TASK_TYPES: Record<string, string> = {
  agendar_exame: "Agendar exame",
  confirmar_realizacao: "Confirmar realização",
  obter_laudo: "Obter laudo",
  revisar_resultado: "Revisar resultado",
  contatar: "Contatar",
  reavaliar: "Reavaliar",
  documentar: "Documentar",
  outro: "Outro",
};

export function useTeam(serviceId: string | undefined, cap = "clinical.write") {
  const [team, setTeam] = useState<{ userId: string; displayName: string }[]>([]);
  useEffect(() => {
    if (!serviceId) return;
    api("GET", `/v1/services/${serviceId}/team?cap=${cap}`)
      .then((r) => setTeam(r.members))
      .catch(() => setTeam([]));
  }, [serviceId, cap]);
  return team;
}

export function TaskForm({
  episodeId,
  serviceId,
  timezone,
  problems,
  onCreated,
}: {
  episodeId: string;
  serviceId: string;
  timezone: string;
  problems: { id: string; description: string }[];
  onCreated: () => void;
}) {
  const team = useTeam(serviceId);
  const [f, setF] = useState({ taskType: "revisar_resultado", action: "", completionCriterion: "", contingency: "", assignee: "", due: "", problemId: "", priority: "normal" });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api("POST", `/v1/episodes/${episodeId}/tasks`, {
            body: {
              taskType: f.taskType,
              action: f.action,
              completionCriterion: f.completionCriterion,
              contingency: f.contingency || undefined,
              assigneeUserId: f.assignee || null,
              dueAt: f.due ? fromLocalInput(f.due, timezone) : undefined,
              dueTimezone: f.due ? timezone : undefined,
              problemId: f.problemId || undefined,
              priority: f.priority,
            },
          });
          setF({ ...f, action: "", completionCriterion: "", contingency: "", due: "" });
          onCreated();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <h3>Nova tarefa</h3>
      <div className="grid2">
        <div className="field">
          <label>Tipo</label>
          <select value={f.taskType} onChange={set("taskType")}>
            {Object.entries(TASK_TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Responsável</label>
          <select value={f.assignee} onChange={set("assignee")}>
            <option value="">— sem responsável —</option>
            {team.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Prazo ({timezone})</label>
          <input type="datetime-local" value={f.due} onChange={set("due")} />
        </div>
        <div className="field">
          <label>Problema relacionado</label>
          <select value={f.problemId} onChange={set("problemId")}>
            <option value="">—</option>
            {problems.map((p) => (
              <option key={p.id} value={p.id}>
                {p.description}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Ação</label>
        <input required value={f.action} onChange={set("action")} style={{ width: "100%" }} />
      </div>
      <div className="field">
        <label>Critério de conclusão</label>
        <input required value={f.completionCriterion} onChange={set("completionCriterion")} style={{ width: "100%" }} />
      </div>
      <div className="field">
        <label>Se não acontecer (contingência)</label>
        <input value={f.contingency} onChange={set("contingency")} style={{ width: "100%" }} />
      </div>
      {error && <div className="alert bad">{error}</div>}
      <button className="primary" type="submit">
        Criar tarefa
      </button>
    </form>
  );
}

export function TaskList({ tasks, timezone, canEdit, onChanged, showPatient }: {
  tasks: TaskRowData[];
  timezone?: string;
  canEdit: boolean;
  onChanged: () => void;
  showPatient?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  async function change(t: TaskRowData, status: string) {
    setError(null);
    let statusReason: string | undefined;
    if (status === "blocked" || status === "cancelled") {
      statusReason = prompt(status === "blocked" ? "Motivo do bloqueio:" : "Motivo do cancelamento:") ?? undefined;
      if (!statusReason) return;
    }
    try {
      await api("PATCH", `/v1/tasks/${t.id}`, { body: { status, statusReason }, ifMatch: t.version });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!tasks.length) return <p className="muted small">Nenhuma tarefa.</p>;
  return (
    <div className="table-wrap">
      {error && <div className="alert bad">{error}</div>}
      <table>
        <thead>
          <tr>
            {showPatient && <th>Paciente</th>}
            <th>Ação</th>
            <th>Responsável</th>
            <th>Prazo</th>
            <th>Situação</th>
            {canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const open = ["open", "in_progress", "blocked"].includes(t.status);
            const late = open && t.due_at && new Date(t.due_at) < new Date();
            return (
              <tr key={t.id}>
                {showPatient && (
                  <td>
                    <a href={`/episodios/${t.service_episode_id}`}>{t.patient_name}</a>
                  </td>
                )}
                <td>
                  {t.action}
                  <div className="muted small">Concluída quando: {t.completion_criterion}</div>
                  {t.contingency && <div className="muted small">Se não: {t.contingency}</div>}
                  {t.status_reason && <div className="muted small">Motivo: {t.status_reason}</div>}
                </td>
                <td>{t.assignee_name ?? <span className="badge warn">sem responsável</span>}</td>
                <td>
                  {fmtDateTime(t.due_at, t.due_timezone ?? timezone)}
                  {late && <span className="badge bad"> atrasada</span>}
                </td>
                <td>
                  <span className={`badge ${t.status === "done" ? "ok" : t.status === "blocked" ? "bad" : "plain"}`}>{label(t.status)}</span>
                </td>
                {canEdit && (
                  <td>
                    {open && (
                      <select aria-label="Alterar situação" value="" onChange={(e) => e.target.value && void change(t, e.target.value)}>
                        <option value="">alterar…</option>
                        {t.status !== "in_progress" && <option value="in_progress">em andamento</option>}
                        <option value="done">concluída</option>
                        {t.status !== "blocked" && <option value="blocked">bloquear</option>}
                        {t.status === "blocked" && <option value="open">desbloquear</option>}
                        <option value="cancelled">cancelar</option>
                      </select>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
