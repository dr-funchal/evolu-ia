/**
 * Recorrência de escala (subconjunto de RFC 5545): FREQ=DAILY|WEEKLY, INTERVAL, BYDAY, WKST=MO.
 *
 * Tudo é calculado em horário local (parede) do fuso IANA da série e só no fim convertido para UTC:
 * "08h de sábado" continua 08h mesmo se o fuso mudar de offset. O término (until) é uma data local
 * inclusiva, guardada fora da RRULE. Cada ocorrência é identificada pelo início local original
 * (AAAA-MM-DDTHH:MM), que ancora exceções mesmo depois de a série ser alterada.
 */

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Rule {
  freq: "DAILY" | "WEEKLY";
  interval: number;
  byDay: Weekday[];
}

export interface SeriesSpec {
  /** Início local "AAAA-MM-DDTHH:MM". */
  dtstartLocal: string;
  timezone: string;
  durationMinutes: number;
  /** null = ocorrência única. */
  rrule: string | null;
  /** Última data local (inclusiva) em que a série pode começar uma ocorrência. */
  untilLocal: string | null;
}

export interface Occurrence {
  originalStartLocal: string;
  start: Date;
  end: Date;
}

const DAY = 86_400_000;

function epochDay(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}
function ymdOf(day: number): string {
  return new Date(day * DAY).toISOString().slice(0, 10);
}
/** 0 = segunda … 6 = domingo. */
function isoWeekday(day: number): number {
  return (new Date(day * DAY).getUTCDay() + 6) % 7;
}

export function parseRule(rrule: string): Rule {
  const parts = new Map(
    rrule
      .replace(/^RRULE:/i, "")
      .split(";")
      .filter(Boolean)
      .map((p) => {
        const [k, v] = p.split("=");
        return [k!.toUpperCase(), (v ?? "").toUpperCase()] as const;
      }),
  );
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY") throw new Error("FREQ não suportada");
  for (const k of parts.keys()) if (!["FREQ", "INTERVAL", "BYDAY", "WKST"].includes(k)) throw new Error(`RRULE: ${k} não suportado`);
  if (parts.has("WKST") && parts.get("WKST") !== "MO") throw new Error("WKST deve ser MO");
  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) throw new Error("INTERVAL inválido");
  const byDay = parts.get("BYDAY") ? (parts.get("BYDAY")!.split(",") as Weekday[]) : [];
  if (byDay.some((d) => !WEEKDAYS.includes(d))) throw new Error("BYDAY inválido");
  if (freq === "DAILY" && byDay.length) throw new Error("BYDAY só com FREQ=WEEKLY");
  return { freq, interval, byDay };
}

export function formatRule(r: Rule): string {
  const out = [`FREQ=${r.freq}`];
  if (r.interval > 1) out.push(`INTERVAL=${r.interval}`);
  if (r.freq === "WEEKLY" && r.byDay.length) {
    out.push(`BYDAY=${[...new Set(r.byDay)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)).join(",")}`);
    out.push("WKST=MO");
  }
  return out.join(";");
}

function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - instant;
}

/** Converte horário local de parede "AAAA-MM-DDTHH:MM" no fuso IANA para instante UTC. */
export function zonedToUtc(local: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error("horário local inválido");
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  let t = guess - offsetMs(guess, timeZone);
  t = guess - offsetMs(t, timeZone);
  return new Date(t);
}

/** Data local AAAA-MM-DD de um instante. */
function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/**
 * Ocorrências que se sobrepõem a [from, to). Limitado a `max` ocorrências para proteger o servidor.
 */
export function expand(spec: SeriesSpec, from: Date, to: Date, max = 2000): Occurrence[] {
  const [startYmd, time] = spec.dtstartLocal.split("T") as [string, string];
  const first = epochDay(startYmd);
  const rule = spec.rrule ? parseRule(spec.rrule) : null;
  const byDay = rule?.byDay.length ? rule.byDay.map((d) => WEEKDAYS.indexOf(d)) : [isoWeekday(first)];
  const firstWeek = first - isoWeekday(first);

  // Janela em dias locais, com folga para turnos longos que começaram antes de `from`.
  const slack = Math.ceil(spec.durationMinutes / 1440) + 1;
  let day = Math.max(first, epochDay(localDate(from, spec.timezone)) - slack);
  let last = epochDay(localDate(to, spec.timezone)) + 1;
  if (spec.untilLocal) last = Math.min(last, epochDay(spec.untilLocal));
  if (!rule) last = Math.min(last, first);

  const out: Occurrence[] = [];
  for (; day <= last && out.length < max; day++) {
    if (rule) {
      if (rule.freq === "DAILY" && (day - first) % rule.interval !== 0) continue;
      if (rule.freq === "WEEKLY") {
        if (!byDay.includes(isoWeekday(day))) continue;
        const week = Math.floor((day - isoWeekday(day) - firstWeek) / 7);
        if (week % rule.interval !== 0) continue;
      }
    } else if (day !== first) continue;
    const originalStartLocal = `${ymdOf(day)}T${time}`;
    const start = zonedToUtc(originalStartLocal, spec.timezone);
    const end = new Date(start.getTime() + spec.durationMinutes * 60_000);
    if (end > from && start < to) out.push({ originalStartLocal, start, end });
  }
  return out;
}
