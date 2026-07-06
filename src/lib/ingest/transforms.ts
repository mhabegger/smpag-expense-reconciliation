import { isValid, parse as parseDate } from 'date-fns'

const REF_DATE = new Date(0)

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Excel serial date (1900 system) -> ISO yyyy-mm-dd (UTC, date part only). */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null
  // Excel epoch is 1899-12-30 (accounts for the 1900 leap-year bug).
  // Truncate the fraction: it is the time of day, not a rounding artifact.
  const ms = Math.floor(serial) * 86400000
  const d = new Date(Date.UTC(1899, 11, 30) + ms)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}/

/**
 * Parse a date value of unknown shape into ISO yyyy-mm-dd.
 * Supports Date objects, Excel serials (number or 'excel-serial'), ISO strings,
 * and explicit date-fns patterns (e.g. 'dd.MM.yyyy', 'dd/MM/yyyy').
 */
export function parseDateFlexible(
  value: unknown,
  format?: string,
): string | null {
  if (value == null || value === '') return null

  if (value instanceof Date) {
    // xlsx (cellDates: true) builds Dates in local time; toISOString would
    // shift the calendar day for any timezone east of UTC.
    return Number.isNaN(value.getTime()) ? null : toIsoLocal(value)
  }

  if (format === 'excel-serial' || typeof value === 'number') {
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n)) return excelSerialToIso(n)
  }

  const str = String(value).trim()
  if (!str) return null

  if (format && format !== 'iso' && format !== 'excel-serial') {
    const d = parseDate(str, format, REF_DATE)
    return isValid(d) ? toIsoLocal(d) : null
  }

  // ISO (optionally with time component)
  if (ISO_RE.test(str)) return str.slice(0, 10)

  // try a battery of common patterns
  for (const fmt of [
    'dd.MM.yyyy',
    'd.M.yyyy',
    'dd/MM/yyyy',
    'd/M/yyyy',
    'yyyy/MM/dd',
    'dd-MM-yyyy',
    'MM/dd/yyyy',
  ]) {
    const d = parseDate(str, fmt, REF_DATE)
    if (isValid(d)) return toIsoLocal(d)
  }
  return null
}

function toIsoLocal(d: Date): string {
  // format the local Y-M-D (date-fns parsed into local time)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export interface NumberOptions {
  decimalSeparator?: ',' | '.'
  thousandsSeparator?: "'" | ',' | '.' | ' ' | ''
}

/**
 * Parse a numeric string in Swiss/European/English formats into a JS number
 * (major units). Returns null if not parseable.
 * Handles: 1'234.56, 1.234,56, 1,234.56, 1234,56, -1234.56, (1234.56), 1234.56-
 */
export function parseNumberFlexible(
  value: unknown,
  opts: NumberOptions = {},
): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null

  let str = String(value).trim()
  if (!str) return null

  // negative markers
  let negative = false
  if (/^\(.*\)$/.test(str)) {
    negative = true
    str = str.slice(1, -1)
  }
  if (str.endsWith('-')) {
    negative = true
    str = str.slice(0, -1)
  }
  if (str.startsWith('-')) {
    negative = true
    str = str.slice(1)
  }
  if (str.startsWith('+')) str = str.slice(1)

  // strip currency codes/symbols, spaces (incl. NBSP / thin space)
  str = str
    .replace(/[A-Za-z$€£¥]/g, '')
    .replace(/[\s  ]/g, '')
    .replace(/[’'`´]/g, '')
    .trim()
  if (!str) return null

  let normalized: string
  if (opts.decimalSeparator) {
    const thou = opts.thousandsSeparator
    if (thou) str = str.split(thou).join('')
    // also always strip apostrophes (Swiss thousands)
    str = str.split("'").join('')
    normalized =
      opts.decimalSeparator === ','
        ? str.replace(/\./g, '').replace(',', '.')
        : str.replace(/,/g, '')
  } else {
    // infer
    str = str.split("'").join('') // apostrophes are always thousands
    const hasComma = str.includes(',')
    const hasDot = str.includes('.')
    if (hasComma && hasDot) {
      // the LAST separator is the decimal one
      const lastComma = str.lastIndexOf(',')
      const lastDot = str.lastIndexOf('.')
      if (lastComma > lastDot) {
        normalized = str.replace(/\./g, '').replace(',', '.')
      } else {
        normalized = str.replace(/,/g, '')
      }
    } else if (hasComma) {
      const after = str.length - str.lastIndexOf(',') - 1
      // 1-2 digits after a single comma => decimal; otherwise thousands grouping
      normalized = after <= 2 ? str.replace(',', '.') : str.replace(/,/g, '')
    } else {
      normalized = str // only dots (or none): treat dot as decimal
    }
  }

  const n = Number(normalized)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = {
  'fr.': 'CHF',
  fr: 'CHF',
  'sfr.': 'CHF',
  sfr: 'CHF',
  chf: 'CHF',
  '€': 'EUR',
  eur: 'EUR',
  $: 'USD',
  usd: 'USD',
  'us$': 'USD',
  '£': 'GBP',
  gbp: 'GBP',
}

export function normalizeCurrency(value: unknown): string | null {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  if (Object.hasOwn(CURRENCY_SYMBOLS, lower)) return CURRENCY_SYMBOLS[lower]
  // already a 3-letter code?
  const m = raw.match(/[A-Za-z]{3}/)
  if (m) return m[0].toUpperCase()
  return null
}

/** Split a combined "120.65 USD" / "USD 120.65" / "CHF 1'234.56" cell. */
export function splitAmountCurrency(
  value: unknown,
): { amount: string; currency: string | null } | null {
  if (value == null) return null
  const str = String(value).trim()
  if (!str) return null
  // currency code at end
  let m = str.match(/^(.*?)[\s ]*([A-Za-z]{3})$/)
  if (m) return { amount: m[1].trim(), currency: normalizeCurrency(m[2]) }
  // currency code at start
  m = str.match(/^([A-Za-z]{3})[\s ]*(.*)$/)
  if (m) return { amount: m[2].trim(), currency: normalizeCurrency(m[1]) }
  return { amount: str, currency: null }
}

// ---------------------------------------------------------------------------
// Generic text
// ---------------------------------------------------------------------------

export function stripDiacritics(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

export function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
