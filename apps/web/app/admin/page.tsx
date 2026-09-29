"use client";

import { useCallback, useEffect, useState } from "react";
import { InviteResult, TimezoneSelect } from "@/components/Admin";
import { useShell } from "@/components/Shell";
import { api } from "@/lib/client";
import { fmtDateTime } from "@/lib/format";

interface Hospital {
  id: string;
  name: string;
  timezone: string;
  active: boolean;
}
interface ServiceRow {
  id: string;
  name: string;
  active: boolean;
  hospitalId: string;
  specialty: string;
}
interface GrantRow {
  id: string;
  role: string;
  roleLabel: string;
  hospitalId: string | null;
  serviceId: string | null;
}
interface Member {
  userId: string;
  displayName: string;
  email: string | null;
  status: string;
  invitedAt: string | null;
  firstLoginAt: string | null;
  isSelf: boolean;
  grants: GrantRow[];
}
interface Overview {
  tenant: { id: string; name: string; timezone: string; modules: { handoffs: boolean } };
  hospitals: Hospital[];
  services: ServiceRow[];
  specialties: string[];
  roles: { id: string; label: string }[];
  members: Member[];
}
interface GrantDraft {
  role: string;
  scope: string;
}
type InviteState = { invite: { link: string | null; sentByEmail: boolean } | null; existing: boolean; email?: string; userId?: string };

const TENANT_WIDE = new Set(["tenant_admin", "finance"]);

function scopeToBody(g: GrantDraft) {
  if (!g.scope) return { role: g.role };
  const [kind, hospitalId, serviceId] = g.scope.split(":");
  return kind === "s" ? { role: g.role, hospitalId, serviceId } : { role: g.role, hospitalId };
}

function GrantFields({ value, onChange, data }: { value: GrantDraft; onChange: (g: GrantDraft) => void; data: Overview }) {
  const tenantWide = TENANT_WIDE.has(value.role);
  return (
    <div className="row">
      <select aria-label="Papel" value={value.role} onChange={(e) => onChange({ role: e.target.value, scope: TENANT_WIDE.has(e.target.value) ? "" : value.scope })}>
        {data.roles.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
      </select>
      <select aria-label="Escopo" value={value.scope} disabled={tenantWide} onChange={(e) => onChange({ ...value, scope: e.target.value })}>
        <option value="">Equipe inteira</option>
        {data.hospitals
          .filter((h) => h.active)
          .map((h) => (
            <optgroup key={h.id} label={h.name}>
              <option value={`h:${h.id}`}>{h.name} — todos os serviços</option>
              {data.services
                .filter((s) => s.hospitalId === h.id && s.active)
                .map((s) => (
                  <option key={s.id} value={`s:${h.id}:${s.id}`}>
                    {s.name}
                  </option>
                ))}
            </optgroup>
          ))}
      </select>
    </div>
  );
}

export default function Admin() {
  const { ctx, refresh } = useShell();
  const allowed = ctx.tenantCapabilities.includes("org.manage");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Overview>("GET", "/v1/admin/overview")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (allowed) load();
  }, [allowed, load, ctx.tenant.id]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setError(null);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      load();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!allowed) return <div className="alert warn">Seu vínculo não inclui a administração desta equipe.</div>;
  if (!data) return error ? <div className="alert bad">{error}</div> : <p className="muted">Carregando…</p>;

  const scopeLabel = (g: GrantRow) => {
    if (g.serviceId) {
      const s = data.services.find((x) => x.id === g.serviceId);
      const h = data.hospitals.find((x) => x.id === g.hospitalId);
      return `${s?.name ?? "serviço"}${h ? ` · ${h.name}` : ""}`;
    }
    if (g.hospitalId) return data.hospitals.find((x) => x.id === g.hospitalId)?.name ?? "hospital";
    return "equipe inteira";
  };

  return (
    <>
      <h1>Administração — {data.tenant.name}</h1>
      {error && <div className="alert bad">{error}</div>}
      {msg && <div className="alert ok">{msg}</div>}
      {data.hospitals.length === 0 && (
        <div className="alert warn small">
          Comece cadastrando um hospital e um serviço. Depois convide a equipe e dê a você mesmo um papel clínico (por exemplo,
          coordenador clínico no serviço) — o papel de administrador sozinho não dá acesso a pacientes.
        </div>
      )}
      <TenantCard data={data} run={run} />
      <HospitalsCard data={data} run={run} />
      <ServicesCard data={data} run={run} />
      <MembersCard data={data} run={run} scopeLabel={scopeLabel} />
    </>
  );
}

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function TenantCard({ data, run }: { data: Overview; run: Run }) {
  const [name, setName] = useState(data.tenant.name);
  const [tz, setTz] = useState(data.tenant.timezone);
  const dirty = name !== data.tenant.name || tz !== data.tenant.timezone;
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Equipe</h2>
      <div className="row">
        <input aria-label="Nome da equipe" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} style={{ minWidth: 260 }} />
        <TimezoneSelect value={tz} onChange={setTz} />
        <button disabled={!dirty || !name.trim()} onClick={() => run(() => api("PATCH", "/v1/admin/tenant", { body: { name, timezone: tz } }), "Equipe atualizada.")}>
          Salvar
        </button>
      </div>
      <h3>Módulos</h3>
      <label className="row">
        <input
          type="checkbox"
          checked={data.tenant.modules.handoffs}
          onChange={(e) => {
            const on = e.target.checked;
            if (!on && !confirm("Desabilitar Passagens? O menu e as ações de passagem somem para toda a equipe. Nada é apagado: ao reabilitar, o histórico volta.")) return;
            void run(() => api("PATCH", "/v1/admin/tenant", { body: { handoffsEnabled: on } }), on ? "Passagens habilitadas." : "Passagens desabilitadas.");
          }}
        />
        <span>
          <strong>Passagens de caso</strong>
          <span className="small muted"> — passagem de plantão (I-PASS) entre médicos, com aceite.</span>
        </span>
      </label>
    </div>
  );
}

