"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiFailure, setActiveTenant, storedTenant, storeTenant } from "@/lib/client";
import { PlatformPanel } from "./PlatformPanel";

export interface Service {
  id: string;
  name: string;
  hospitalId: string;
  hospitalName: string;
  timezone: string;
  capabilities: string[];
}
interface Me {
  user: { id: string; displayName: string };
  realUser: { id: string; displayName: string } | null;
  isDemoOperator: boolean;
  isPlatformAdmin: boolean;
  appMode: string;
  demo: boolean;
  tenants: { id: string; name: string; timezone: string; isSynthetic: boolean; grants: { roleLabel: string; serviceName: string | null; hospitalName: string | null }[] }[];
}
interface Ctx {
  tenant: { id: string; name: string; timezone: string; isSynthetic: boolean; modules: { handoffs: boolean; ai: boolean } };
  services: Service[];
  tenantCapabilities: string[];
  unreadNotifications: number;
}

interface ShellValue {
  me: Me;
  ctx: Ctx;
  service: Service | null;
  setServiceId: (id: string) => void;
  can: (cap: string, serviceId?: string) => boolean;
  refresh: () => void;
}

const ShellContext = createContext<ShellValue | null>(null);
export function useShell(): ShellValue {
  const v = useContext(ShellContext);
  if (!v) throw new Error("fora do Shell");
  return v;
}

const SERVICE_KEY = "evolu.service";

const NAV: { href: string; label: string; cap?: string; tenantCap?: string; system?: boolean }[] = [
  { href: "/", label: "Pacientes do dia" },
  { href: "/tarefas", label: "Tarefas" },
  { href: "/passagens", label: "Passagens", cap: "handoff.participate" },
  { href: "/escala", label: "Escala" },
  { href: "/pendencias", label: "Pendências" },
  { href: "/coordenacao", label: "Coordenação", cap: "coordination.view" },
  { href: "/auditoria", label: "Auditoria", tenantCap: "audit.read", system: true },
  { href: "/admin", label: "Administração", tenantCap: "org.manage", system: true },
];

