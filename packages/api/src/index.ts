// Registro das rotas (efeito colateral de import) — ordem irrelevante.
import "./routes/me";
import "./routes/census";
import "./routes/notes";
import "./routes/tasks";
import "./routes/handoffs";
import "./routes/documents";
import "./routes/coordination";
import "./routes/admin";

export { handleApi } from "./router";
export { handleAuth } from "./auth";
export { appSql, closeAppSql } from "./context";
export { createSession, hashToken, cookieName, type Session } from "./session";
export { sniffMime } from "./routes/documents";
