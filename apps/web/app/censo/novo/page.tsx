"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useShell } from "@/components/Shell";
import { api, ApiFailure, newKey } from "@/lib/client";
import { fmtDate, fromLocalInput, toLocalInput } from "@/lib/format";

export default function NovoPaciente() {
  const { service, can, ctx } = useShell();
  const aiOn = ctx.tenant.modules.ai && can("patient.basic.write");
  const router = useRouter();
  const tz = service?.timezone ?? "America/Sao_Paulo";
  const [f, setF] = useState({
    fullName: "",
    birthDate: "",
    sex: "nao_informado",
    mrn: "",
    location: "",
    admittedAt: toLocalInput(new Date(), tz),
    priority: "",
    reason: "",
    requesterText: "",
  });
  const [dups, setDups] = useState<{ patientId: string; initials: string | null; birthDate: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  const [key] = useState(newKey);
  if (!service) return null;
  const clinical = can("clinical.write");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(opts: { confirmNotDuplicate?: boolean; patientId?: string } = {}) {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        hospitalId: service!.hospitalId,
        serviceId: service!.id,
        admittedAt: fromLocalInput(f.admittedAt, tz),
        requestedAt: new Date().toISOString(),
        mrn: f.mrn || undefined,
        location: f.location || undefined,
        requesterText: f.requesterText || undefined,
        confirmNotDuplicate: opts.confirmNotDuplicate ?? false,
      };
      if (opts.patientId) body.patientId = opts.patientId;
      else
        body.patient = {
          fullName: f.fullName,
          birthDate: f.birthDate || undefined,
          sex: f.sex,
          identifiers: f.mrn ? [{ system: "prontuario", value: f.mrn }] : [],
        };
      if (clinical) {
        if (f.reason) body.reason = f.reason;
        if (f.priority) body.priority = f.priority;
      }
      const r = await api("POST", "/v1/encounters", { body, idempotencyKey: `${key}-${opts.patientId ?? (opts.confirmNotDuplicate ? "nd" : "n")}` });
      router.push(`/episodios/${r.episodeId}`);
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "possible_duplicate") setDups(e.details as typeof dups);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function fromPhoto(file: File) {
    setReading(true);
    setError(null);
    setPhotoMsg(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const r = await api<{ legivel: boolean; fullName?: string | null; birthDate?: string | null; location?: string | null; mrn?: string | null; sex?: string | null }>(
        "POST",
        `/v1/ai/services/${service!.id}/patient-photo`,
        { form },
      );
      if (!r.legivel) {
        setPhotoMsg("Não consegui ler a foto. Tente com mais luz e mais perto da etiqueta, ou digite os dados.");
        return;
      }
      setF((cur) => ({
        ...cur,
        fullName: r.fullName ?? cur.fullName,
        birthDate: r.birthDate ?? cur.birthDate,
        location: r.location ?? cur.location,
        mrn: r.mrn ?? cur.mrn,
        sex: r.sex ?? cur.sex,
      }));
      const missing = [!r.fullName && "nome", !r.birthDate && "nascimento", !r.location && "leito"].filter(Boolean);
      setPhotoMsg(`Dados lidos da foto — confira antes de incluir.${missing.length ? ` Não encontrei: ${missing.join(", ")}.` : ""}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-head">
        <div>
          <h1>Incluir paciente</h1>
          <div className="muted small">{service.name}</div>
        </div>
      </div>
      <div className="card">
        {aiOn && (
          <>
            <label className={`button primary block ${reading ? "disabled" : ""}`}>
              {reading ? "Lendo a foto…" : "📷 Foto da etiqueta, pulseira ou folha de rosto"}
              <input
                type="file"
                accept="image/jpeg,image/png,application/pdf"
                capture="environment"
                hidden
                disabled={reading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void fromPhoto(file);
                }}
              />
            </label>
            <p className="muted small" style={{ textAlign: "center" }}>
              A IA lê nome, nascimento e leito. A foto não é guardada. Ou preencha abaixo.
            </p>
            {photoMsg && <div className="alert warn">{photoMsg}</div>}
          </>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="field">
            <label htmlFor="n">Nome completo</label>
            <input id="n" required value={f.fullName} onChange={set("fullName")} autoComplete="off" />
          </div>
          <div className="grid2">
            <div className="field">
              <label htmlFor="b">Data de nascimento</label>
              <input id="b" type="date" value={f.birthDate} onChange={set("birthDate")} />
            </div>
            <div className="field">
              <label htmlFor="l">Leito</label>
              <input id="l" value={f.location} onChange={set("location")} placeholder="ex.: UTI 2 - leito 07" />
            </div>
          </div>
          <details className="more">
            <summary>Mais dados (opcional)</summary>
            <div className="grid2">
              <div className="field">
                <label htmlFor="s">Sexo</label>
                <select id="s" value={f.sex} onChange={set("sex")}>
                  <option value="nao_informado">não informado</option>
                  <option value="feminino">feminino</option>
                  <option value="masculino">masculino</option>
                  <option value="intersexo">intersexo</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="m">Prontuário / atendimento</label>
                <input id="m" value={f.mrn} onChange={set("mrn")} />
              </div>
              <div className="field">
                <label htmlFor="a">Admissão ({tz})</label>
                <input id="a" type="datetime-local" required value={f.admittedAt} onChange={set("admittedAt")} />
              </div>
              <div className="field">
                <label htmlFor="r">Solicitante</label>
                <input id="r" value={f.requesterText} onChange={set("requesterText")} placeholder="ex.: equipe da UTI" />
              </div>
              {clinical && (
                <div className="field">
                  <label htmlFor="p">Prioridade</label>
                  <select id="p" value={f.priority} onChange={set("priority")}>
                    <option value="">—</option>
                    <option value="rotina">rotina</option>
                    <option value="prioritaria">prioritária</option>
                    <option value="urgente">urgente</option>
                  </select>
                </div>
              )}
            </div>
            {clinical && (
              <div className="field">
                <label htmlFor="reason">Motivo do acompanhamento</label>
                <textarea id="reason" value={f.reason} onChange={set("reason")} />
              </div>
            )}
          </details>
          <p className="muted small">
            {clinical
              ? "O acompanhamento começa ativo e você entra na equipe responsável."
              : "Sem permissão clínica: a inclusão fica como solicitação até a equipe médica aceitar."}
          </p>
          {error && <div className="alert bad">{error}</div>}
          {dups && (
            <div className="alert warn">
              <strong>Possível duplicidade.</strong> Já existe paciente com este nome nesta instituição:
              <ul>
                {dups.map((d) => (
                  <li key={d.patientId}>
                    {d.initials ?? "?"} · nasc. {fmtDate(d.birthDate)}{" "}
                    <button type="button" disabled={busy} onClick={() => void submit({ patientId: d.patientId })}>
                      É a mesma pessoa — usar este cadastro
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" disabled={busy} onClick={() => void submit({ confirmNotDuplicate: true })}>
                Não é a mesma pessoa — criar novo cadastro
              </button>
            </div>
          )}
          <div className="action-bar">
            <button type="button" onClick={() => router.back()}>
              Cancelar
            </button>
            <button className="primary" disabled={busy || reading} type="submit">
              Incluir paciente
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
