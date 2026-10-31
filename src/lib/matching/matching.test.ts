import { describe, expect, it } from 'vitest'
import { DEFAULT_MATCHING_CONFIG as cfg } from './config.ts'
import {
  amountScore,
  compositeAccounting,
  dateScoreAcc,
  dateScoreBank,
  scoreAmountPair,
} from './scorers.ts'
import {
  jaroWinkler,
  merchantSimilarity,
  normalizeMerchant,
  tokenSetRatio,
} from './similarity.ts'
import { findSubsetSums } from './groups.ts'

describe('similarity', () => {
  const noise = new Set(cfg.noiseTokens)
  const city = new Set(cfg.cityCountry)

  it('normalizes away legal forms, geo and ids', () => {
    expect(normalizeMerchant('Brick Occasion SA, Bulle 12345', noise, city)).toBe(
      'brick occasion',
    )
    expect(normalizeMerchant('MEDIAMARKT ZÜRICH', noise, city)).toBe('mediamarkt')
  })
  it('drops a trailing invoice suffix but keeps names with digits', () => {
    expect(normalizeMerchant('GOOGLE*CLOUD WHJ9ZX', noise, city)).toBe('google cloud')
    expect(normalizeMerchant('Google CLOUD KWV7Qw', noise, city)).toBe('google cloud')
    expect(normalizeMerchant('1Password', noise, city)).toBe('1password')
    expect(normalizeMerchant('Pho91 B.V.', noise, city)).toContain('pho91')
  })
  it('jaroWinkler rewards prefix matches', () => {
    expect(jaroWinkler('anthropic', 'anthropic')).toBe(1)
    expect(jaroWinkler('mediamarkt', 'media markt')).toBeGreaterThan(0.8)
  })
  it('tokenSetRatio is order-independent', () => {
    expect(tokenSetRatio('new york pizza', 'pizza new york')).toBe(1)
  })
  it('merchantSimilarity high for true matches, null for empty', () => {
    expect(
      merchantSimilarity('anthropic', 'anthropic claude', cfg.merchantBlend),
    ).toBeGreaterThan(0.8)
    expect(merchantSimilarity('', 'foo', cfg.merchantBlend)).toBeNull()
  })
})

describe('amount scoring', () => {
  it('exact match = 1', () => {
    expect(scoreAmountPair(10000, 10000, false, cfg)).toBe(1)
  })
  it('within tolerance stays high', () => {
    expect(scoreAmountPair(10000, 10040, false, cfg)).toBeGreaterThan(0.6)
  })
  it('far apart = 0', () => {
    expect(scoreAmountPair(10000, 50000, false, cfg)).toBe(0)
  })
  it('multi-basis picks the best candidate', () => {
    // billed CHF converted is off, but original USD is exact
    const score = amountScore(
      [
        { minor: 9500, crossCurrency: true },
        { minor: 12065, crossCurrency: false },
      ],
      12065,
      cfg,
    )
    expect(score).toBe(1)
  })
})

describe('date scoring', () => {
  it('decays by half-life for accounting', () => {
    expect(dateScoreAcc('2025-01-01', '2025-01-01', cfg)).toBe(1)
    expect(dateScoreAcc('2025-01-01', '2025-01-03', cfg)).toBeCloseTo(0.5, 1)
  })
  it('penalizes bank credit before the charge', () => {
    expect(dateScoreBank('2025-01-10', '2025-01-01', cfg)).toBeLessThan(0.1)
    expect(dateScoreBank('2025-01-01', '2025-01-08', cfg)).toBeGreaterThan(0.4)
  })
})

describe('composite', () => {
  it('renormalizes when merchant is missing', () => {
    const withMerchant = compositeAccounting(
      { amount: 1, merchant: 1, date: 1 },
      cfg,
    )
    const noMerchant = compositeAccounting(
      { amount: 1, merchant: null, date: 1 },
      cfg,
    )
    expect(withMerchant).toBe(100)
    expect(noMerchant).toBe(100)
  })
})

describe('subset-sum grouping', () => {
  it('finds a subset that sums to the target within tolerance', () => {
    const items = [
      { id: 'a', minor: 24780, date: '2025-01-05' },
      { id: 'b', minor: 8900, date: '2025-01-06' },
      { id: 'c', minor: 1250, date: '2025-01-07' },
      { id: 'd', minor: 99999, date: '2025-01-01' },
    ]
    const groups = findSubsetSums(items, 34930, 5, { minSize: 2 })
    expect(groups.length).toBeGreaterThan(0)
    expect(groups[0].ids.sort()).toEqual(['a', 'b', 'c'])
  })
})
