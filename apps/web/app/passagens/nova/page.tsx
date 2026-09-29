"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useShell } from "@/components/Shell";
import { useTeam, type TaskRowData } from "@/components/Tasks";
import { api, newKey } from "@/lib/client";

interface WorkItem {
  episodeId: string;
  status: string;
  location: string | null;
  patient: { fullName: string };
}
interface Draft {
  include: boolean;
  illnessSeverity: "estavel" | "atencao" | "instavel";
  summary: string;
  situationAwareness: string;
}

const SEVERITY = { estavel: "Estável", atencao: "Atenção", instavel: "Instável" } as const;

export default function NovaPassagem() {
  const { service, me } = useShell();
  const router = useRouter();
  const team = useTeam(service?.id, "handoff.participate").filter((m) => m.userId !== me.user.id);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [tasks, setTasks] = useState<TaskRowData[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [receiverId, setReceiverId] = useState("");
  const [taskIds, setTaskIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey);

  useEffect(() => {
    if (!service) return;
    api("GET", `/v1/worklist?serviceId=${service.id}`)
      .then((r) => setItems((r.items as WorkItem[]).filter((i) => i.status === "active")))
      .catch((e: Error) => setError(e.message));
    api("GET", `/v1/tasks?serviceId=${service.id}`)
      .then((r) => setTasks(r.tasks))
      .catch(() => setTasks([]));
  }, [service]);

  if (!service) return <p className="muted">Selecione um serviço.</p>;

  const d = (id: string): Draft => drafts[id] ?? { include: false, illnessSeverity: "estavel", summary: "", situationAwareness: "" };
  const upd = (id: string, patch: Partial<Draft>) => setDrafts({ ...drafts, [id]: { ...d(id), ...patch } });
  const chosen = items.filter((i) => d(i.episodeId).include);

  async function submit() {
    setError(null);
    if (!receiverId) return setError("Escolha quem recebe a passagem.");
    if (!chosen.length) return setError("Inclua ao menos um paciente.");
    if (chosen.some((i) => !d(i.episodeId).summary.trim())) return setError("Todo paciente incluído precisa de resumo.");
    const episodeIds = new Set(chosen.map((i) => i.episodeId));
    setBusy(true);
    try {
      const r = await api("POST", "/v1/handoffs", {
        idempotencyKey: key,
        body: {
          serviceId: service!.id,
          receiverId,
          patients: chosen.map((i) => {
            const x = d(i.episodeId);
            return {
              episodeId: i.episodeId,
              illnessSeverity: x.illnessSeverity,
              summary: x.summary,
              situationAwareness: x.situationAwareness.trim() || undefined,
            };
          }),
          taskIds: [...taskIds].filter((t) => episodeIds.has(tasks.find((x) => x.id === t)?.service_episode_id ?? "")),
        },
      });
      router.push(`/passagens/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Nova passagem — {service.name}</h1>
      <p className="muted small">
        Formato I-PASS. A gravidade é atribuída por você; nada é calculado automaticamente. As tarefas marcadas passam a ser do receptor quando ele aceitar.
      </p>
      <div className="card">
        <div className="field">
          <label>Receptor</label>
          <select value={receiverId} onChange={(e) => setReceiverId(e.target.value)}>
            <option value="">— escolha —</option>
            {team.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>
      {items.length === 0 && <div className="card muted">Nenhum paciente em acompanhamento ativo.</div>}
      {items.map((i) => {
        const x = d(i.episodeId);
        const pt = tasks.filter((t) => t.service_episode_id === i.episodeId);
        return (
          <div key={i.episodeId} className="card">
            <label className="row">
              <input type="checkbox" checked={x.include} onChange={(e) => upd(i.episodeId, { include: e.target.checked })} />
              <strong>{i.patient.fullName}</strong> <span className="muted small">{i.location ?? "sem leito"}</span>
            </label>
            {x.include && (
              <>
                <div className="field">
                  <label>Gravidade (I)</label>
                  <select value={x.illnessSeverity} onChange={(e) => upd(i.episodeId, { illnessSeverity: e.target.value as Draft["illnessSeverity"] })}>
                    {Object.entries(SEVERITY).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Resumo do paciente (P)</label>
                  <textarea required rows={3} value={x.summary} onChange={(e) => upd(i.episodeId, { summary: e.target.value })} />
                </div>
                <div className="field">
                  <label>Consciência situacional e contingências (S)</label>
                  <textarea rows={2} value={x.situationAwareness} onChange={(e) => upd(i.episodeId, { situationAwareness: e.target.value })} />
                </div>
                {pt.length > 0 && (
                  <div className="field">
                    <label>Tarefas a transferir (A)</label>
                    {pt.map((t) => (
                      <label key={t.id} className="small row">
                        <input
                          type="checkbox"
                          checked={taskIds.has(t.id)}
                          onChange={(e) => {
                            const n = new Set(taskIds);
                            if (e.target.checked) n.add(t.id);
                            else n.delete(t.id);
                            setTaskIds(n);
                          }}
                        />
                        {t.action} <span className="muted">({t.assignee_name ?? "sem responsável"})</span>
                      </label>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
      {error && <div className="alert bad">{error}</div>}
      <button className="primary" disabled={busy} onClick={() => void submit()}>
        Enviar passagem ({chosen.length})
      </button>
    </>
  );
}
