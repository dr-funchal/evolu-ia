"use client";

import { useCallback, useEffect, useState } from "react";
import { useShell } from "@/components/Shell";
import { TaskList, type TaskRowData } from "@/components/Tasks";
import { api } from "@/lib/client";

export default function Tarefas() {
  const { service, can } = useShell();
  const [scope, setScope] = useState<"service" | "mine">("service");
  const [closed, setClosed] = useState(false);
  const [tasks, setTasks] = useState<TaskRowData[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!service) return;
    setError(null);
    const q = new URLSearchParams();
    if (scope === "service") q.set("serviceId", service.id);
    else q.set("scope", "mine");
    if (closed) q.set("closed", "1");
    api("GET", `/v1/tasks?${q}`)
      .then((r) => setTasks(r.tasks))
      .catch((e: Error) => setError(e.message));
  }, [service, scope, closed]);
  useEffect(load, [load]);

  if (!service) return <p className="muted">Selecione um serviço.</p>;
  if (!can("clinical.read") && scope === "service")
    return <div className="alert warn">Seu papel neste serviço não inclui acesso às tarefas clínicas.</div>;

  return (
    <>
      <div className="row between">
        <h1>Tarefas</h1>
        <div className="row">
          <select aria-label="Escopo" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="service">Do serviço ({service.name})</option>
            <option value="mine">Atribuídas a mim (todos os serviços)</option>
          </select>
          <label className="small">
            <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> incluir encerradas
          </label>
        </div>
      </div>
      {error && <div className="alert bad">{error}</div>}
      {!tasks ? <p className="muted">Carregando…</p> : <TaskList tasks={tasks} timezone={service.timezone} canEdit={can("clinical.write")} onChanged={load} showPatient />}
    </>
  );
}
