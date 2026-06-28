import swiftParser from '@centrapay/swift-parser'
import { toMinor } from '#/lib/money.ts'
import { collapseSpaces } from '#/lib/ingest/transforms.ts'
import type { CanonicalRow, ParseResult } from '#/lib/ingest/types.ts'

function isoDate(d: Date | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

function amountToNumber(a: unknown): number {
  if (typeof a === 'number') return a
  if (a && typeof a === 'object' && 'toString' in a) return Number(String(a))
  return Number(a)
}

/** Parse a SWIFT MT942/MT940 interim report into canonical rows. */
export function parseMt942(text: string, type: 'mt942' | 'mt940' = 'mt942'): ParseResult {
  const rows: CanonicalRow[] = []
  const warnings: string[] = []
  let statements: ReturnType<typeof swiftParser.parse>
  try {
    statements = swiftParser.parse({ type, data: text })
  } catch (e) {
    return { rows, headers: [], warnings: [`SWIFT parse failed: ${String(e)}`] }
  }

  for (const stmt of statements) {
    const stmtCcy = stmt.currency ?? 'CHF'
    for (const tx of stmt.transactions) {
      const signed = amountToNumber(tx.amount) // Credit+, Debit-
      const direction = signed < 0 ? 'debit' : 'credit'
      const ccy = tx.currency ?? stmtCcy
      const date = isoDate(tx.date) ?? isoDate(tx.entryDate) ?? ''
      const details = tx.details ? collapseSpaces(tx.details) : null
      rows.push({
        txDate: date,
        bookingDate: isoDate(tx.entryDate),
        valueDate: isoDate(tx.date),
        direction,
        amount: toMinor(Math.abs(signed), ccy) * (direction === 'debit' ? -1 : 1),
        currency: ccy,
        originalAmount: null,
        originalCurrency: null,
        fxRate: null,
        merchant: null,
        description: details,
        reference: tx.reference ?? tx.bankReference ?? null,
        counterparty: tx.structuredDetails?.ORDP ?? null,
        category: tx.transactionType ?? null,
        statusText: tx.reversal ? 'reversal' : null,
        raw: { ...tx, amount: String(tx.amount) },
        errors: date ? [] : ['missing date'],
      })
    }
  }
  return { rows, headers: [], warnings }
}
