const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const pad = (n: number) => String(n).padStart(2, "0");

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2 Oct", or "2 Oct 2025" outside the current year. */
export function shortDate(ms: number | string): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

export function longDate(ms: number | string): string {
  return new Date(ms).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "never";
  const d = now - ms;
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 2 * DAY) return "yesterday";
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} days ago`;
  return shortDate(ms);
}

/** "6 days", "3 h": how long since `ms`, for uptime. */
export function span(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < HOUR) return `${Math.max(1, Math.floor(d / MIN))} min`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h`;
  const days = Math.floor(d / DAY);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Whole days from today until an ISO date (negative once past). */
export function daysUntil(iso: string, now = Date.now()): number {
  const t = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).getTime();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((t - today.getTime()) / DAY);
}

export function untilLabel(iso: string): string {
  const n = daysUntil(iso);
  if (n < 0) return `ran out ${shortDate(iso)}`;
  if (n === 0) return "runs out today";
  if (n === 1) return "runs out tomorrow";
  return `in ${n} days`;
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function num(n: number): string {
  return n.toLocaleString("en-IN");
}

export function bytes(n: number | null | undefined): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}
