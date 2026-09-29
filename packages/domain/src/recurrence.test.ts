import { describe, expect, it } from "vitest";
import { expand, formatRule, parseRule, zonedToUtc } from "./recurrence";

const TZ = "America/Sao_Paulo";
const win = (a: string, b: string) => [new Date(a), new Date(b)] as const;

describe("recorrência de escala (RFC 5545, subconjunto)", () => {
  it("Bruno, segundas às 08h", () => {
    const occ = expand(
      { dtstartLocal: "2026-10-05T08:00", timezone: TZ, durationMinutes: 240, rrule: "FREQ=WEEKLY;BYDAY=MO", untilLocal: null },
      ...win("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"),
    );
    expect(occ.map((o) => o.originalStartLocal)).toEqual(["2026-10-05T08:00", "2026-10-12T08:00", "2026-10-19T08:00", "2026-10-26T08:00"]);
    expect(occ[0]!.start.toISOString()).toBe("2026-10-05T11:00:00.000Z");
  });

  it("João, sábado e domingo de semanas alternadas desde 03/10 (não é 1º e 3º fim de semana do mês)", () => {
    const occ = expand(
      { dtstartLocal: "2026-10-03T08:00", timezone: TZ, durationMinutes: 720, rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU;WKST=MO", untilLocal: null },
      ...win("2026-10-01T00:00:00Z", "2026-11-02T00:00:00Z"),
    );
    expect(occ.map((o) => o.originalStartLocal.slice(0, 10))).toEqual([
      "2026-10-03",
      "2026-10-04",
      "2026-10-17",
      "2026-10-18",
      "2026-10-31",
      "2026-11-01",
    ]);
    // Cada ocorrência tem duração própria: o fim de semana não vira um plantão contínuo.
    expect(occ.every((o) => o.end.getTime() - o.start.getTime() === 720 * 60_000)).toBe(true);
  });

  it("turno que atravessa a meia-noite aparece na janela do dia seguinte", () => {
    const occ = expand(
      { dtstartLocal: "2026-10-05T19:00", timezone: TZ, durationMinutes: 720, rrule: "FREQ=DAILY", untilLocal: "2026-10-06" },
      ...win("2026-10-06T09:00:00Z", "2026-10-06T12:00:00Z"),
    );
    expect(occ.map((o) => o.originalStartLocal)).toEqual(["2026-10-05T19:00"]);
  });

  it("until é inclusivo e ocorrência única respeita a janela", () => {
    const daily = expand(
      { dtstartLocal: "2026-10-01T07:00", timezone: TZ, durationMinutes: 60, rrule: "FREQ=DAILY;INTERVAL=3", untilLocal: "2026-10-10" },
      ...win("2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z"),
    );
    expect(daily.map((o) => o.originalStartLocal.slice(8, 10))).toEqual(["01", "04", "07", "10"]);
    const once = expand({ dtstartLocal: "2026-10-01T07:00", timezone: TZ, durationMinutes: 60, rrule: null, untilLocal: null }, ...win("2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z"));
    expect(once).toHaveLength(1);
  });

  it("horário de parede é mantido em fuso com horário de verão", () => {
    const a = zonedToUtc("2026-03-07T08:00", "America/New_York");
    const b = zonedToUtc("2026-03-09T08:00", "America/New_York");
    expect(a.toISOString()).toBe("2026-03-07T13:00:00.000Z");
    expect(b.toISOString()).toBe("2026-03-09T12:00:00.000Z");
  });

  it("RRULE: normaliza e rejeita partes não suportadas", () => {
    expect(formatRule(parseRule("FREQ=WEEKLY;BYDAY=SU,SA;INTERVAL=2"))).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU;WKST=MO");
    expect(() => parseRule("FREQ=MONTHLY")).toThrow();
    expect(() => parseRule("FREQ=WEEKLY;COUNT=3")).toThrow();
  });
});
