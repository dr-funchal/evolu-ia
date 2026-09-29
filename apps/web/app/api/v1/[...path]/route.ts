import { handleApi } from "@evolu/api";

// Toda a API vive em @evolu/api (agnóstica de framework e testada contra PostgreSQL real);
// aqui só delegamos. Nada é cacheado: respostas são por usuário e por escopo.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = (req: Request) => handleApi(req);
export { handler as GET, handler as POST, handler as PATCH, handler as PUT, handler as DELETE };
