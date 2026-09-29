import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Sql } from "./client";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export interface Migration {
  id: string;
  upSql: string;
  downSql: string | null;
  checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.endsWith(".down.sql")).sort();
  const out: Migration[] = [];
  for (const f of files) {
    const id = f.replace(/\.sql$/, "");
    const upSql = await readFile(path.join(dir, f), "utf8");
    const downSql = await readFile(path.join(dir, `${id}.down.sql`), "utf8").catch(() => null);
    out.push({ id, upSql, downSql, checksum: createHash("sha256").update(upSql).digest("hex") });
  }
  return out;
}

async function ensureTable(sql: Sql) {
  await sql.unsafe(`
    create schema if not exists evolu_meta;
    create table if not exists evolu_meta.schema_migrations (
      id text primary key, checksum text not null, applied_at timestamptz not null default now()
    );`);
}

async function applied(sql: Sql): Promise<Map<string, string>> {
  const rows = await sql<{ id: string; checksum: string }[]>`select id, checksum from evolu_meta.schema_migrations order by id`;
  return new Map(rows.map((r) => [r.id, r.checksum]));
}

/** Aplica pendentes, cada uma na própria transação. Checksum divergente interrompe (migration editada após aplicar). */
export async function migrateUp(sql: Sql, dir?: string): Promise<string[]> {
  await ensureTable(sql);
  const done = await applied(sql);
  const ran: string[] = [];
  for (const m of await loadMigrations(dir)) {
    const prev = done.get(m.id);
    if (prev) {
      if (prev !== m.checksum) throw new Error(`migration ${m.id} foi alterada depois de aplicada (checksum diferente)`);
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(m.upSql);
      await tx`insert into evolu_meta.schema_migrations (id, checksum) values (${m.id}, ${m.checksum})`;
    });
    ran.push(m.id);
  }
  return ran;
}

/** Reverte a última (ou as N últimas) migrations aplicadas. */
export async function migrateDown(sql: Sql, steps = 1, dir?: string): Promise<string[]> {
  await ensureTable(sql);
  const all = new Map((await loadMigrations(dir)).map((m) => [m.id, m]));
  const done = [...(await applied(sql)).keys()].sort().reverse().slice(0, steps);
  for (const id of done) {
    const m = all.get(id);
    if (!m?.downSql) throw new Error(`migration ${id} não tem arquivo .down.sql`);
    await sql.begin(async (tx) => {
      await tx.unsafe(m.downSql!);
      await tx`delete from evolu_meta.schema_migrations where id = ${id}`;
    });
  }
  return done;
}

export async function migrationStatus(sql: Sql, dir?: string) {
  await ensureTable(sql);
  const done = await applied(sql);
  return (await loadMigrations(dir)).map((m) => ({
    id: m.id,
    applied: done.has(m.id),
    checksumOk: !done.has(m.id) || done.get(m.id) === m.checksum,
  }));
}
