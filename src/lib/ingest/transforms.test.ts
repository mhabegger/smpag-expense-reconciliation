import { describe, expect, it } from 'vitest'
import {
  excelSerialToIso,
  normalizeCurrency,
  parseDateFlexible,
  parseNumberFlexible,
  splitAmountCurrency,
} from './transforms.ts'

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
})
