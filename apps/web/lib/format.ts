/** Datas sempre no fuso do hospital (IANA), em pt-BR. */
export function fmtDateTime(v: string | Date | null | undefined, tz?: string): string {
  if (!v) return "—";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: tz }).format(new Date(v));
}
export function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const [y, m, d] = v.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}
export function ageFrom(birth: string | null | undefined): string {
  if (!birth) return "";
  const b = new Date(`${birth}T12:00:00Z`);
  const now = new Date();
  let a = now.getUTCFullYear() - b.getUTCFullYear();
  if (now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate())) a--;
  return `${a} a`;
}
/** Valor para <input type="datetime-local"> no fuso informado. */
export function toLocalInput(d: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return p.replace(" ", "T");
}
/** Converte "YYYY-MM-DDTHH:mm" no fuso IANA para instante UTC (ISO). */
export function fromLocalInput(v: string, tz: string): string {
  const guess = new Date(`${v}:00Z`);
  const shown = new Date(`${toLocalInput(guess, tz)}:00Z`);
  return new Date(guess.getTime() - (shown.getTime() - guess.getTime())).toISOString();
}

export const STATUS_LABEL: Record<string, string> = {
  requested: "Solicitado",
  accepted: "Aceito",
  active: "Em acompanhamento",
  closed: "Encerrado",
  cancelled: "Cancelado",
  draft: "Rascunho",
  final: "Finalizada",
  open: "Aberta",
  in_progress: "Em andamento",
  blocked: "Bloqueada",
  done: "Concluída",
  proposed: "Proposta",
  sent: "Enviada",
  acknowledged: "Aceita",
  questioned: "Com dúvidas",
};
export const label = (s: string | null | undefined) => (s ? (STATUS_LABEL[s] ?? s) : "—");

export const CERTAINTY: Record<string, string> = { hipotese: "hipótese", diferencial: "diferencial", confirmado: "confirmado" };
export const PRIORITY: Record<string, string> = { rotina: "rotina", prioritaria: "prioritária", urgente: "urgente" };
