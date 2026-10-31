import { describe, expect, it } from 'vitest'
import {
  excelSerialToIso,
  normalizeCurrency,
  parseDateFlexible,
  parseNumberFlexible,
  splitAmountCurrency,
} from './transforms.ts'
import { mapRowsToCanonical } from './parsers/tabular.ts'

describe('parseNumberFlexible', () => {
  it('parses Swiss apostrophe thousands', () => {
    expect(parseNumberFlexible("1'234.56")).toBe(1234.56)
    expect(parseNumberFlexible('3’820.00 CHF')).toBe(3820) // unicode apostrophe + code
  })
  it('parses comma decimal (de)', () => {
    expect(parseNumberFlexible('1.234,56')).toBe(1234.56)
    expect(parseNumberFlexible('1234,56')).toBe(1234.56)
  })
  it('parses English grouping', () => {
    expect(parseNumberFlexible('1,234.56')).toBe(1234.56)
  })
  it('parses 3-decimal Viseca amounts with explicit dot', () => {
    expect(parseNumberFlexible('46.500', { decimalSeparator: '.' })).toBe(46.5)
  })
  it('handles negatives and parentheses', () => {
    expect(parseNumberFlexible('-12.50')).toBe(-12.5)
    expect(parseNumberFlexible('(12.50)')).toBe(-12.5)
    expect(parseNumberFlexible('12.50-')).toBe(-12.5)
  })
  it('returns null for junk', () => {
    expect(parseNumberFlexible('abc')).toBeNull()
    expect(parseNumberFlexible('')).toBeNull()
  })
})

describe('parseDateFlexible', () => {
  it('parses ISO and ISO datetime', () => {
    expect(parseDateFlexible('2025-01-03')).toBe('2025-01-03')
    expect(parseDateFlexible('2025-01-03 00:00:00.0')).toBe('2025-01-03')
  })
  it('parses dd.MM.yyyy and dd/MM/yyyy', () => {
    expect(parseDateFlexible('03.04.2025', 'dd.MM.yyyy')).toBe('2025-04-03')
    expect(parseDateFlexible('22/06/2026', 'dd/MM/yyyy')).toBe('2026-06-22')
  })
  it('converts Excel serials', () => {
    expect(parseDateFlexible(46196, 'excel-serial')).toBe(excelSerialToIso(46196))
    expect(excelSerialToIso(46196)).toMatch(/^2026-/)
  })
  it('keeps datetime serials on the same calendar day', () => {
    // 45992.75 = 2025-12-01 18:00 — the fraction is time of day, not rounding
    expect(excelSerialToIso(45992.75)).toBe(excelSerialToIso(45992))
    expect(excelSerialToIso(45992)).toBe('2025-12-01')
  })
  it('uses the local calendar day for Date objects (xlsx cellDates)', () => {
    // xlsx builds Dates at local midnight; toISOString() would report the
    // previous day for any timezone east of UTC
    expect(parseDateFlexible(new Date(2025, 11, 1))).toBe('2025-12-01')
  })
})

describe('splitAmountCurrency', () => {
  it('splits trailing currency', () => {
    expect(splitAmountCurrency('120.65 USD')).toEqual({
      amount: '120.65',
      currency: 'USD',
    })
  })
  it('splits leading currency', () => {
    expect(splitAmountCurrency("CHF 1'234.56")).toEqual({
      amount: "1'234.56",
      currency: 'CHF',
    })
  })
})

describe('normalizeCurrency', () => {
  it('maps symbols and codes', () => {
    expect(normalizeCurrency('Fr.')).toBe('CHF')
    expect(normalizeCurrency('€')).toBe('EUR')
    expect(normalizeCurrency('usd')).toBe('USD')
  })
  it('does not fall for prototype keys', () => {
    expect(normalizeCurrency('constructor')).not.toBe('[object Object]')
  })
})

describe('mapRowsToCanonical — debit/credit indicator', () => {
  const fieldMap = { txDate: 'Date', amount: 'Amount' }
  const options = {
    signConvention: 'debit_credit_indicator' as const,
    debitCreditColumn: 'DC',
    defaultCurrency: 'CHF',
  }
  const row = (dc: string) => ({ Date: '2026-01-05', Amount: '10.00', DC: dc })

  it('matches indicator tokens exactly, not by substring', () => {
    const [debit, credit, gutschrift] = mapRowsToCanonical(
      [row('Debit'), row('Credit'), row('Gutschrift')],
      fieldMap,
      options,
    )
    expect(debit.direction).toBe('debit') // exact token
    expect(credit.direction).toBe('credit') // "credit" contains "d" — must NOT be debit
    expect(gutschrift.direction).toBe('credit') // contains "s" — must NOT be debit
  })
  it('flags unknown indicator values', () => {
    const [r] = mapRowsToCanonical([row('???')], fieldMap, options)
    expect(r.errors).toContain('unknown debit/credit indicator "???"')
  })
})

describe('mapRowsToCanonical — skipped statuses', () => {
  it('drops reverted card holds (Revolut State = REVERTED)', () => {
    const rows = mapRowsToCanonical(
      [
        { Date: '2025-12-27', Amount: '-45.00', State: 'REVERTED' },
        { Date: '2025-12-27', Amount: '-10.26', State: 'COMPLETED' },
      ],
      { txDate: 'Date', amount: 'Amount', statusText: 'State' },
      { signConvention: 'signed', defaultCurrency: 'CHF', skipStatuses: ['REVERTED'] },
    )
    expect(rows.map((r) => r.amount)).toEqual([-1026])
  })
})
