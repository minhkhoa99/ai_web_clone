// Display formatting (vi-VN). Pure: used by server and client components alike.
const int = new Intl.NumberFormat("vi-VN");
const one = (x: number) => x.toFixed(1).replace(".", ",");

export const fmtInt = (n: number): string => int.format(Math.round(n));
export const fmtPct = (x: number, digits = 1): string => `${(x * 100).toFixed(digits).replace(".", ",")}%`;

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${one(n / 1_000_000).replace(/,0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${one(n / 1024)} KB`;
  return `${one(n / 1024 / 1024)} MB`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

export const fmtMinutes = (s: number): string => (s < 60 ? "<1 phút" : `~${Math.round(s / 60)} phút`);

// "stripe.com/pricing": the breadcrumb label of a project.
export function hostPath(url: string): string {
  const u = new URL(url);
  return u.host + (u.pathname === "/" ? "" : u.pathname);
}
