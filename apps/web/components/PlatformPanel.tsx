"use client";

import { useCallback, useEffect, useState } from "react";
import { api, storeTenant } from "@/lib/client";
import { InviteResult, TimezoneSelect } from "./Admin";

interface TenantRow {
  id: string;
  name: string;
  timezone: string;
  members: number;
  admins: string[];
  createdAt: string;
}

/**
 * Operador da plataforma: cria instituições (equipes). O primeiro administrador pode ser o
 * próprio operador ou outra pessoa, convidada por e-mail.
 */
export function PlatformPanel({ myTenantIds }: { myTenantIds: string[] }) {
  const [list, setList] = useState<TenantRow[] | null>(null);
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("America/Sao_Paulo");
  const [self, setSelf] = useState(true);
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; invite: { link: string | null; sentByEmail: boolean } | null; existingAccount: boolean; email?: string } | null>(null);

  const load = useCallback(() => {
    api<{ tenants: TenantRow[] }>("GET", "/v1/platform/tenants", { tenant: false })
      .then((r) => setList(r.tenants))
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api("POST", "/v1/platform/tenants", {
        tenant: false,
        body: { name, timezone, admin: self ? null : { name: adminName, email: adminEmail } },
      });
      if (self) {
        storeTenant(r.id);
        location.assign("/admin");
        return;
      }
      setResult({ ...r, email: adminEmail });
      setName("");
      setAdminName("");
      setAdminEmail("");
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Nova equipe (instituição)</h2>
        <p className="muted small">
          Cada equipe é isolada das outras: hospitais, serviços, membros e pacientes não são compartilhados.
        </p>
        <form onSubmit={create}>
          <div className="field">
            <label htmlFor="t-name">Nome da equipe</label>
            <input id="t-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Equipe de Neurologia" style={{ width: "100%" }} />
          </div>
          <div className="field">
            <label htmlFor="t-tz">Fuso horário padrão</label>
            <TimezoneSelect id="t-tz" value={timezone} onChange={setTimezone} />
          </div>
          <div className="field">
            <label>Primeiro administrador</label>
            <div className="row">
              <label className="row" style={{ color: "inherit" }}>
                <input type="radio" checked={self} onChange={() => setSelf(true)} /> Eu mesmo
              </label>
              <label className="row" style={{ color: "inherit" }}>
                <input type="radio" checked={!self} onChange={() => setSelf(false)} /> Outra pessoa (convite por e-mail)
              </label>
            </div>
          </div>
          {!self && (
            <div className="grid2">
              <div className="field">
                <label htmlFor="t-an">Nome</label>
                <input id="t-an" required maxLength={200} value={adminName} onChange={(e) => setAdminName(e.target.value)} style={{ width: "100%" }} />
              </div>
              <div className="field">
                <label htmlFor="t-ae">E-mail</label>
                <input id="t-ae" required type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} style={{ width: "100%" }} />
              </div>
            </div>
          )}
          {error && <div className="alert bad">{error}</div>}
          <button className="primary" disabled={busy}>
            {busy ? "Criando…" : "Criar equipe"}
          </button>
        </form>
        {result && <InviteResult invite={result.invite} existing={result.existingAccount} email={result.email} />}
      </div>
      {list && list.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Equipes cadastradas</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Equipe</th>
                  <th>Fuso</th>
                  <th>Membros ativos</th>
                  <th>Administradores</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td className="small">{t.timezone}</td>
                    <td>{t.members}</td>
                    <td className="small">{t.admins.join(", ")}</td>
                    <td>
                      {myTenantIds.includes(t.id) && (
                        <button
                          type="button"
                          className="link"
                          onClick={() => {
                            storeTenant(t.id);
                            location.assign("/admin");
                          }}
                        >
                          abrir
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
