import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processJobsOnce, processOutboxOnce } from "../../apps/worker/src/index";
import { call, FX, idem, login, sampleContent, teardown, workerDb } from "../helpers/api";

/**
 * Fluxo mínimo da fatia 1 (CLI-01..CLI-08): censo → paciente → nota manual → rascunho → revisão →
 * finalizar (imutável, conflito = 409) → tarefa → passagem → aceite → worker (notificação/exportação).
 */
describe("fluxo clínico completo", () => {
  let bruno: string, ana: string, carla: string, rafael: string;
  const worker = workerDb();
  const s: Record<string, any> = {};

  beforeAll(async () => {
    [bruno, ana, carla, rafael] = await Promise.all([login("bruno"), login("ana"), login("carla"), login("rafael")]);
  });
  afterAll(async () => {
    await worker.end();
    await teardown();
  });

  it("secretária inclui paciente no censo como solicitação, sem dado clínico", async () => {
    const body = {
      hospitalId: FX.hospA1,
      serviceId: FX.neuroA1,
      patient: { fullName: "Paciente Sintético Teste Fluxo", birthDate: "1980-05-05", sex: "feminino" },
      admittedAt: new Date(Date.now() - 3600_000).toISOString(),
      requestedAt: new Date().toISOString(),
      location: "Enfermaria 9 leito 01",
    };
    const denied = await call(carla, "POST", "/v1/encounters", { body: { ...body, reason: "motivo clínico" } });
    expect(denied.status).toBe(403);
    expect(denied.data.error.code).toBe("clinical_field_forbidden");

    const r = await call(carla, "POST", "/v1/encounters", { body, idem: idem() });
    expect(r.status).toBe(201);
    expect(r.data.status).toBe("requested");
    s.episodeId = r.data.episodeId;

    // Duplicidade provável é sinalizada, não resolvida automaticamente.
    const dup = await call(carla, "POST", "/v1/encounters", { body });
    expect(dup.status).toBe(409);
    expect(dup.data.error.code).toBe("possible_duplicate");
  });

  it("secretária não enxerga conteúdo clínico do episódio", async () => {
    const r = await call(carla, "GET", `/v1/episodes/${s.episodeId}`);
    expect(r.status).toBe(200);
    expect(r.data.clinical).toBeNull();
    expect(r.data.capabilities["clinical.read"]).toBe(false);
  });

  it("coordenador aceita e ativa; If-Match obrigatório e conflito de versão = 409", async () => {
    const ep = await call(bruno, "GET", `/v1/episodes/${s.episodeId}`);
    expect(ep.status).toBe(200);
    const v = ep.data.version as number;
    expect((await call(bruno, "POST", `/v1/episodes/${s.episodeId}/transition`, { body: { action: "accept" } })).status).toBe(428);
    expect((await call(bruno, "POST", `/v1/episodes/${s.episodeId}/transition`, { body: { action: "accept" }, ifMatch: v })).status).toBe(200);
    const stale = await call(bruno, "POST", `/v1/episodes/${s.episodeId}/transition`, { body: { action: "activate" }, ifMatch: v });
    expect(stale.status).toBe(409);
    expect((await call(bruno, "POST", `/v1/episodes/${s.episodeId}/transition`, { body: { action: "activate" }, ifMatch: v + 1 })).status).toBe(200);
    const add = await call(bruno, "POST", `/v1/episodes/${s.episodeId}/assignments`, { body: { userId: FX.users.ana, action: "add" } });
    expect(add.status).toBe(200);
  });

  it("assistente cadastra problema e escreve nota manual em rascunho", async () => {
    const p = await call(ana, "POST", `/v1/episodes/${s.episodeId}/problems`, {
      body: { description: "Cefaleia em investigação (sintético)", certainty: "hipotese" },
    });
    expect(p.status).toBe(201);
    s.problemId = p.data.id;

    const n = await call(ana, "POST", `/v1/episodes/${s.episodeId}/notes`, { body: {} });
    expect(n.status).toBe(201);
    s.noteId = n.data.id;

    // Rascunho de outra pessoa não é editável.
    const other = await call(bruno, "PATCH", `/v1/notes/${s.noteId}`, {
      body: { content: sampleContent([s.problemId]), attendedAt: new Date().toISOString() },
      ifMatch: 1,
    });
    expect(other.status).toBe(403);

    const up = await call(ana, "PATCH", `/v1/notes/${s.noteId}`, {
      body: { content: sampleContent([s.problemId]), attendedAt: new Date(Date.now() - 600_000).toISOString() },
      ifMatch: 1,
    });
    expect(up.status).toBe(200);
    expect(up.data.version).toBe(2);
    expect(up.data.check.blocking).toEqual([]);
  });

  it("residente não finaliza nota (sem note.finalize)", async () => {
    const n = await call(rafael, "POST", `/v1/episodes/${s.episodeId}/notes`, { body: {} });
    // O residente só pode escrever se tiver clinical.write no serviço; não pode finalizar em nenhum caso.
    if (n.status === 201) {
      await call(rafael, "PATCH", `/v1/notes/${n.data.id}`, {
        body: { content: sampleContent([]), attendedAt: new Date().toISOString() },
        ifMatch: 1,
      });
      const f = await call(rafael, "POST", `/v1/notes/${n.data.id}/finalize`, { body: {}, ifMatch: 2, idem: idem() });
      expect(f.status).toBe(403);
    } else {
      expect(n.status).toBe(403);
    }
  });

  it("finalização exige If-Match e Idempotency-Key; repetição idempotente devolve o mesmo resultado", async () => {
    expect((await call(ana, "POST", `/v1/notes/${s.noteId}/finalize`, { body: {}, idem: idem() })).status).toBe(428);
    expect((await call(ana, "POST", `/v1/notes/${s.noteId}/finalize`, { body: {}, ifMatch: 2 })).status).toBe(400);

    const key = idem();
    const f = await call(ana, "POST", `/v1/notes/${s.noteId}/finalize`, { body: {}, ifMatch: 2, idem: key });
    expect(f.status).toBe(200);
    expect(f.data.status).toBe("final");
    expect(f.data.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    s.finalVersion = f.data.version;

    const again = await call(ana, "POST", `/v1/notes/${s.noteId}/finalize`, { body: {}, ifMatch: 2, idem: key });
    expect(again.status).toBe(200);
    expect(again.data.versionId).toBe(f.data.versionId);
  });

  it("nota final é imutável: edição e nova finalização retornam 409", async () => {
    const edit = await call(ana, "PATCH", `/v1/notes/${s.noteId}`, {
      body: { content: sampleContent([s.problemId]), attendedAt: new Date().toISOString() },
      ifMatch: s.finalVersion,
    });
    expect(edit.status).toBe(409);
    expect(edit.data.error.code).toBe("note_finalized");
    const fin = await call(ana, "POST", `/v1/notes/${s.noteId}/finalize`, { body: {}, ifMatch: s.finalVersion, idem: idem() });
    expect(fin.status).toBe(409);
  });

  it("correção só por adendo, preservando a versão original", async () => {
    const a = await call(ana, "POST", `/v1/notes/${s.noteId}/addenda`, {
      body: { body: "Correção sintética do horário.", reason: "erro de digitação" },
    });
    expect(a.status).toBe(201);
    const n = await call(ana, "GET", `/v1/notes/${s.noteId}`);
    expect(n.data.versions).toHaveLength(1);
    expect(n.data.addenda).toHaveLength(1);
    expect(n.data.status).toBe("final");
  });

  it("nova nota com prefill traz só histórico marcado, nunca exame", async () => {
    const n = await call(ana, "POST", `/v1/episodes/${s.episodeId}/notes`, { body: { prefillFromLast: true } });
    expect(n.status).toBe(201);
    const d = await call(ana, "GET", `/v1/notes/${n.data.id}`);
    expect(d.data.content.sections.contexto.state).toBe("historico");
    expect(d.data.content.sections.exame.state).toBe("nao_informado");
    expect(d.data.content.sections.subjetivo.state).toBe("nao_informado");
    // Histórico não confirmado bloqueia a finalização.
    expect(d.data.check.blocking.map((b: any) => b.code)).toContain("historical_not_confirmed");
  });

  it("tarefa: responsável precisa ter vínculo clínico no serviço", async () => {
    const base = { taskType: "revisar_resultado", action: "Revisar exame sintético", completionCriterion: "Resultado revisto" };
    const bad = await call(ana, "POST", `/v1/episodes/${s.episodeId}/tasks`, { body: { ...base, assigneeUserId: FX.users.carla } });
    expect(bad.status).toBe(422);
    expect(bad.data.error.code).toBe("invalid_assignee");
    const ok = await call(ana, "POST", `/v1/episodes/${s.episodeId}/tasks`, {
      body: { ...base, assigneeUserId: FX.users.ana, problemId: s.problemId },
    });
    expect(ok.status).toBe(201);
    s.taskId = ok.data.id;
  });

  it("passagem I-PASS: só o receptor aceita; aceite transfere tarefas abertas", async () => {
    const h = await call(ana, "POST", "/v1/handoffs", {
      body: {
        serviceId: FX.neuroA1,
        receiverId: FX.users.bruno,
        patients: [{ episodeId: s.episodeId, illnessSeverity: "atencao", summary: "Resumo sintético." }],
        taskIds: [s.taskId],
      },
    });
    expect(h.status).toBe(201);
    s.handoffId = h.data.id;

    const notReceiver = await call(ana, "POST", `/v1/handoffs/${s.handoffId}/acknowledge`, { body: { decision: "accepted" }, ifMatch: 1 });
    expect(notReceiver.status).toBe(403);
    expect(notReceiver.data.error.code).toBe("not_receiver");

    const ack = await call(bruno, "POST", `/v1/handoffs/${s.handoffId}/acknowledge`, { body: { decision: "accepted" }, ifMatch: 1 });
    expect(ack.status).toBe(200);
    expect(ack.data.status).toBe("acknowledged");
    expect(ack.data.transferredTasks).toBeGreaterThanOrEqual(1);

    const mine = await call(bruno, "GET", `/v1/tasks?serviceId=${FX.neuroA1}&scope=mine`);
    expect(mine.data.tasks.map((t: any) => t.id)).toContain(s.taskId);
  });

  it("worker entrega notificações sem conteúdo clínico", async () => {
    await processOutboxOnce(worker);
    const n = await call(bruno, "GET", "/v1/notifications");
    expect(n.status).toBe(200);
    expect(n.data.notifications.length).toBeGreaterThan(0);
    const text = JSON.stringify(n.data.notifications);
    expect(text).not.toContain("Sintético Teste Fluxo");
    expect(text).not.toContain("Cefaleia");
  });

  it("exportação de nota finalizada é processada por job com contexto do solicitante", async () => {
    const x = await call(ana, "POST", `/v1/notes/${s.noteId}/exports`, { body: {} });
    expect(x.status).toBe(202);
    await processJobsOnce(worker, "test-worker");
    const st = await call(ana, "GET", `/v1/exports/${x.data.id}`);
    expect(st.data.status).toBe("prepared");
    const dl = await call(ana, "GET", `/v1/exports/${x.data.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(dl.data).toContain("Exame sintético do dia.");
  });
});
