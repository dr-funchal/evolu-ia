import { createHash, randomUUID } from "node:crypto";
import { env, getObject, putObject } from "@evolu/config";
import { ApiError, badRequest, json, notFound } from "../http";
import { audit, emitOutbox, requireCap, tenantTx, uuidParam, type Ctx } from "../context";
import { route } from "../router";
import { loadEpisode, type EpisodeScope } from "../scope";

const KINDS = ["laudo", "exame", "documento", "outro"] as const;

/** Tipo real pelo conteúdo (assinatura), nunca pela extensão ou content-type enviados. */
export function sniffMime(b: Uint8Array): "application/pdf" | "image/png" | "image/jpeg" | null {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "application/pdf";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

export interface StoredDocument {
  id: string;
  mimeType: NonNullable<ReturnType<typeof sniffMime>>;
  sizeBytes: number;
  sha256: string;
  bytes: Uint8Array;
}

/**
 * Lê o multipart (campo 'file'), valida tipo real e tamanho, grava no armazenamento privado e
 * registra o documento. Quem chama já autorizou antes de o corpo ser lido; aqui reautorizamos na
 * transação de gravação (vínculo pode ter sido revogado durante o envio).
 */
export async function storeUploadedDocument(ctx: Ctx, ep: EpisodeScope, defaultKind: (typeof KINDS)[number] = "documento"): Promise<StoredDocument> {
  const max = env().UPLOAD_MAX_BYTES;
  let form: FormData;
  try {
    form = await ctx.req.formData();
  } catch {
    throw badRequest("invalid_form", "Envie multipart/form-data com o campo 'file'.");
  }
  const file = form.get("file");
  const kind = String(form.get("kind") ?? defaultKind);
  if (!(file instanceof Blob)) throw badRequest("file_required", "Arquivo ausente.");
  if (!(KINDS as readonly string[]).includes(kind)) throw badRequest("invalid_kind", "Tipo de documento inválido.");
  if (file.size === 0) throw badRequest("empty_file", "Arquivo vazio.");
  if (file.size > max) throw new ApiError(413, "file_too_large", "Arquivo acima do limite.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime) throw new ApiError(415, "unsupported_type", "Aceitamos apenas PDF, PNG ou JPEG.");
  const id = randomUUID();
  const storageKey = `documents/${ctx.tenantId}/${id}`;
  const sha = createHash("sha256").update(bytes).digest("hex");
  await putObject(storageKey, bytes);
  await tenantTx(ctx, async (tx) => {
    await requireCap(ctx, tx, ep.service_id, "document.upload", { type: "service_episode", id: ep.id });
    await tx`insert into app.source_documents (id, tenant_id, hospital_id, service_id, encounter_id, service_episode_id, uploaded_by, kind,
               storage_key, mime_type, size_bytes, sha256, status)
             values (${id}, ${ctx.tenantId}, ${ep.hospital_id}, ${ep.service_id}, ${ep.encounter_id}, ${ep.id}, ${ctx.session.userId},
                     ${kind}, ${storageKey}, ${mime}, ${bytes.length}, ${sha}, 'available')`;
    await audit(tx, ctx, "document.upload", "source_document", id);
    await emitOutbox(tx, ctx, "document.uploaded", "source_document", id, { serviceId: ep.service_id, episodeId: ep.id });
  });
  return { id, mimeType: mime, sizeBytes: bytes.length, sha256: sha, bytes };
}

export function rejectOversized(ctx: Ctx, max: number) {
  const declared = Number(ctx.req.headers.get("content-length") ?? "0");
  if (declared > max + 64 * 1024) throw new ApiError(413, "file_too_large", "Arquivo acima do limite.");
}

route("POST", "/v1/episodes/:id/documents", async (ctx) => {
  const episodeId = uuidParam(ctx);
  rejectOversized(ctx, env().UPLOAD_MAX_BYTES);
  // Autoriza ANTES de ler o corpo.
  const ep = await tenantTx(ctx, async (tx) => {
    const ep = await loadEpisode(tx, episodeId);
    await requireCap(ctx, tx, ep.service_id, "document.upload", { type: "service_episode", id: episodeId });
    return ep;
  });
  const d = await storeUploadedDocument(ctx, ep);
  return json({ id: d.id, mimeType: d.mimeType, sizeBytes: d.sizeBytes, sha256: d.sha256 }, 201);
});

/** Download mediado: RLS decide; a chave de armazenamento nunca é exposta ao cliente. */
route("GET", "/v1/documents/:id/content", async (ctx) => {
  const id = uuidParam(ctx);
  const doc = await tenantTx(ctx, async (tx) => {
    const [d] = await tx<{ storage_key: string; mime_type: string; status: string }[]>`
      select storage_key, mime_type, status from app.source_documents where id = ${id}`;
    if (!d || d.status !== "available") throw notFound();
    await audit(tx, ctx, "document.read", "source_document", id);
    return d;
  });
  const data = await getObject(doc.storage_key).catch(() => {
    throw new ApiError(410, "document_missing", "Arquivo indisponível.");
  });
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": doc.mime_type,
      "content-disposition": `attachment; filename="documento-${id.slice(0, 8)}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
});
