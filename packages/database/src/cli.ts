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
  } else if (cmd === "platform-admin") {
    // Operação de servidor (não é caminho de usuário): designa um operador da plataforma pela
    // identidade do IdP. Uso: platform-admin <issuer> <subject> [e-mail] [nome]
    const [issuer, subject, email, name] = process.argv.slice(3);
    if (!issuer || !subject) throw new Error("uso: platform-admin <issuer> <subject> [e-mail] [nome]");
    await sql.begin(async (tx) => {
      let [u] = await tx<{ user_id: string }[]>`select user_id from app.user_identities where issuer = ${issuer} and subject = ${subject}`;
      if (!u) {
        [u] = await tx<{ user_id: string }[]>`insert into app.users (display_name, email) values (${name ?? "Operador"}, ${email ?? null}) returning id as user_id`;
        await tx`insert into app.user_identities (user_id, issuer, subject) values (${u!.user_id}, ${issuer}, ${subject})`;
      }
      await tx`insert into app.platform_admins (user_id, note) values (${u!.user_id}, 'cli') on conflict do nothing`;
      console.log(`operador da plataforma: ${u!.user_id}`);
    });
  } else {
    console.error(`comando desconhecido: ${cmd} (use up | down [n] | status | platform-admin)`);
    process.exitCode = 2;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
