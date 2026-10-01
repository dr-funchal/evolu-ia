import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeOpenRouter, VALID_KEY, type FakeOpenRouter } from "../helpers/fake-openrouter";
import { call, FX, idem, login, ownerDb, teardown } from "../helpers/api";

/**
 * Evolução simples, contexto do paciente e paciente por foto (ADR 0015). A IA organiza e propõe;
 * o médico edita, aprova as tarefas e finaliza.
 */
const EP = FX.ep.neuroA1_1;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

const sys = (body: any): string => {
  const m = body.messages?.find((x: any) => x.role === "system");
  return typeof m?.content === "string" ? m.content : "";
};
const userText = (body: any): string => {
  const m = body.messages?.find((x: any) => x.role === "user");
  return typeof m?.content === "string" ? m.content : "";
};

function replies(body: any): string {
  const s = sys(body);
  if (s.includes("Organize a evolução do dia"))
    return JSON.stringify({
      destaques: ["Piora da força em MSE (sintético)"],
      evolucao: "Resumo do dia\nPaciente sintético com piora discreta.\nConduta\nSolicitada RM.",
      tarefas: [
        { taskType: "revisar_resultado", action: "Ver laudo da RM (sintético)", completionCriterion: "Laudo revisto", priority: "alta" },
        { taskType: "reavaliar", action: "Reavaliar força (sintético)", completionCriterion: "Exame registrado", priority: "normal" },
      ],
    });
  if (s.includes("Identifique o paciente na foto"))
    return JSON.stringify({ legivel: true, nome: "Paciente Foto Sintético", nascimento: "1950-03-04", leito: "UTI 2 - L5", prontuario: "778899", sexo: "F" });
  if (s.includes("Transcreva e classifique"))
    return JSON.stringify({ legivel: true, category: "laboratorio", target: "contexto", title: "Hemograma (sintético)", exam_date: "2026-09-20", summary: "Hb 11 (sintético)", items: [] });
  return "{}";
}

