import { createSql, migrateUp, seedSynthetic } from "@evolu/database";

/**
 * Recria o banco `evolu_test` do zero a cada execução: migrations reais (papel dono) e seed
 * sintético. Os testes acessam como evolu_app / evolu_worker — sujeitos à RLS.
 */
export default async function setup() {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
  const migUrl = process.env.EVOLU_TEST_MIGRATION_URL;
  if (!adminUrl || !migUrl) throw new Error("Defina TEST_ADMIN_DATABASE_URL e MIGRATION_DATABASE_URL (ver docs/runbooks/testes.md).");
  const admin = createSql(adminUrl, { max: 1 });
  try {
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = 'evolu_test' and pid <> pg_backend_pid()`;
    await admin.unsafe("drop database if exists evolu_test");
    await admin.unsafe("create database evolu_test owner evolu_owner");
    await admin.unsafe("revoke all on database evolu_test from public");
    await admin.unsafe("grant connect on database evolu_test to evolu_app, evolu_worker");
  } finally {
    await admin.end();
  }
  const db = createSql(adminUrl.replace(/\/[^/?]+(\?|$)/, "/evolu_test$1"), { max: 1 });
  try {
    await db.unsafe("revoke create on schema public from public");
  } finally {
    await db.end();
  }
  const owner = createSql(migUrl, { max: 1, appName: "evolu-test-setup" });
  try {
    await migrateUp(owner);
    await seedSynthetic(owner, { appMode: "test" });
  } finally {
    await owner.end();
  }
}