function HospitalsCard({ data, run }: { data: Overview; run: Run }) {
  const [name, setName] = useState("");
  const [tz, setTz] = useState(data.tenant.timezone);
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Hospitais</h2>
      {data.hospitals.length > 0 && (
        <div className="table-wrap">
          <table>
            <tbody>
              {data.hospitals.map((h) => (
                <tr key={h.id}>
                  <td>
                    {h.name} {!h.active && <span className="badge plain">desativado</span>}
                  </td>
                  <td className="small muted">{h.timezone}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="link"
                      onClick={() => {
                        const n = prompt("Novo nome do hospital", h.name)?.trim();
                        if (n && n !== h.name) void run(() => api("PATCH", `/v1/admin/hospitals/${h.id}`, { body: { name: n } }), "Hospital renomeado.");
                      }}
                    >
                      renomear
                    </button>{" "}
                    ·{" "}
                    <button className="link" onClick={() => run(() => api("PATCH", `/v1/admin/hospitals/${h.id}`, { body: { active: !h.active } }))}>
                      {h.active ? "desativar" : "reativar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form
        className="row"
        style={{ marginTop: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("POST", "/v1/admin/hospitals", { body: { name, timezone: tz } });
            setName("");
          }, "Hospital cadastrado.");
        }}
      >
        <input required aria-label="Nome do hospital" placeholder="Nome do hospital" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} style={{ minWidth: 240 }} />
        <TimezoneSelect value={tz} onChange={setTz} />
        <button className="primary">Adicionar hospital</button>
      </form>
    </div>
  );
}

function ServicesCard({ data, run }: { data: Overview; run: Run }) {
  const active = data.hospitals.filter((h) => h.active);
  const [hospitalId, setHospitalId] = useState(active[0]?.id ?? "");
  const [name, setName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const hid = active.some((h) => h.id === hospitalId) ? hospitalId : (active[0]?.id ?? "");
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Serviços</h2>
      <p className="muted small">Serviço é a unidade de trabalho da equipe num hospital (ex.: Neurologia — enfermaria, Interconsulta). O censo, as passagens e os acessos são por serviço.</p>
      {data.services.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Serviço</th>
                <th>Hospital</th>
                <th>Especialidade</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.services.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.name} {!s.active && <span className="badge plain">desativado</span>}
                  </td>
                  <td className="small">{data.hospitals.find((h) => h.id === s.hospitalId)?.name}</td>
                  <td className="small">{s.specialty}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="link"
                      onClick={() => {
                        const n = prompt("Novo nome do serviço", s.name)?.trim();
                        if (n && n !== s.name) void run(() => api("PATCH", `/v1/admin/services/${s.id}`, { body: { name: n } }), "Serviço renomeado.");
                      }}
                    >
                      renomear
                    </button>{" "}
                    ·{" "}
                    <button className="link" onClick={() => run(() => api("PATCH", `/v1/admin/services/${s.id}`, { body: { active: !s.active } }))}>
                      {s.active ? "desativar" : "reativar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {active.length === 0 ? (
        <p className="muted small">Cadastre um hospital primeiro.</p>
      ) : (
        <form
          className="row"
          style={{ marginTop: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("POST", "/v1/admin/services", { body: { hospitalId: hid, name, specialty } });
              setName("");
            }, "Serviço cadastrado.");
          }}
        >
          <select aria-label="Hospital" value={hid} onChange={(e) => setHospitalId(e.target.value)}>
            {active.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
          <input required aria-label="Nome do serviço" placeholder="Nome do serviço" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          <input required aria-label="Especialidade" placeholder="Especialidade" list="especialidades" maxLength={120} value={specialty} onChange={(e) => setSpecialty(e.target.value)} />
          <datalist id="especialidades">
            {data.specialties.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <button className="primary">Adicionar serviço</button>
        </form>
      )}
    </div>
  );
}

function MembersCard({ data, run, scopeLabel }: { data: Overview; run: Run; scopeLabel: (g: GrantRow) => string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [grants, setGrants] = useState<GrantDraft[]>([{ role: "attending_physician", scope: "" }]);
  const [invite, setInvite] = useState<InviteState | null>(null);
  const [adding, setAdding] = useState<{ userId: string; g: GrantDraft } | null>(null);

  const status = (m: Member) =>
    m.status !== "active" ? (
      <span className="badge bad">{m.status === "suspended" ? "suspenso" : "revogado"}</span>
    ) : m.firstLoginAt ? (
      <span className="badge ok">ativo</span>
    ) : (
      <span className="badge warn">convite pendente</span>
    );

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Membros</h2>
      <p className="muted small">
        Cada papel vale num escopo: a equipe inteira, um hospital ou um serviço. Médicos e secretárias só veem pacientes dos serviços em
        que têm papel.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Pessoa</th>
              <th>Situação</th>
              <th>Papéis</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.userId}>
                <td>
                  {m.displayName}
                  {m.isSelf && <span className="muted small"> (você)</span>}
                  <div className="muted small">{m.email}</div>
                </td>
                <td>
                  {status(m)}
                  {m.firstLoginAt && <div className="muted small">desde {fmtDateTime(m.firstLoginAt, data.tenant.timezone)}</div>}
                </td>
                <td>
                  {m.grants.length === 0 && <span className="muted small">sem papel</span>}
                  {m.grants.map((g) => (
                    <div key={g.id} className="small">
                      {g.roleLabel} · <span className="muted">{scopeLabel(g)}</span>{" "}
                      <button
                        className="link"
                        title="Revogar este papel"
                        onClick={() => {
                          if (confirm(`Revogar "${g.roleLabel}" de ${m.displayName}?`)) void run(() => api("POST", `/v1/admin/grants/${g.id}/revoke`), "Papel revogado.");
                        }}
                      >
                        revogar
                      </button>
                    </div>
                  ))}
                  {adding?.userId === m.userId ? (
                    <form
                      style={{ marginTop: 6 }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(async () => {
                          await api("POST", `/v1/admin/members/${m.userId}/grants`, { body: scopeToBody(adding.g) });
                          setAdding(null);
                        }, "Papel concedido.");
                      }}
                    >
                      <GrantFields value={adding.g} onChange={(g) => setAdding({ userId: m.userId, g })} data={data} />
                      <div className="row" style={{ marginTop: 4 }}>
                        <button className="primary">Conceder</button>
                        <button type="button" onClick={() => setAdding(null)}>
                          Cancelar
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button className="link small" onClick={() => setAdding({ userId: m.userId, g: { role: "attending_physician", scope: "" } })}>
                      + papel
                    </button>
                  )}
                </td>
                <td style={{ textAlign: "right" }} className="small">
                  {m.status === "active" && !m.firstLoginAt && (
                    <>
                      <button
                        className="link"
                        onClick={() =>
                          run(async () => {
                            const r = await api("POST", `/v1/admin/members/${m.userId}/invite`);
                            setInvite({ invite: r.invite, existing: false, email: m.email ?? undefined, userId: m.userId });
                          })
                        }
                      >
                        gerar novo convite
                      </button>
                      <br />
                    </>
                  )}
                  {!m.isSelf &&
                    (m.status === "active" ? (
                      <button
                        className="link"
                        onClick={() => {
                          if (confirm(`Suspender o acesso de ${m.displayName} a esta equipe?`))
                            void run(() => api("PATCH", `/v1/admin/members/${m.userId}`, { body: { status: "suspended" } }), "Acesso suspenso.");
                        }}
                      >
                        suspender
                      </button>
                    ) : (
                      <button className="link" onClick={() => run(() => api("PATCH", `/v1/admin/members/${m.userId}`, { body: { status: "active" } }), "Acesso reativado.")}>
                        reativar
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {invite && <InviteResult invite={invite.invite} existing={invite.existing} email={invite.email} />}

      <h3>Convidar pessoa</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api("POST", "/v1/admin/members", { body: { name, email, grants: grants.map(scopeToBody) } });
            setInvite({ invite: r.invite, existing: r.existingAccount, email });
            setName("");
            setEmail("");
            setGrants([{ role: "attending_physician", scope: "" }]);
          });
        }}
      >
        <div className="grid2">
          <div className="field">
            <label htmlFor="m-name">Nome completo</label>
            <input id="m-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} />
          </div>
          <div className="field">
            <label htmlFor="m-email">E-mail</label>
            <input id="m-email" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: "100%" }} />
          </div>
        </div>
        <label>Papéis</label>
        {grants.map((g, i) => (
          <div key={i} className="row" style={{ marginBottom: 6 }}>
            <GrantFields value={g} onChange={(v) => setGrants(grants.map((x, j) => (j === i ? v : x)))} data={data} />
            {grants.length > 1 && (
              <button type="button" className="link" onClick={() => setGrants(grants.filter((_, j) => j !== i))}>
                remover
              </button>
            )}
          </div>
        ))}
        <div className="row">
          <button type="button" onClick={() => setGrants([...grants, { role: "attending_physician", scope: "" }])}>
            + outro papel
          </button>
          <button className="primary">Convidar</button>
        </div>
      </form>
    </div>
  );
}
