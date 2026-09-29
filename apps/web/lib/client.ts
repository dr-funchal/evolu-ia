"use client";

/** Erro de API com o código estável devolvido pelo servidor. */
export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const TENANT_KEY = "evolu.tenant";

export function storedTenant(): string | null {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}
export function storeTenant(id: string) {
  try {
    localStorage.setItem(TENANT_KEY, id);
  } catch {
    /* preferência local apenas */
  }
}

let currentTenant: string | null = null;
export function setActiveTenant(id: string | null) {
  currentTenant = id;
}

export interface ReqOpts {
  body?: unknown;
  form?: FormData;
  ifMatch?: number;
  idempotencyKey?: string;
  tenant?: boolean;
}

// Respostas sem tipo explícito ficam como any de propósito: as páginas declaram a forma que consomem.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(method: string, path: string, opts: ReqOpts = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.tenant !== false && currentTenant) headers["x-tenant-id"] = currentTenant;
  if (opts.ifMatch !== undefined) headers["if-match"] = String(opts.ifMatch);
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body, credentials: "same-origin", cache: "no-store" });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiFailure(res.status, e.code ?? "error", e.message ?? `Erro ${res.status}`, e.details);
  }
  return data as T;
}

export const newKey = () => crypto.randomUUID();
