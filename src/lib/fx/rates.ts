import { and, eq, gte, lte } from 'drizzle-orm'
import { db } from '#/db/client.ts'
import { fxRates } from '#/db/schema.ts'
import { addDays } from '#/lib/date.ts'
import { currencyDecimals } from '#/lib/money.ts'

const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v1'
export const SUPPORTED_CURRENCIES = ['CHF', 'EUR', 'USD', 'GBP'] as const

type RateSource = 'frankfurter' | 'manual' | 'card'
const SOURCE_PRECEDENCE: Record<RateSource, number> = {
  manual: 3,
  card: 2,
  frankfurter: 1,
}

function isoDate(d: string): string {
  // accept "2025-01-03" or "2025-01-03 00:00:00" -> "2025-01-03"
  return d.slice(0, 10)
}

/**
 * Persist a rate (idempotent on date/base/quote/source).
 */
export function storeRate(
  date: string,
  base: string,
  quote: string,
  rate: number,
  source: RateSource,
): void {
  if (base === quote) return
  db.insert(fxRates)
    .values({ date: isoDate(date), base, quote, rate, source })
    .onConflictDoNothing()
    .run()
}

/**
 * Fetch rates for a single date from Frankfurter (ECB). Returns the actual
 * date used (Frankfurter carries forward to the last business day) plus the
 * rate map. Returns null on any network/parse failure (offline mode).
 */
async function fetchFrankfurter(
  date: string,
  base: string,
  quotes: string[],
): Promise<{ date: string; rates: Record<string, number> } | null> {
  const symbols = quotes.filter((q) => q !== base).join(',')
  if (!symbols) return { date: isoDate(date), rates: {} }
  const url = `${FRANKFURTER_BASE}/${isoDate(date)}?base=${base}&symbols=${symbols}`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const json = (await res.json()) as {
      date: string
      base: string
      rates: Record<string, number>
    }
    return { date: json.date, rates: json.rates }
  } catch {
    return null
  }
}

/**
 * Ensure CHF conversion rates exist (cached) for every (date, currency) pair
 * given. Fetches missing ones from Frankfurter in batched per-date calls.
 * Safe to call repeatedly; only fetches what's missing.
 */
export async function ensureChfRates(
  pairs: Array<{ date: string; currency: string }>,
): Promise<void> {
  // group needed currencies by date, dropping CHF and unsupported
  const byDate = new Map<string, Set<string>>()
  for (const { date, currency } of pairs) {
    const cur = currency.toUpperCase()
    if (cur === 'CHF') continue
    if (!SUPPORTED_CURRENCIES.includes(cur as never)) continue
    const d = isoDate(date)
    if (!byDate.has(d)) byDate.set(d, new Set())
    byDate.get(d)!.add(cur)
  }

  for (const [date, currencies] of byDate) {
    const missing: string[] = []
    for (const cur of currencies) {
      // a cached rate only counts if it's near the requested date (5 days
      // covers ECB weekends/holidays) — without the lower bound, one ancient
      // rate suppressed fetching forever and carried forward for months
      const have = db
        .select({ id: fxRates.id })
        .from(fxRates)
        .where(
          and(
            lte(fxRates.date, date),
            gte(fxRates.date, addDays(date, -5)),
            eq(fxRates.base, cur),
            eq(fxRates.quote, 'CHF'),
          ),
        )
        .limit(1)
        .get()
      if (!have) missing.push(cur)
    }
    if (missing.length === 0) continue
    // fetch base=CHF, symbols=missing, then invert to cur->CHF
    const result = await fetchFrankfurter(date, 'CHF', missing)
    if (!result) continue
    for (const cur of missing) {
      const chfToCur = result.rates[cur]
      if (chfToCur && chfToCur > 0) {
        storeRate(result.date, cur, 'CHF', 1 / chfToCur, 'frankfurter')
      }
    }
  }
}

/** All cached rates loaded for fast synchronous lookup during a matching run. */
interface RateRow {
  date: string
  rate: number
  pref: number
}

export interface RateMap {
  /** rows bucketed by "BASE|QUOTE", sorted ascending by date */
  buckets: Map<string, RateRow[]>
}

export function loadRateMap(): RateMap {
  const rows = db.select().from(fxRates).all()
  const buckets = new Map<string, RateRow[]>()
  for (const r of rows) {
    const key = `${r.base}|${r.quote}`
    let bucket = buckets.get(key)
    if (!bucket) buckets.set(key, (bucket = []))
    bucket.push({
      date: r.date,
      rate: r.rate,
      pref: SOURCE_PRECEDENCE[r.source as RateSource] ?? 0,
    })
  }
  for (const bucket of buckets.values())
    bucket.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { buckets }
}

function bestRate(
  map: RateMap,
  date: string,
  base: string,
  quote: string,
): number | null {
  const bucket = map.buckets.get(`${base}|${quote}`)
  if (!bucket) return null
  const d = isoDate(date)
  // last row with date <= d (bucket is date-ascending); at equal dates the
  // higher source precedence wins
  let best: RateRow | null = null
  for (const r of bucket) {
    if (r.date > d) break
    if (!best || r.date > best.date || (r.date === best.date && r.pref > best.pref)) {
      best = r
    }
  }
  return best?.rate ?? null
}

function directOrInverse(
  map: RateMap,
  date: string,
  base: string,
  quote: string,
): number | null {
  const direct = bestRate(map, date, base, quote)
  if (direct != null) return direct
  const inverse = bestRate(map, date, quote, base)
  if (inverse != null && inverse !== 0) return 1 / inverse
  return null
}

/**
 * Synchronous rate lookup from a preloaded map. Tries direct, inverse, and
 * cross via CHF (the hub actually populated by ensureChfRates) then EUR.
 * Returns null if no rate is derivable.
 */
export function rateFromMap(
  map: RateMap,
  date: string,
  base: string,
  quote: string,
): number | null {
  base = base.toUpperCase()
  quote = quote.toUpperCase()
  if (base === quote) return 1
  const di = directOrInverse(map, date, base, quote)
  if (di != null) return di
  for (const hub of ['CHF', 'EUR']) {
    if (base === hub || quote === hub) continue
    const baseHub = directOrInverse(map, date, base, hub)
    const hubQuote = directOrInverse(map, date, hub, quote)
    if (baseHub != null && hubQuote != null) return baseHub * hubQuote
  }
  return null
}

/** Convert minor units between currencies using a preloaded rate map. */
export function convertMinor(
  map: RateMap,
  amountMinor: number,
  from: string,
  to: string,
  date: string,
): number | null {
  if (from.toUpperCase() === to.toUpperCase()) return amountMinor
  const rate = rateFromMap(map, date, from, to)
  if (rate == null) return null
  const major = amountMinor / 10 ** currencyDecimals(from)
  const converted = major * rate
  return Math.round(converted * 10 ** currencyDecimals(to))
}
