"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useShell } from "@/components/Shell";
import { api, ApiFailure } from "@/lib/client";
import { fmtDateTime } from "@/lib/format";

interface Report {
  id: string;
  episodeId: string;
  purpose: "paciente" | "cobranca";
  status: "draft" | "issued";
  body: string;
  version: number;
  authorName: string;
  createdAt: string;
  issuedAt: string | null;
  sha256: string | null;
  permissions: { edit: boolean; issue: boolean };
}

/**
 * Relatório da internação. Rascunho da IA → o autor revisa e emite (texto congelado com hash).
 * Não há servidor de e-mail: envio por PDF (imprimir) ou pelo e-mail do próprio médico.
 */
export default function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const { ctx } = useShell();
  const [r, setR] = useState<Report | null>(null);
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const tz = ctx.tenant.timezone;

  const load = useCallback(() => {
    api<Report>("GET", `/v1/reports/${id}`)
      .then((x) => {
        setR(x);
        setBody(x.body);
        setDirty(false);
      })
      .catch((e: Error) => setMsg({ kind: "bad", text: e.message }));
  }, [id]);
  useEffect(load, [load]);

  if (!r) return msg ? <div className="alert bad">{msg.text}</div> : <p className="muted">Carregando…</p>;

  async function save(): Promise<number | null> {
    setBusy(true);
    setMsg(null);
    try {
      const x = await api("PATCH", `/v1/reports/${id}`, { body: { body }, ifMatch: r!.version });
      setR({ ...r!, body, version: x.version });
      setDirty(false);
      setMsg({ kind: "ok", text: "Rascunho salvo." });
      return x.version as number;
    } catch (e) {
      setMsg({ kind: "bad", text: e instanceof ApiFailure && e.code === "version_conflict" ? "Alterado em outra sessão. Recarregue." : (e as Error).message });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function issue() {
    if (!confirm("Emitir o relatório? O texto ficará congelado; para mudar, gere um novo.")) return;
    const version = dirty ? await save() : r!.version;
    if (version == null) return;
    setBusy(true);
    try {
      await api("POST", `/v1/reports/${id}/issue`, { ifMatch: version });
      load();
      setMsg({ kind: "ok", text: "Relatório emitido. Agora você pode imprimir/salvar em PDF ou enviar por e-mail." });
    } catch (e) {
      setMsg({ kind: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const subject = r.purpose === "paciente" ? "Relatório de acompanhamento durante a internação" : "Relatório de acompanhamento — honorários médicos";
  // mailto tem limite prático de tamanho: acima disso, o texto vai para a área de transferência para colar.
  const mailBody = r.body.length <= 1800 ? r.body : "Segue o relatório (colado abaixo ou em anexo em PDF).\n\n";
  const copy = () =>
    navigator.clipboard.writeText(r.body).then(
      () => setMsg({ kind: "ok", text: "Texto copiado." }),
      () => setMsg({ kind: "bad", text: "Não foi possível copiar." }),
    );

  return (
    <>
      <p className="small no-print">
        <Link href={`/episodios/${r.episodeId}`}>← voltar ao paciente</Link>
      </p>
      <div className="card no-print">
        <div className="row between">
          <h1 style={{ margin: 0 }}>Relatório {r.purpose === "paciente" ? "para o paciente" : "para cobrança"}</h1>
          <span className={`badge ${r.status === "issued" ? "ok" : "warn"}`}>{r.status === "issued" ? "emitido" : "rascunho"}</span>
        </div>
        <p className="muted small">
          {r.authorName} · criado {fmtDateTime(r.createdAt, tz)}
          {r.issuedAt && ` · emitido ${fmtDateTime(r.issuedAt, tz)}`}
          {r.sha256 && (
            <>
              {" "}
              · SHA-256 <code>{r.sha256.slice(0, 16)}…</code>
            </>
          )}
        </p>
        {r.status === "draft" && (
          <div className="alert warn small">
            Rascunho redigido pela IA. Confira cada informação com as evoluções antes de emitir — a IA pode errar ou omitir.
          </div>
        )}
      </div>

      {r.permissions.edit ? (
        <div className="card no-print">
          <textarea
            aria-label="Texto do relatório"
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setDirty(true);
            }}
            style={{ minHeight: 480, fontFamily: "inherit" }}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button disabled={busy || !dirty} onClick={() => void save()}>
              Salvar rascunho
            </button>
            {r.permissions.issue ? (
              <button className="primary" disabled={busy} onClick={() => void issue()}>
                Emitir relatório
              </button>
            ) : (
              <span className="muted small">Seu papel não permite emitir; peça a um médico assistente.</span>
            )}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="print-body">{r.body}</div>
        </div>
      )}

      {msg && <div className={`alert ${msg.kind} no-print`}>{msg.text}</div>}

      {r.status === "issued" && (
        <div className="card no-print">
          <h2 style={{ marginTop: 0 }}>Enviar</h2>
          <div className="row">
            <button className="primary" onClick={() => window.print()}>
              Imprimir / salvar PDF
            </button>
            <button onClick={() => void copy()}>Copiar texto</button>
            <a
              className="button"
              href={`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailBody)}`}
              onClick={() => r.body.length > 1800 && void copy()}
            >
              Abrir no meu e-mail
            </a>
          </div>
          <p className="muted small">
            O envio sai do seu e-mail, para o endereço que você escolher. Relatórios longos: o texto é copiado para colar, ou anexe o PDF.
          </p>
        </div>
      )}
    </>
  );
}
