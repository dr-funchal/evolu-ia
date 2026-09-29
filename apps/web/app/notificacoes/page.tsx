"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useShell } from "@/components/Shell";
import { api } from "@/lib/client";
import { fmtDateTime } from "@/lib/format";

interface N {
  id: string;
  kind: string;
  generic_text: string;
  link_path: string | null;
  status: string;
  created_at: string;
  read_at: string | null;
}

/** Avisos sem conteúdo clínico: o texto é genérico e o detalhe só aparece após login e checagem de escopo. */
export default function Notificacoes() {
  const { ctx, refresh } = useShell();
  const [rows, setRows] = useState<N[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api("GET", "/v1/notifications")
      .then((r) => setRows(r.notifications))
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function read(n: N) {
    if (n.read_at) return;
    await api("POST", `/v1/notifications/${n.id}/read`).catch(() => undefined);
    load();
    refresh();
  }

  if (error) return <div className="alert bad">{error}</div>;
  if (!rows) return <p className="muted">Carregando…</p>;
  return (
    <>
      <h1>Avisos</h1>
      {rows.length === 0 && <div className="card muted">Nenhum aviso.</div>}
      {rows.map((n) => (
        <div key={n.id} className="card row between" style={{ opacity: n.read_at ? 0.6 : 1 }}>
          <div>
            <div>{n.generic_text}</div>
            <div className="muted small">{fmtDateTime(n.created_at, ctx.tenant.timezone)}</div>
          </div>
          <div className="row">
            {n.link_path && n.link_path.startsWith("/") && (
              <Link href={n.link_path} onClick={() => void read(n)}>
                Abrir
              </Link>
            )}
            {!n.read_at && (
              <button className="link" onClick={() => void read(n)}>
                Marcar como lido
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
