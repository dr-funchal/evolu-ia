"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useShell } from "@/components/Shell";
import { api } from "@/lib/client";

type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
type Repeat = { freq: "none" } | { freq: "daily"; interval: number } | { freq: "weekly"; interval: number; byDay: Weekday[] };

interface SvcInfo {
  id: string;
  name: string;
  hospitalId: string;
  hospitalName: string;
  timezone: string;
  canDraft: boolean;
  canPublish: boolean;
}
interface Series {
  id: string;
  serviceId: string;
  modality: string;
  assigneeUserId: string;
  startDate: string;
  startTime: string;
  durationMinutes: number;
  repeat: Repeat;
  rrule: string | null;
  untilDate: string | null;
  notes: string | null;
  status: "draft" | "published" | "cancelled";
  version: number;
}
interface Occ {
  seriesId: string;
  serviceId: string;
  modality: string;
  seriesStatus: "draft" | "published";
  timezone: string;
  originalStart: string;
  start: string;
  end: string;
  assigneeUserId: string;
  scheduledUserId: string;
  exception: "cancelled" | "reassigned" | null;
  reason: string | null;
  conflictWith: string[];
}
interface Data {
  timezone: string;
  services: SvcInfo[];
  series: Series[];
  occurrences: Occ[];
  names: Record<string, string>;
}
interface SeriesInput {
  serviceId: string;
  modality: string;
  assigneeUserId: string;
  startDate: string;
  startTime: string;
  durationMinutes: number;
  repeat: Repeat;
  untilDate?: string;
  notes?: string;
}

const MODALITY: Record<string, string> = { visita: "Visita", retaguarda: "Retaguarda", plantao: "Plantão" };
const DAYS: [Weekday, string][] = [
  ["MO", "seg"],
  ["TU", "ter"],
  ["WE", "qua"],
  ["TH", "qui"],
  ["FR", "sex"],
  ["SA", "sáb"],
  ["SU", "dom"],
];

