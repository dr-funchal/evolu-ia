"use client";

import { PlatformPanel } from "@/components/PlatformPanel";
import { useShell } from "@/components/Shell";

export default function Plataforma() {
  const { me } = useShell();
  if (!me.isPlatformAdmin) return <div className="alert warn">Área restrita aos operadores da plataforma.</div>;
  return (
    <>
      <h1>Plataforma</h1>
      <PlatformPanel myTenantIds={me.tenants.map((t) => t.id)} />
    </>
  );
}
