import { createSql } from "./client";
import { migrateDown, migrateUp, migrationStatus } from "./migrate";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL não definido (papel dono do schema, só para migrations).");
  process.exit(2);
}
const sql = createSql(url, { max: 1, appName: "evolu-migrate" });
const [cmd = "status", arg] = process.argv.slice(2);
try {
  if (cmd === "up") {
    const ran = await migrateUp(sql);
    console.log(ran.length ? `aplicadas: ${ran.join(", ")}` : "nada a aplicar");
  } else if (cmd === "down") {
    const reverted = await migrateDown(sql, Number(arg ?? 1));
    console.log(`revertidas: ${reverted.join(", ") || "nenhuma"}`);
  } else if (cmd === "status") {
    for (const s of await migrationStatus(sql)) {
      console.log(`${s.applied ? "[x]" : "[ ]"} ${s.id}${s.checksumOk ? "" : "  ← CHECKSUM DIVERGENTE"}`);
    }
  } else {
    console.error(`comando desconhecido: ${cmd} (use up | down [n] | status)`);
    process.exitCode = 2;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
