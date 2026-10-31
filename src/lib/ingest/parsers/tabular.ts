import type { Direction } from '#/db/types.ts'
import { toMinor } from '#/lib/money.ts'
import {
  type NumberOptions,
  collapseSpaces,
  normalizeCurrency,
  parseDateFlexible,
  parseNumberFlexible,
  splitAmountCurrency,
} from '#/lib/ingest/transforms.ts'
import type {
  CanonicalRow,
  FieldMap,
  MappingOptions,
} from '#/lib/ingest/types.ts'

export type RawRow = Record<string, unknown>

function str(v: unknown): string | null {
  if (v == null) return null
  const s = collapseSpaces(String(v))
  return s === '' ? null : s
}

function numOpts(o: MappingOptions): NumberOptions {
  return {
    decimalSeparator: o.decimalSeparator,
    thousandsSeparator: o.thousandsSeparator,
  }
}

function deriveDirection(
  signedValue: number,
  row: RawRow,
  o: MappingOptions,
  errors: string[],
): { direction: Direction; magnitude: number } {
  const conv = o.signConvention ?? 'signed'
  let direction: Direction
  let magnitude = Math.abs(signedValue)

  switch (conv) {
    case 'positive_is_debit':
      direction = signedValue >= 0 ? 'debit' : 'credit'
      break
    case 'debit_credit_indicator': {
      const indicator = o.debitCreditColumn
        ? str(row[o.debitCreditColumn])?.toLowerCase()
        : null
      // Exact token match — substring matching classified "credit" as debit
      // (contains "d") and "Gutschrift" as debit (contains "s").
      const debitVals = (o.debitValues ?? ['debit', 'd', 'soll', 's']).map((v) =>
        v.toLowerCase(),
      )
      const creditVals = (
        o.creditValues ?? ['credit', 'c', 'haben', 'h', 'gutschrift']
      ).map((v) => v.toLowerCase())
      if (indicator && debitVals.includes(indicator)) {
        direction = 'debit'
      } else if (indicator && creditVals.includes(indicator)) {
        direction = 'credit'
      } else {
        direction = 'credit'
        errors.push(
          `unknown debit/credit indicator${indicator ? ` "${indicator}"` : ''}`,
        )
      }
      break
    }
    case 'signed':
    default:
      direction = signedValue < 0 ? 'debit' : 'credit'
      break
  }
  if (o.invertSign) direction = direction === 'debit' ? 'credit' : 'debit'
  return { direction, magnitude }
}

/**
 * Map raw tabular rows into canonical rows using a field map + options.
 * Amounts come out as signed MINOR units (debit negative, credit positive).
 */
export function mapRowsToCanonical(
  rows: RawRow[],
  fieldMap: FieldMap,
  options: MappingOptions,
): CanonicalRow[] {
  const out: CanonicalRow[] = []
  const get = (row: RawRow, field: keyof FieldMap): unknown => {
    const col = fieldMap[field]
    return col ? row[col] : undefined
  }

  for (const row of rows) {
    // drop continuation/blank rows
    if (options.dropRowsWithoutField) {
      const v = get(row, options.dropRowsWithoutField)
      if (v == null || String(v).trim() === '') continue
    }
    // reverted/declined card authorisations never moved money
    if (options.skipStatuses?.length) {
      const st = String(get(row, 'statusText') ?? '').trim().toUpperCase()
      if (options.skipStatuses.some((s) => s.toUpperCase() === st)) continue
    }

    const errors: string[] = []

    const txDate = parseDateFlexible(get(row, 'txDate'), options.dateFormat)
    const bookingDate = parseDateFlexible(
      get(row, 'bookingDate'),
      options.dateFormat,
    )
    const valueDate = parseDateFlexible(
      get(row, 'valueDate'),
      options.dateFormat,
    )

    // amount + currency
    let amountRaw = get(row, 'amount')
    let currency: string | null = null
    if (options.amountInCurrencyCell) {
      const split = splitAmountCurrency(amountRaw)
      if (split) {
        amountRaw = split.amount
        currency = split.currency
      }
    }
    if (!currency) {
      currency =
        normalizeCurrency(get(row, 'currency')) ?? options.defaultCurrency ?? null
    }
    if (!currency) currency = 'CHF'

    // two-column debit/credit layout
    let signedNumber: number | null = null
    let direction: Direction
    let magnitude: number
    if (options.signConvention === 'two_columns') {
      const d = parseNumberFlexible(
        options.debitColumn ? row[options.debitColumn] : null,
        numOpts(options),
      )
      const c = parseNumberFlexible(
        options.creditColumn ? row[options.creditColumn] : null,
        numOpts(options),
      )
      if (d != null && d !== 0) {
        direction = 'debit'
        magnitude = Math.abs(d)
      } else if (c != null && c !== 0) {
        direction = 'credit'
        magnitude = Math.abs(c)
      } else {
        direction = options.defaultDirection ?? 'debit'
        magnitude = 0
        errors.push('no debit/credit amount')
      }
    } else {
      signedNumber = parseNumberFlexible(amountRaw, numOpts(options))
      if (signedNumber == null) {
        errors.push('unparseable amount')
        direction = options.defaultDirection ?? 'debit'
        magnitude = 0
      } else {
        const r = deriveDirection(signedNumber, row, options, errors)
        direction = r.direction
        magnitude = r.magnitude
      }
    }

    if (!txDate) errors.push('missing/invalid date')

    const amountMinor = toMinor(magnitude, currency) * (direction === 'debit' ? -1 : 1)

    // original / FX
    let originalAmount: number | null = null
    let originalCurrency: string | null = normalizeCurrency(
      get(row, 'originalCurrency'),
    )
    const origRaw = get(row, 'originalAmount')
    if (origRaw != null && String(origRaw).trim() !== '') {
      const origNum = parseNumberFlexible(origRaw, numOpts(options))
      if (origNum != null && originalCurrency) {
        originalAmount =
          toMinor(Math.abs(origNum), originalCurrency) *
          (direction === 'debit' ? -1 : 1)
      }
    }
    // only keep FX fields when the original currency actually differs
    if (!originalCurrency || originalCurrency === currency) {
      originalAmount = null
      originalCurrency = null
    }
    const fxRate = parseNumberFlexible(get(row, 'fxRate'), numOpts(options))

    out.push({
      txDate: txDate ?? '',
      bookingDate,
      valueDate,
      direction,
      amount: amountMinor,
      currency,
      originalAmount,
      originalCurrency,
      fxRate: fxRate ?? null,
      merchant: str(get(row, 'merchant')),
      description: str(get(row, 'description')),
      reference: str(get(row, 'reference')),
      counterparty: str(get(row, 'counterparty')),
      category: str(get(row, 'category')),
      statusText: str(get(row, 'statusText')),
      raw: row,
      errors,
    })
  }
  return out
}
