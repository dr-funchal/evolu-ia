import { env, logger } from "@evolu/config";
import { createSql } from "@evolu/database";
import { processJobsOnce, processOutboxOnce } from "./index";

const url = env().WORKER_DATABASE_URL;
if (!url) throw new Error("WORKER_DATABASE_URL não definido");
const sql = createSql(url, { max: 3, appName: "evolu-worker" });
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
  });
}

logger.info({ mode: env().APP_MODE }, "worker_start");
while (!stopping) {
  try {
    const a = await processOutboxOnce(sql);
    const b = await processJobsOnce(sql);
    if (a + b === 0) await new Promise((r) => setTimeout(r, 2000));
  } catch (e) {
    logger.error({ errName: (e as Error).name, errCode: (e as { code?: string }).code }, "worker_loop_error");
    await new Promise((r) => setTimeout(r, 5000));
  }
}
await sql.end();
logger.info({}, "worker_stop");
