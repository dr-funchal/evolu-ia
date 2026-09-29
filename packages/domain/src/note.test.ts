import { describe, expect, it } from "vitest";
import { checkFinalize, emptyNoteContent, prefillFromPrevious } from "./note";
import { localDayBounds } from "./time";

const V = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";

describe("nota clínica (domínio)", () => {
  it("CLI-04: nota anterior com exame normal não copia exame para a nova nota", () => {
    const prev = emptyNoteContent([P]);
    prev.sections.exame = { state: "informado", text: "Exame neurológico sem alterações." };
    prev.sections.contexto = { state: "informado", text: "Interconsulta por cefaleia." };
    const next = prefillFromPrevious(prev, V, [P]);
    expect(next.sections.exame).toEqual({ state: "nao_informado" });
    expect(next.sections.contexto).toEqual({ state: "historico", text: "Interconsulta por cefaleia.", sourceVersionId: V });
  });

  it("conteúdo histórico bloqueia a finalização até reconfirmação", () => {
    const c = emptyNoteContent();
    c.sections.contexto = { state: "historico", text: "x", sourceVersionId: V };
    c.sections.subjetivo = { state: "informado", text: "Sem queixas novas." };
    const r = checkFinalize(c, new Date());
    expect(r.blocking.map((b) => b.code)).toContain("historical_not_confirmed");
  });

  it("exame não informado gera aviso (justificável), não bloqueio", () => {
    const c = emptyNoteContent();
    c.sections.subjetivo = { state: "informado", text: "Sem queixas novas." };
    const r = checkFinalize(c, new Date());
    expect(r.blocking).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toContain("exam_not_documented");
  });

  it("sem horário de atendimento bloqueia", () => {
    const c = emptyNoteContent();
    c.sections.subjetivo = { state: "informado", text: "ok" };
    expect(checkFinalize(c, null).blocking.map((b) => b.code)).toContain("attended_at_missing");
  });
});

describe("tempo local", () => {
  it("limites do dia em America/Sao_Paulo (UTC-3)", () => {
    const { start, end } = localDayBounds("2026-09-29", "America/Sao_Paulo");
    expect(start.toISOString()).toBe("2026-09-29T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-30T03:00:00.000Z");
  });
  it("dia com mudança de horário (America/New_York, 2026-11-01) tem 25h", () => {
    const { start, end } = localDayBounds("2026-11-01", "America/New_York");
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });
});
