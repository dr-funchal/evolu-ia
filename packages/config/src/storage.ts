import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

/**
 * Armazenamento de objetos em disco local (volume privado, fora da raiz web). Chaves são geradas
 * pelo servidor (`<prefixo>/<tenant>/<uuid>`); nunca aceitamos nome de arquivo do cliente.
 * O acesso é sempre mediado pela API (proxy autenticado), nunca por URL pública.
 */
const KEY_RE = /^[a-z_]+\/[0-9a-f-]{36}\/[0-9a-f-]{36}(\.[a-z0-9]{1,5})?$/;

export function storagePath(key: string): string {
  if (!KEY_RE.test(key)) throw new Error("storage_key_invalid");
  const root = path.resolve(env().STORAGE_DIR);
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error("storage_key_invalid");
  return full;
}

export async function putObject(key: string, data: Uint8Array | string): Promise<void> {
  const full = storagePath(key);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, full);
}

export async function getObject(key: string): Promise<Buffer> {
  return readFile(storagePath(key));
}
