import { createSql, seedSynthetic } from "@evolu/database";

// Seed sintético (dev/test/demo). Usa o papel dono (MIGRATION_DATABASE_URL); recusa production.
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL não definido");
  process.exit(2);
}
if (process.env.APP_MODE === "production") {
  console.error("Seed sintético recusado em APP_MODE=production.");
  process.exit(3);
}
const sql = createSql(url, { max: 1, appName: "evolu-seed" });
try {
  await seedSynthetic(sql);
  console.log("seed sintético aplicado");
} finally {
  await sql.end();
}
