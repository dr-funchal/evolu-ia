import { afterAll, describe, expect, it } from "vitest";
import { ROLE_CAPABILITIES } from "@evolu/authorization";
import { ownerDb } from "../helpers/api";

/** A matriz de papéis do código (UI/API) e a do banco (RLS) não podem divergir. */
describe("matriz de papéis código × banco", () => {
  const owner = ownerDb();
  afterAll(() => owner.end());

  it("é idêntica", async () => {
    const rows = await owner<{ role: string; capability: string }[]>`select role, capability from app.role_capabilities`;
    const db = new Set(rows.map((r) => `${r.role}:${r.capability}`));
    const code = new Set(Object.entries(ROLE_CAPABILITIES).flatMap(([role, caps]) => caps.map((c) => `${role}:${c}`)));
    expect([...db].filter((x) => !code.has(x))).toEqual([]);
    expect([...code].filter((x) => !db.has(x))).toEqual([]);
  });

  it("papéis não clínicos não têm leitura clínica", () => {
    for (const r of ["secretary", "finance", "tenant_admin"] as const) {
      expect(ROLE_CAPABILITIES[r]).not.toContain("clinical.read");
    }
    expect(ROLE_CAPABILITIES.resident).not.toContain("note.finalize");
  });
});
