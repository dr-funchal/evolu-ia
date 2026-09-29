import { handleAuth } from "@evolu/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = (req: Request) => handleAuth(req);
export { handler as GET, handler as POST };
