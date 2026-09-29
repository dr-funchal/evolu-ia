"use client";

import { useState } from "react";

export const TIMEZONES = [
  "America/Sao_Paulo",
  "America/Bahia",
  "America/Fortaleza",
  "America/Recife",
  "America/Belem",
  "America/Manaus",
  "America/Cuiaba",
  "America/Campo_Grande",
  "America/Porto_Velho",
  "America/Boa_Vista",
  "America/Rio_Branco",
  "America/Noronha",
];

export function TimezoneSelect({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const list = TIMEZONES.includes(value) ? TIMEZONES : [value, ...TIMEZONES];
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {list.map((tz) => (
        <option key={tz} value={tz}>
          {tz.replace("America/", "").replaceAll("_", " ")} ({tz})
        </option>
      ))}
    </select>
  );
}

/** Mostra o link de convite para o admin copiar e enviar (quando o IdP não envia e-mail). */
export function InviteResult({ invite, existing, email }: { invite: { link: string | null; sentByEmail: boolean } | null; existing: boolean; email?: string }) {
  const [copied, setCopied] = useState(false);
  if (existing || !invite)
    return (
      <div className="alert ok small">
        {email ?? "A pessoa"} já tem conta: o acesso vale no próximo login em evolu-ia.pulpfy.com.
      </div>
    );
  if (invite.sentByEmail) return <div className="alert ok small">Convite enviado por e-mail{email ? ` para ${email}` : ""}.</div>;
  return (
    <div className="alert ok small">
      <p style={{ margin: "0 0 6px" }}>
        Envie este link para {email ?? "a pessoa"} (por e-mail ou mensagem). Ele é pessoal e vale para um único cadastro: a pessoa define a
        senha e o segundo fator, e depois entra em <strong>evolu-ia.pulpfy.com</strong>.
      </p>
      <div className="row">
        <input readOnly value={invite.link ?? ""} style={{ flex: 1, minWidth: 200 }} onFocus={(e) => e.currentTarget.select()} aria-label="Link de convite" />
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(invite.link ?? "");
              setCopied(true);
            } catch {
              /* sem acesso à área de transferência: o campo continua selecionável */
            }
          }}
        >
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
    </div>
  );
}
