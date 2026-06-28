import { describe, expect, it } from 'vitest'
import { currencyDecimals, formatMoney, fromMinor, toMinor } from './money.ts'

describe('money', () => {
  it('uses correct decimals per currency', () => {
    expect(currencyDecimals('CHF')).toBe(2)
    expect(currencyDecimals('JPY')).toBe(0)
  })
  it('round-trips minor units without float drift', () => {
    expect(toMinor(0.1 + 0.2, 'CHF')).toBe(30)
    expect(fromMinor(12065, 'USD')).toBe(120.65)
  })
  it('formats with currency code', () => {
    expect(formatMoney(123450, 'CHF')).toContain('CHF')
    expect(formatMoney(null, 'CHF')).toBe('—')
  })
})
