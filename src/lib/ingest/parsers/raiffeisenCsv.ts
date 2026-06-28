import { toMinor } from '#/lib/money.ts'
import {
  collapseSpaces,
  parseDateFlexible,
  parseNumberFlexible,
} from '#/lib/ingest/transforms.ts'
import type { RawRow } from '#/lib/ingest/parsers/tabular.ts'
import type { CanonicalRow, ParseResult } from '#/lib/ingest/types.ts'

// Header: IBAN;Booked At;Text;Credit/Debit Amount;Balance;Valuta Date
const COL = {
  iban: 'IBAN',
  booked: 'Booked At',
  text: 'Text',
  amount: 'Credit/Debit Amount',
  balance: 'Balance',
  valuta: 'Valuta Date',
} as const

const TYPE_PREFIXES = [
  'ordre permanent',
  'crédit',
  'credit',
  'paiement',
  'achat',
  'virement',
  'débit',
  'debit',
  'versement',
  'retrait',
  'e-banking',
  'twint',
]

/** Strip the leading Raiffeisen transaction-type verb to expose the counterparty. */
function extractCounterparty(text: string): string {
  let s = collapseSpaces(text)
  const lower = s.toLowerCase()
  for (const p of TYPE_PREFIXES) {
    if (lower.startsWith(p)) {
      s = s.slice(p.length).trim()
      // also strip a trailing payment-method token like "TWINT"
      const rest = s.toLowerCase()
      if (rest.startsWith('twint')) s = s.slice(5).trim()
      break
    }
  }
  return s || text
}

/**
 * Parse a Raiffeisen CSV export. Each transaction spans a summary row (IBAN
 * present) followed by one or more continuation rows (IBAN empty) whose Text
 * holds extra remittance info. The continuations are merged into the summary.
 */
export function parseRaiffeisenCsv(records: RawRow[]): ParseResult {
  const rows: CanonicalRow[] = []
  const warnings: string[] = []

  let current: { rec: RawRow; detail: string[] } | null = null

  const flush = () => {
    if (!current) return
    const { rec, detail } = current
    const summaryText = collapseSpaces(String(rec[COL.text] ?? ''))
    const fullText = collapseSpaces([summaryText, ...detail].join(' '))
    const valuta = parseDateFlexible(rec[COL.valuta])
    const booked = parseDateFlexible(rec[COL.booked])
    const signed = parseNumberFlexible(rec[COL.amount], {
      decimalSeparator: '.',
    })
    const direction = (signed ?? 0) < 0 ? 'debit' : 'credit'
    const currency = 'CHF'
    const txDate = valuta ?? booked ?? ''
    const errors: string[] = []
    if (!txDate) errors.push('missing date')
    if (signed == null) errors.push('unparseable amount')
    rows.push({
      txDate,
      bookingDate: booked,
      valueDate: valuta,
      direction,
      amount: toMinor(Math.abs(signed ?? 0), currency) * (direction === 'debit' ? -1 : 1),
      currency,
      originalAmount: null,
      originalCurrency: null,
      fxRate: null,
      merchant: summaryText ? extractCounterparty(summaryText) : null,
      description: fullText || null,
      reference: null,
      counterparty: summaryText ? extractCounterparty(summaryText) : null,
      category: null,
      statusText: null,
      raw: { ...rec, _detail: detail },
      errors,
    })
    current = null
  }

  for (const rec of records) {
    const iban = String(rec[COL.iban] ?? '').trim()
    if (iban) {
      flush()
      current = { rec, detail: [] }
    } else if (current) {
      const t = collapseSpaces(String(rec[COL.text] ?? ''))
      if (t) current.detail.push(t)
    }
  }
  flush()

  if (rows.length === 0) warnings.push('No Raiffeisen rows parsed')
  return { rows, headers: Object.keys(records[0] ?? {}), warnings }
}
