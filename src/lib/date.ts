/** Parse an ISO yyyy-mm-dd date to a UTC epoch (day precision). */
function toUtc(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1)
}

/** Signed whole-day difference b - a (positive => b is later than a). */
export function daysBetweenSigned(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000)
}

export function daysBetween(a: string, b: string): number {
  return Math.abs(daysBetweenSigned(a, b))
}

export function addDays(iso: string, days: number): string {
  const t = toUtc(iso) + days * 86400000
  return new Date(t).toISOString().slice(0, 10)
}
