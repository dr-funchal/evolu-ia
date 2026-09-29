"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useShell } from "@/components/Shell";

/** Passagens é módulo opcional da equipe; desligado, o servidor também nega (sem handoff.participate). */
export default function PassagensLayout({ children }: { children: ReactNode }) {
  const { ctx } = useShell();
  if (ctx.tenant.modules.handoffs) return <>{children}</>;
  return (
    <div className="card">
      <h1>Passagens desabilitadas</h1>
      <p className="muted">O módulo de passagem de caso não está habilitado nesta equipe.</p>
      {ctx.tenantCapabilities.includes("org.manage") && (
        <p>
          Para habilitar, vá em <Link href="/admin">Administração → Equipe</Link>.
        </p>
      )}
    </div>
  );
}
