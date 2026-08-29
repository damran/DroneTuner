export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Raw feedforward value, displayed as an integer like Betaflight does. */
export function formatFeedforward(v: number | null | undefined): string {
  if (v == null) return "—";
  return String(Math.round(v));
}

export function formatVolts(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v.toFixed(2)} V`;
}

export function formatHz(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${Math.round(v)} Hz`;
}

export function formatPercent(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v.toFixed(1)}%`;
}