export function Shell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [serviceId, setServiceIdState] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "anon" | "mfa" | "ready" | "no-tenant" | "error">("loading");
  const [tick, setTick] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    api<Me>("GET", "/v1/me", { tenant: false })
      .then((m) => {
        setMe(m);
        if (!m.tenants.length) return setState("no-tenant");
        const pref = storedTenant();
        const t = m.tenants.find((x) => x.id === pref) ?? m.tenants[0]!;
        setTenantId(t.id);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiFailure && e.code === "mfa_required") setState("mfa");
        else if (e instanceof ApiFailure && e.status === 401) setState("anon");
        else setState("error");
      });
  }, [tick]);

  useEffect(() => {
    if (!tenantId) return;
    setActiveTenant(tenantId);
    storeTenant(tenantId);
    api<Ctx>("GET", "/v1/context")
      .then((c) => {
        setCtx(c);
        let pref: string | null = null;
        try {
          pref = localStorage.getItem(SERVICE_KEY);
        } catch {
          /* sem preferência */
        }
        const s = c.services.find((x) => x.id === pref) ?? c.services[0] ?? null;
        setServiceIdState(s?.id ?? null);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, [tenantId, tick, pathname]);

  const setServiceId = useCallback((id: string) => {
    setServiceIdState(id);
    try {
      localStorage.setItem(SERVICE_KEY, id);
    } catch {
      /* ok */
    }
  }, []);

  if (state === "loading") return <main className="center muted">Carregando…</main>;
  if (state === "anon") return <Landing />;
  if (state === "mfa")
    return (
      <main className="center">
        <div className="card narrow">
          <h1>Segundo fator obrigatório</h1>
          <p>Entre novamente usando autenticação em dois fatores (aplicativo autenticador ou chave de segurança).</p>
          <LogoutButton label="Entrar novamente" />
        </div>
      </main>
    );
  if (state === "no-tenant" && me?.isPlatformAdmin)
    return (
      <main className="page">
        <div className="row between">
          <h1>Bem-vindo ao Evolu-IA</h1>
          <LogoutButton />
        </div>
        <p className="muted">
          Crie a sua equipe para começar. Depois, em Administração, cadastre hospitais e serviços e convide médicos e secretárias.
        </p>
        <PlatformPanel myTenantIds={[]} />
      </main>
    );
  if (state === "no-tenant")
    return (
      <main className="center">
        <div className="card narrow">
          <h1>Sem vínculo ativo</h1>
          <p>Sua conta está autenticada, mas ainda não tem vínculo com nenhuma instituição. Peça à administração do serviço.</p>
          {me?.isDemoOperator && (
            <div className="field">
              <label>Demonstração: operar como persona sintética</label>
              <PersonaPicker onChanged={() => location.assign("/")} />
            </div>
          )}
          <LogoutButton />
        </div>
      </main>
    );
  if (state === "error" || !me || !ctx) return <main className="center">Não foi possível carregar. Recarregue a página.</main>;

  const service = ctx.services.find((s) => s.id === serviceId) ?? null;
  const can = (cap: string, sid?: string) => {
    const s = sid ? ctx.services.find((x) => x.id === sid) : service;
    return Boolean(s?.capabilities.includes(cap));
  };
  const anyService = (cap: string) => ctx.services.some((s) => s.capabilities.includes(cap));

  const nav = NAV.filter((n) => (!n.cap || anyService(n.cap)) && (!n.tenantCap || ctx.tenantCapabilities.includes(n.tenantCap)));
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const link = (href: string, text: ReactNode, badge?: number) => (
    <Link key={href} href={href} className={isActive(href) ? "active" : ""} onClick={() => setDrawer(false)}>
      <span>{text}</span>
      {badge ? <span className="count">{badge}</span> : null}
    </Link>
  );

  return (
    <ShellContext.Provider value={{ me, ctx, service, setServiceId, can, refresh: () => setTick((t) => t + 1) }}>
      <div className={`app ${drawer ? "drawer-open" : ""}`}>
        <header className="topbar">
          <button className="icon" aria-label="Abrir menu" onClick={() => setDrawer(true)}>
            ☰
          </button>
          <Link href="/" className="brand">
            Evolu-IA
          </Link>
          <Link href="/notificacoes" className="icon" aria-label="Avisos">
            🔔{ctx.unreadNotifications > 0 && <span className="count">{ctx.unreadNotifications}</span>}
          </Link>
        </header>
        <div className="scrim" onClick={() => setDrawer(false)} />
        <aside className="sidebar">
          <div className="brand-block">
            <Link href="/" className="brand" onClick={() => setDrawer(false)}>
              Evolu-IA
            </Link>
            <div className="tagline">Visita hospitalar</div>
            {ctx.tenant.isSynthetic ? <span className="pill live">DEMO</span> : <span className="pill live">● LIVE</span>}
          </div>
          {(me.tenants.length > 1 || ctx.services.length > 0) && (
            <div className="side-selects">
              {me.tenants.length > 1 && (
                <select aria-label="Instituição" value={tenantId ?? ""} onChange={(e) => setTenantId(e.target.value)}>
                  {me.tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
              {ctx.services.length > 0 && (
                <select aria-label="Serviço" value={serviceId ?? ""} onChange={(e) => setServiceId(e.target.value)}>
                  {ctx.services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.hospitalName}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          <nav>
            <div className="nav-section">Principal</div>
            {nav.filter((n) => !n.system).map((n) => link(n.href, n.label))}
            {link("/notificacoes", "Avisos", ctx.unreadNotifications)}
            {(nav.some((n) => n.system) || me.isPlatformAdmin) && <div className="nav-section">Sistema</div>}
            {nav.filter((n) => n.system).map((n) => link(n.href, n.label))}
            {me.isPlatformAdmin && link("/plataforma", "Plataforma")}
          </nav>
          <div className="side-foot">
            {me.isDemoOperator && <PersonaPicker onChanged={() => location.assign("/")} />}
            <div className="user" title={me.realUser ? `Operando como persona; conta real: ${me.realUser.displayName}` : ""}>
              {me.user.displayName}
            </div>
            <span className="pill tag">{ctx.tenant.name}</span>
            <LogoutButton />
          </div>
        </aside>
        <div className="main">
          {me.demo && (
            <div className="demo-banner" role="note">
              DEMONSTRAÇÃO — somente dados sintéticos. Não insira dados reais de pacientes.
            </div>
          )}
          <main className="page">{children}</main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}

function PersonaPicker({ onChanged }: { onChanged: () => void }) {
  const [list, setList] = useState<{ userId: string; displayName: string; grants: string[] }[]>([]);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    api("GET", "/v1/demo/personas", { tenant: false })
      .then((r) => {
        setList(r.personas);
        setActive(r.active);
      })
      .catch(() => undefined);
  }, []);
  if (!list.length) return null;
  return (
    <select
      aria-label="Persona de demonstração"
      className="persona"
      value={active ?? ""}
      onChange={async (e) => {
        await api("POST", "/v1/demo/persona", { tenant: false, body: { userId: e.target.value || null } });
        onChanged();
      }}
    >
      <option value="">Minha conta</option>
      {list.map((p) => (
        <option key={p.userId} value={p.userId} title={p.grants.join("\n")}>
          Persona: {p.displayName}
        </option>
      ))}
    </select>
  );
}

function LogoutButton({ label = "Sair" }: { label?: string }) {
  return (
    <form method="post" action="/auth/logout" className="inline">
      <button type="submit" className="outline">
        {label}
      </button>
    </form>
  );
}

function Landing() {
  return (
    <main className="center">
      <div className="card narrow">
        <h1>Evolu-IA</h1>
        <p>Visita hospitalar e coordenação de equipes: censo por serviço, evolução por ditado organizada pela IA, tarefas e passagem de plantão.</p>
        <p className="muted small">Acesso restrito a contas convidadas pela equipe, com segundo fator obrigatório.</p>
        <a className="button primary" href="/auth/login">
          Entrar
        </a>
      </div>
    </main>
  );
}