function ymdIn(d: Date, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function hm(iso: string, tz: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
function dayTitle(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "long" }).format(new Date(Date.UTC(y, m - 1, d)));
}
function monthBounds(ym: string) {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` };
}
function shiftMonth(ym: string, n: number) {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function fmtYmd(ymd: string | null) {
  return ymd ? ymd.split("-").reverse().join("/") : "";
}
function durationLabel(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}
function repeatLabel(r: Repeat, until: string | null) {
  let s = "Sem repetição";
  if (r.freq === "daily") s = r.interval === 1 ? "Todo dia" : `A cada ${r.interval} dias`;
  if (r.freq === "weekly") {
    const days = DAYS.filter(([k]) => r.byDay.includes(k))
      .map(([, l]) => l)
      .join(", ");
    s = r.interval === 1 ? `Toda semana (${days})` : `A cada ${r.interval} semanas (${days})`;
  }
  return r.freq !== "none" && until ? `${s}, até ${fmtYmd(until)}` : s;
}

export default function Escala() {
  const { me, ctx } = useShell();
  const tz = ctx.tenant.timezone;
  const [month, setMonth] = useState(() => ymdIn(new Date(), tz).slice(0, 7));
  const [serviceId, setServiceId] = useState("");
  const [mine, setMine] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormMode | null>(null);
  const [swap, setSwap] = useState<Occ | null>(null);

  const load = useCallback(() => {
    setError(null);
    const q = new URLSearchParams(monthBounds(month));
    if (serviceId) q.set("serviceId", serviceId);
    if (mine) q.set("mine", "1");
    api<Data>("GET", `/v1/schedule?${q}`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [month, serviceId, mine]);
  useEffect(load, [load]);

  const svc = useMemo(() => new Map((data?.services ?? []).map((s) => [s.id, s])), [data]);
  const seriesById = useMemo(() => new Map((data?.series ?? []).map((s) => [s.id, s])), [data]);
  const drafters = (data?.services ?? []).filter((s) => s.canDraft);
  const canEdit = (serviceId: string, status: string) => {
    const s = svc.get(serviceId);
    return Boolean(s?.canDraft && (status === "draft" || s.canPublish));
  };
  const name = (id: string) => data?.names[id] ?? "—";

  const act = async (fn: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const days = useMemo(() => {
    const m = new Map<string, Occ[]>();
    for (const o of data?.occurrences ?? []) {
      const k = o.originalStart.slice(0, 10);
      m.set(k, [...(m.get(k) ?? []), o]);
    }
    return [...m.entries()];
  }, [data]);
  const drafts = (data?.series ?? []).filter((s) => s.status === "draft");
  const today = ymdIn(new Date(), tz);
  const monthLabel = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${month}-01T12:00:00Z`));

  return (
    <>
      <div className="row between">
        <h1>Escala</h1>
        <div className="row">
          <button onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Mês anterior">
            ‹
          </button>
          <strong style={{ minWidth: 140, textAlign: "center" }}>{monthLabel}</strong>
          <button onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Próximo mês">
            ›
          </button>
          <button onClick={() => setMonth(today.slice(0, 7))}>Hoje</button>
        </div>
      </div>
      <div className="row" style={{ margin: "8px 0" }}>
        <select aria-label="Serviço" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          <option value="">Todos os serviços</option>
          {data?.services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.hospitalName}
            </option>
          ))}
        </select>
        <label className="small">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> só a minha escala
        </label>
        {drafters.length > 0 && !form && (
          <button className="primary" onClick={() => setForm({ kind: "create" })}>
            Nova escala
          </button>
        )}
      </div>
      {error && <div className="alert bad">{error}</div>}
      {data && data.services.length === 0 && (
        <div className="alert warn">Nenhum hospital/serviço cadastrado nesta instituição. A escala é montada por serviço — cadastre em Administração.</div>
      )}

      {form && data && (
        <SeriesForm
          mode={form}
          services={drafters}
          onCancel={() => setForm(null)}
          onDone={() => {
            setForm(null);
            load();
          }}
        />
      )}

      {drafts.length > 0 && (
        <div className="card">
          <h2>Rascunhos (não publicados)</h2>
          <p className="small muted">Rascunhos só aparecem para quem monta a escala. O profissional é avisado quando a escala é publicada.</p>
          <div className="table-wrap">
            <table>
              <tbody>
                {drafts.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{name(s.assigneeUserId)}</strong> · {MODALITY[s.modality]} · {svc.get(s.serviceId)?.name}
                      <div className="small muted">
                        a partir de {fmtYmd(s.startDate)} {s.startTime} ({durationLabel(s.durationMinutes)}) — {repeatLabel(s.repeat, s.untilDate)}
                      </div>
                    </td>
                    <td className="row" style={{ justifyContent: "flex-end" }}>
                      <button onClick={() => setForm({ kind: "edit", series: s })}>Editar</button>
                      {svc.get(s.serviceId)?.canPublish && (
                        <button className="primary" onClick={() => act(() => api("POST", `/v1/schedule/series/${s.id}/publish`))}>
                          Publicar
                        </button>
                      )}
                      <button className="danger" onClick={() => act(() => api("POST", `/v1/schedule/series/${s.id}/cancel`), "Descartar este rascunho?")}>
                        Descartar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {swap && (
        <SwapDialog
          occ={swap}
          currentName={name(swap.assigneeUserId)}
          onClose={() => setSwap(null)}
          onDone={() => {
            setSwap(null);
            load();
          }}
        />
      )}

      {!data ? (
        <p className="muted">Carregando…</p>
      ) : days.length === 0 ? (
        <p className="muted">Nenhum turno neste mês{mine ? " para você" : ""}.</p>
      ) : (
        days.map(([day, list]) => (
          <div key={day} className="card" style={day === today ? { borderColor: "var(--accent)" } : undefined}>
            <h3 style={{ margin: "0 0 6px", textTransform: "capitalize" }}>
              {dayTitle(day)} {day === today && <span className="badge ok">hoje</span>}
            </h3>
            {list.map((o) => {
              const s = seriesById.get(o.seriesId);
              const editable = canEdit(o.serviceId, o.seriesStatus);
              const service = svc.get(o.serviceId);
              const date = o.originalStart.slice(0, 10);
              return (
                <div
                  key={`${o.seriesId}|${o.originalStart}`}
                  className="row between"
                  style={{ padding: "6px 0", borderTop: "1px solid var(--line)", opacity: o.exception === "cancelled" ? 0.55 : 1 }}
                >
                  <div>
                    <strong style={{ textDecoration: o.exception === "cancelled" ? "line-through" : undefined }}>
                      {hm(o.start, o.timezone)}–{hm(o.end, o.timezone)}
                    </strong>{" "}
                    {MODALITY[o.modality]} · {service?.name} <span className="small muted">({service?.hospitalName})</span>
                    <div>
                      {o.assigneeUserId === me.user.id ? <strong>{name(o.assigneeUserId)} (você)</strong> : name(o.assigneeUserId)}{" "}
                      {o.seriesStatus === "draft" && <span className="badge plain">rascunho</span>}{" "}
                      {o.exception === "cancelled" && <span className="badge bad">cancelado</span>}{" "}
                      {o.exception === "reassigned" && <span className="badge warn">troca · era {name(o.scheduledUserId)}</span>}{" "}
                      {o.conflictWith.length > 0 && <span className="badge bad">conflito de horário</span>}
                      {o.reason && <span className="small muted"> — {o.reason}</span>}
                    </div>
                  </div>
                  {editable && s && (
                    <div className="row">
                      {o.exception ? (
                        <button
                          className="link"
                          onClick={() => act(() => api("PUT", `/v1/schedule/series/${o.seriesId}/exceptions`, { body: { originalStart: o.originalStart, kind: "none" } }))}
                        >
                          Desfazer
                        </button>
                      ) : (
                        <>
                          <button className="link" onClick={() => setSwap(o)}>
                            Trocar
                          </button>
                          <button
                            className="link"
                            onClick={() => {
                              const reason = prompt("Cancelar só este turno. Motivo (opcional):");
                              if (reason === null) return;
                              act(() =>
                                api("PUT", `/v1/schedule/series/${o.seriesId}/exceptions`, {
                                  body: { originalStart: o.originalStart, kind: "cancelled", reason: reason || undefined },
                                }),
                              );
                            }}
                          >
                            Cancelar este
                          </button>
                        </>
                      )}
                      <details className="small">
                        <summary style={{ cursor: "pointer" }}>Série</summary>
                        <div className="stack" style={{ padding: "4px 0" }}>
                          <div className="muted">{repeatLabel(s.repeat, s.untilDate)}</div>
                          <button onClick={() => setForm({ kind: "edit", series: s })}>Editar a série inteira</button>
                          {s.repeat.freq !== "none" && date > s.startDate && (
                            <button onClick={() => setForm({ kind: "split", series: s, fromDate: date })}>Alterar deste turno em diante</button>
                          )}
                          {s.repeat.freq !== "none" && (
                            <button
                              onClick={() =>
                                act(
                                  () => api("POST", `/v1/schedule/series/${s.id}/end`, { body: { lastDate: date } }),
                                  `Encerrar a série após ${fmtYmd(date)}? Os turnos seguintes deixam de existir.`,
                                )
                              }
                            >
                              Encerrar após este turno
                            </button>
                          )}
                          {s.status === "draft" && service?.canPublish && (
                            <button className="primary" onClick={() => act(() => api("POST", `/v1/schedule/series/${s.id}/publish`))}>
                              Publicar
                            </button>
                          )}
                          <button
                            className="danger"
                            onClick={() => act(() => api("POST", `/v1/schedule/series/${s.id}/cancel`), "Cancelar a série inteira (todos os turnos)?")}
                          >
                            Cancelar série
                          </button>
                        </div>
                      </details>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))
      )}
      <p className="small muted">Horários no fuso de cada hospital. Conflito = a mesma pessoa em dois turnos sobrepostos.</p>
    </>
  );
}

type FormMode = { kind: "create" } | { kind: "edit"; series: Series } | { kind: "split"; series: Series; fromDate: string };

function useAssignable(serviceId: string) {
  const [people, setPeople] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    if (!serviceId) return;
    setPeople(null);
    api("GET", `/v1/schedule/assignable?serviceId=${serviceId}`)
      .then((r) => setPeople(r.people))
      .catch(() => setPeople([]));
  }, [serviceId]);
  return people;
}

function SeriesForm({ mode, services, onCancel, onDone }: { mode: FormMode; services: SvcInfo[]; onCancel: () => void; onDone: () => void }) {
  const base = mode.kind === "create" ? null : mode.series;
  const [serviceId, setServiceId] = useState(base?.serviceId ?? services[0]?.id ?? "");
  const [modality, setModality] = useState(base?.modality ?? "visita");
  const [assignee, setAssignee] = useState(base?.assigneeUserId ?? "");
  const [startDate, setStartDate] = useState(mode.kind === "split" ? mode.fromDate : (base?.startDate ?? ""));
  const [startTime, setStartTime] = useState(base?.startTime ?? "07:00");
  const [hours, setHours] = useState(String((base?.durationMinutes ?? 720) / 60));
  const [freq, setFreq] = useState<Repeat["freq"]>(base?.repeat.freq ?? "weekly");
  const [interval, setIntervalN] = useState(String(base && base.repeat.freq !== "none" ? base.repeat.interval : 1));
  const [byDay, setByDay] = useState<Weekday[]>(base?.repeat.freq === "weekly" ? base.repeat.byDay : ["MO"]);
  const [until, setUntil] = useState(base?.untilDate ?? "");
  const [notes, setNotes] = useState(base?.notes ?? "");
  const [preview, setPreview] = useState<{ originalStart: string; start: string; end: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const people = useAssignable(serviceId);

  const input = (): SeriesInput => {
    const n = Number(interval) || 1;
    const repeat: Repeat = freq === "none" ? { freq } : freq === "daily" ? { freq, interval: n } : { freq, interval: n, byDay };
    return {
      serviceId,
      modality,
      assigneeUserId: assignee,
      startDate,
      startTime,
      durationMinutes: Math.round(Number(hours.replace(",", ".")) * 60),
      repeat,
      untilDate: freq !== "none" && until ? until : undefined,
      notes: notes.trim() || undefined,
    };
  };

  useEffect(() => setPreview(null), [serviceId, startDate, startTime, hours, freq, interval, byDay, until]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = () =>
    run(async () => {
      if (mode.kind === "create") await api("POST", "/v1/schedule/series", { body: input() });
      else if (mode.kind === "edit") await api("PATCH", `/v1/schedule/series/${mode.series.id}`, { body: input(), ifMatch: mode.series.version });
      else
        await api("POST", `/v1/schedule/series/${mode.series.id}/split`, {
          body: { fromDate: mode.fromDate, changes: input() },
          ifMatch: mode.series.version,
        });
      onDone();
    });

  const title =
    mode.kind === "create" ? "Nova escala" : mode.kind === "edit" ? "Editar a série inteira" : `Alterar a partir de ${fmtYmd(mode.fromDate)}`;
  const tz = services.find((s) => s.id === serviceId)?.timezone ?? "America/Sao_Paulo";

  return (
    <div className="card">
      <h2>{title}</h2>
      {mode.kind === "edit" && mode.series.status === "published" && (
        <p className="small muted">A mudança vale para todos os turnos da série, inclusive os passados. Para mudar só daqui para a frente, use “Alterar deste turno em diante”.</p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid2">
          <div className="field">
            <label htmlFor="s-svc">Serviço</label>
            <select id="s-svc" value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={{ width: "100%" }}>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.hospitalName}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="s-mod">Modalidade</label>
            <select id="s-mod" value={modality} onChange={(e) => setModality(e.target.value)} style={{ width: "100%" }}>
              {Object.entries(MODALITY).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="s-who">Profissional</label>
            <select id="s-who" required value={assignee} onChange={(e) => setAssignee(e.target.value)} style={{ width: "100%" }}>
              <option value="">{people === null ? "Carregando…" : people.length ? "Escolha…" : "Ninguém com vínculo neste serviço"}</option>
              {people?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field row">
            <div>
              <label htmlFor="s-date">{freq === "none" ? "Data" : "Primeiro dia"}</label>
              <input id="s-date" type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <label htmlFor="s-time">Início</label>
              <input id="s-time" type="time" required value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div>
              <label htmlFor="s-dur">Duração (h)</label>
              <input id="s-dur" inputMode="decimal" required value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 70 }} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="s-freq">Repetição</label>
            <div className="row">
              <select id="s-freq" value={freq} onChange={(e) => setFreq(e.target.value as Repeat["freq"])}>
                <option value="none">Não repete (turno avulso)</option>
                <option value="daily">Diária</option>
                <option value="weekly">Semanal</option>
              </select>
              {freq !== "none" && (
                <label className="small">
                  a cada{" "}
                  <input
                    type="number"
                    min={1}
                    max={freq === "daily" ? 30 : 8}
                    value={interval}
                    onChange={(e) => setIntervalN(e.target.value)}
                    style={{ width: 56 }}
                  />{" "}
                  {freq === "daily" ? "dia(s)" : "semana(s)"}
                </label>
              )}
            </div>
            {freq === "weekly" && (
              <div className="row" style={{ marginTop: 6 }}>
                {DAYS.map(([k, l]) => (
                  <label key={k} className="small">
                    <input
                      type="checkbox"
                      checked={byDay.includes(k)}
                      onChange={(e) => setByDay(e.target.checked ? [...byDay, k] : byDay.filter((d) => d !== k))}
                    />{" "}
                    {l}
                  </label>
                ))}
              </div>
            )}
          </div>
          {freq !== "none" && (
            <div className="field">
              <label htmlFor="s-until">Até (opcional)</label>
              <input id="s-until" type="date" min={startDate} value={until} onChange={(e) => setUntil(e.target.value)} />
              <div className="small muted">Em branco = sem data para terminar.</div>
            </div>
          )}
          <div className="field">
            <label htmlFor="s-notes">Observação (sem dados de paciente)</label>
            <input id="s-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: "100%" }} />
          </div>
        </div>
        {error && <div className="alert bad">{error}</div>}
        {preview && (
          <div className="alert ok">
            <strong>Próximos turnos:</strong>{" "}
            {preview.length === 0
              ? "nenhum"
              : preview
                  .map((p) => {
                    const d = new Date(p.start);
                    const wd = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "short", day: "2-digit", month: "2-digit" }).format(d);
                    return `${wd} ${hm(p.start, tz)}–${hm(p.end, tz)}`;
                  })
                  .join(" · ")}
          </div>
        )}
        <div className="row">
          <button type="button" disabled={busy || !startDate} onClick={() => run(async () => setPreview((await api("POST", "/v1/schedule/preview", { body: input() })).occurrences))}>
            Ver próximos turnos
          </button>
          <button type="submit" className="primary" disabled={busy || !assignee || !startDate}>
            {mode.kind === "create" ? "Salvar rascunho" : "Salvar"}
          </button>
          <button type="button" className="link" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}

function SwapDialog({ occ, currentName, onClose, onDone }: { occ: Occ; currentName: string; onClose: () => void; onDone: () => void }) {
  const people = useAssignable(occ.serviceId);
  const [who, setWho] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="card" style={{ borderColor: "var(--warn)" }}>
      <h2>
        Trocar só o turno de {fmtYmd(occ.originalStart.slice(0, 10))} {hm(occ.start, occ.timezone)}
      </h2>
      <p className="small muted">Hoje com {currentName}. A série continua igual nos outros dias.</p>
      <div className="row">
        <select aria-label="Novo profissional" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Escolha…</option>
          {people
            ?.filter((p) => p.id !== occ.scheduledUserId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <input placeholder="Motivo (opcional)" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        <button
          className="primary"
          disabled={!who}
          onClick={async () => {
            setError(null);
            try {
              await api("PUT", `/v1/schedule/series/${occ.seriesId}/exceptions`, {
                body: { originalStart: occ.originalStart, kind: "reassigned", assigneeUserId: who, reason: reason || undefined },
              });
              onDone();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Trocar
        </button>
        <button className="link" onClick={onClose}>
          Fechar
        </button>
      </div>
      {error && <div className="alert bad">{error}</div>}
    </div>
  );
}

