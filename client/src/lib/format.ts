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

/**
 * Short title for a blackbox log: the download name without the
 * "BTFL_BLACKBOX_LOG_" prefix and extension, e.g. "AIR65_R_20260518_125703_BETAFPVG473".
 */
export function formatLogName(originalName: string | null | undefined): string | null {
  if (!originalName) return null;
  return originalName.replace(/^BTFL_BLACKBOX_LOG_/i, "").replace(/\.[^.]+$/, "");
}

/** "Flight 3 of 7" for multi-session files, null for single-session uploads. */
export function formatSession(sessionIndex: number, sessionCount: number): string | null {
  if (sessionCount <= 1) return null;
  return `Flight ${sessionIndex + 1} of ${sessionCount}`;
}