describe("evolução simples, contexto e paciente por foto", () => {
  const P: Record<string, string> = {};
  const owner = ownerDb();
  let fake: FakeOpenRouter;
  const s: Record<string, any> = {};

  beforeAll(async () => {
    fake = await startFakeOpenRouter();
    fake.reply = replies;
    for (const p of ["gabriela", "ana", "bruno", "carla", "eduardo", "fabio"] as const) P[p] = await login(p);
    expect((await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { apiKey: VALID_KEY, model: "acme/texto-1", transcriptionModel: "acme/whisper" } })).status).toBe(200);
    expect((await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { enabled: true } })).status).toBe(200);
  });
  afterAll(async () => {
    await fake.close();
    await owner`delete from app.ai_usage`;
    await owner`delete from app.tenant_ai_settings`;
    await owner.end();
    await teardown();
  });

  describe("contexto do paciente", () => {
    it("salva com If-Match (0 sem linha); versão errada = 409; sem If-Match = 428", async () => {
      const ep = await call(P.ana!, "GET", `/v1/episodes/${EP}`);
      const v0 = ep.data.clinical.contextVersion;
      expect(typeof ep.data.clinical.context).toBe("string");
      expect((await call(P.ana!, "PUT", `/v1/episodes/${EP}/context`, { body: { context: "x" } })).status).toBe(428);
      const ok = await call(P.ana!, "PUT", `/v1/episodes/${EP}/context`, { body: { context: "HAS, DM2 (sintético)" }, ifMatch: v0 });
      expect(ok.status).toBe(200);
      expect(ok.data.contextVersion).toBe(v0 + 1);
      const stale = await call(P.bruno!, "PUT", `/v1/episodes/${EP}/context`, { body: { context: "outro" }, ifMatch: v0 });
      expect(stale.status).toBe(409);
      const again = await call(P.ana!, "GET", `/v1/episodes/${EP}`);
      expect(again.data.clinical.context).toBe("HAS, DM2 (sintético)");
      s.ctxVersion = again.data.clinical.contextVersion;
      const [a] = await owner`select 1 from app.audit_events where action = 'episode.context.update' and resource_id = ${EP}`;
      expect(a).toBeDefined();
    });

    it("secretária e outro tenant não alteram o contexto", async () => {
      expect((await call(P.carla!, "PUT", `/v1/episodes/${EP}/context`, { body: { context: "x" }, ifMatch: s.ctxVersion })).status).toBe(403);
      expect((await call(P.eduardo!, "PUT", `/v1/episodes/${EP}/context`, { body: { context: "x" }, ifMatch: s.ctxVersion, tenant: FX.tenantB })).status).toBe(404);
    });

    it("foto de exame confirmada entra no contexto com a data do exame", async () => {
      const f = new FormData();
      f.set("file", new Blob([PNG]), "exame.png");
      const up = await call(P.ana!, "POST", `/v1/ai/episodes/${EP}/documents`, { rawBody: f });
      expect(up.status).toBe(201);
      const x = up.data.extraction;
      expect(x.status).toBe("proposed");
      const ok = await call(P.ana!, "PATCH", `/v1/extractions/${x.id}`, { body: { action: "confirm", appendToContext: true }, ifMatch: x.version });
      expect(ok.status).toBe(200);
      expect(ok.data.contextVersion).toBe(s.ctxVersion + 1);
      const ep = await call(P.ana!, "GET", `/v1/episodes/${EP}`);
      expect(ep.data.clinical.context).toBe("HAS, DM2 (sintético)\n\n[Hemograma (sintético) — 20/09/2026] Hb 11 (sintético)");
    });
  });

  describe("evolução simples", () => {
    it("nova evolução nasce simples; só exige texto e horário para finalizar", async () => {
      const n = await call(P.ana!, "POST", `/v1/episodes/${EP}/notes`, { body: {} });
      expect(n.status).toBe(201);
      s.noteId = n.data.id;
      const g = await call(P.ana!, "GET", `/v1/notes/${s.noteId}`);
      expect(g.data.content).toEqual({ schema: 2, transcricao: "", evolucao: "", destaques: [] });
      const empty = await call(P.ana!, "PATCH", `/v1/notes/${s.noteId}`, {
        body: { content: g.data.content, attendedAt: new Date(Date.now() - 60_000).toISOString() },
        ifMatch: 1,
      });
      expect(empty.status).toBe(200);
      expect(empty.data.check.blocking.map((b: any) => b.code)).toEqual(["empty_note"]);
    });

    it("organizar: devolve proposta, não altera a nota e cria tarefas só como sugestão para amanhã", async () => {
      const before = await owner<{ n: number }[]>`select count(*)::int n from app.tasks where service_episode_id = ${EP} and status = 'proposed'`;
      const r = await call(P.ana!, "POST", `/v1/ai/notes/${s.noteId}/organize`, { body: { transcricao: "Hoje piorou força em MSE, pedi RM (sintético)." } });
      expect(r.status).toBe(200);
      expect(r.data.destaques).toEqual(["Piora da força em MSE (sintético)"]);
      expect(r.data.evolucao).toContain("Solicitada RM");
      expect(r.data.tasks.length).toBeGreaterThan(0);
      expect(r.data.tasks.length).toBeLessThanOrEqual(5 - before[0]!.n);
      const due = new Date(r.data.tasks[0].dueAt).getTime();
      expect(due).toBeGreaterThan(Date.now());
      expect(due).toBeLessThan(Date.now() + 2 * 86_400_000);
      const rows = await owner<{ status: string; source: string }[]>`select status, source from app.tasks where id = ${r.data.tasks[0].id}`;
      expect(rows[0]).toEqual({ status: "proposed", source: "ia" });
      // Material enviado: contexto como "registrado antes" e o texto do dia; sem nome do paciente.
      const sent = fake.seen.findLast((x) => x.path === "/api/v1/chat/completions" && sys(x.body).includes("Organize a evolução do dia"))!;
      const u = userText(sent.body);
      expect(u).toContain("HAS, DM2 (sintético)");
      expect(u).toContain("=== TEXTO DO DIA ===");
      const [pt] = await owner<{ full_name: string }[]>`
        select p.full_name from app.service_episodes e join app.encounters en on en.id = e.encounter_id join app.patients p on p.id = en.patient_id
        where e.id = ${EP}`;
      expect(u).not.toContain(pt!.full_name);
      const note = await call(P.ana!, "GET", `/v1/notes/${s.noteId}`);
      expect(note.data.version).toBe(2);
    });

    it("finaliza com a evolução organizada pelo médico; exportação usa destaques e evolução", async () => {
      const content = { schema: 2, transcricao: "Hoje piorou (sintético).", evolucao: "Piora discreta; RM pedida (sintético).", destaques: ["Piora (sintético)"] };
      const up = await call(P.ana!, "PATCH", `/v1/notes/${s.noteId}`, { body: { content, attendedAt: new Date(Date.now() - 60_000).toISOString() }, ifMatch: 2 });
      expect(up.status).toBe(200);
      expect(up.data.check.blocking).toEqual([]);
      const f = await call(P.ana!, "POST", `/v1/notes/${s.noteId}/finalize`, { body: {}, ifMatch: 3, idem: idem() });
      expect(f.status).toBe(200);
      // Organizar nota finalizada não existe mais.
      expect((await call(P.ana!, "POST", `/v1/ai/notes/${s.noteId}/organize`, { body: { transcricao: "x" } })).status).toBe(409);
    });

    it("outro autor, secretária e outro tenant são negados antes de chamar a IA", async () => {
      const n = await call(P.ana!, "POST", `/v1/episodes/${EP}/notes`, { body: {} });
      const before = fake.seen.length;
      expect((await call(P.bruno!, "POST", `/v1/ai/notes/${n.data.id}/organize`, { body: { transcricao: "x" } })).status).toBe(403);
      expect((await call(P.carla!, "POST", `/v1/ai/notes/${n.data.id}/organize`, { body: { transcricao: "x" } })).status).toBe(404);
      expect((await call(P.eduardo!, "POST", `/v1/ai/notes/${n.data.id}/organize`, { body: { transcricao: "x" }, tenant: FX.tenantB })).status).toBe(404);
      expect(fake.seen.length).toBe(before);
      expect((await call(P.ana!, "POST", `/v1/ai/notes/${n.data.id}/organize`, { body: { transcricao: "   " } })).status).toBe(400);
    });

    it("formato estruturado continua disponível sob pedido", async () => {
      const n = await call(P.ana!, "POST", `/v1/episodes/${EP}/notes`, { body: { format: "estruturada" } });
      expect(n.status).toBe(201);
      const g = await call(P.ana!, "GET", `/v1/notes/${n.data.id}`);
      expect(g.data.content.schema).toBe(1);
    });
  });

  describe("novo paciente por foto", () => {
    const form = (bytes: Uint8Array<ArrayBuffer>) => {
      const f = new FormData();
      f.set("file", new Blob([bytes]), "etiqueta.png");
      return f;
    };

    it("lê nome, nascimento, leito, prontuário e sexo; a imagem não é guardada", async () => {
      const docs = await owner<{ n: number }[]>`select count(*)::int n from app.source_documents`;
      const r = await call(P.carla!, "POST", `/v1/ai/services/${FX.neuroA1}/patient-photo`, { rawBody: form(PNG) });
      expect(r.status).toBe(200);
      expect(r.data).toEqual({ legivel: true, fullName: "Paciente Foto Sintético", birthDate: "1950-03-04", location: "UTI 2 - L5", mrn: "778899", sex: "feminino" });
      const after = await owner<{ n: number }[]>`select count(*)::int n from app.source_documents`;
      expect(after[0]!.n).toBe(docs[0]!.n);
      const [a] = await owner`select 1 from app.audit_events where action = 'ai.patient.photo' and resource_id = ${FX.neuroA1}`;
      expect(a).toBeDefined();
    });

    it("formato desconhecido = 415; financeiro e outro tenant são negados", async () => {
      expect((await call(P.ana!, "POST", `/v1/ai/services/${FX.neuroA1}/patient-photo`, { rawBody: form(new Uint8Array([0x4d, 0x5a, 0, 0])) })).status).toBe(415);
      const before = fake.seen.length;
      expect([403, 404]).toContain((await call(P.fabio!, "POST", `/v1/ai/services/${FX.neuroA1}/patient-photo`, { rawBody: form(PNG) })).status);
      expect([403, 404]).toContain((await call(P.eduardo!, "POST", `/v1/ai/services/${FX.neuroA1}/patient-photo`, { rawBody: form(PNG), tenant: FX.tenantB })).status);
      expect(fake.seen.filter((x) => x.path === "/api/v1/chat/completions").length).toBe(fake.seen.slice(0, before).filter((x) => x.path === "/api/v1/chat/completions").length);
    });

    it("modelo sem leitura de imagem = ai_no_vision", async () => {
      expect((await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { model: "acme/cego" } })).status).toBe(200);
      const r = await call(P.carla!, "POST", `/v1/ai/services/${FX.neuroA1}/patient-photo`, { rawBody: form(PNG) });
      expect(r.status).toBe(422);
      expect(r.data.error.code).toBe("ai_no_vision");
      expect((await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { model: "acme/texto-1" } })).status).toBe(200);
    });
  });
});
