import { describe, expect, it } from 'vitest'
import {
  isMealMerchant,
  parsePayout,
  planChain,
  type ChainCredit,
  type ChainDoc,
  type ChainOptions,
  type ChainPayment,
} from './expenseChain.ts'
import { DEFAULT_MATCHING_CONFIG } from './config.ts'

const opts: ChainOptions = {
  expenseSources: ['Revolut', 'CornerCard', 'SwissCard'],
  noiseTokens: new Set(DEFAULT_MATCHING_CONFIG.noiseTokens),
  cityCountry: new Set(DEFAULT_MATCHING_CONFIG.cityCountry),
  blend: DEFAULT_MATCHING_CONFIG.merchantBlend,
  rate: (cur) => (cur === 'USD' ? 0.8 : cur === 'EUR' ? 0.93 : null),
}

const doc = (p: Partial<ChainDoc>): ChainDoc => ({
  id: 'd1',
  company: 'smp',
  date: '2025-06-01',
  title: 'x',
  vendor: null,
  amount: 10000,
  currency: 'CHF',
  paymentStatus: 'Abgestimmt',
  paymentMethod: 'Spesen',
  ...p,
})
const credit = (p: Partial<ChainCredit>): ChainCredit => ({
  id: 'c1',
  date: '2025-07-15',
  chf: 10000,
  company: 'smp',
  currency: 'CHF',
  credited: 10000,
  ordered: 10000,
  ...p,
})
const pay = (p: Partial<ChainPayment>): ChainPayment => ({
  id: 'p1',
  source: 'SwissCard',
  ledger: 'card',
  date: '2025-06-01',
  chf: 10000,
  origCurrency: null,
  origAmount: null,
  merchant: 'x',
  classification: 'unclassified',
  ...p,
})

describe('parsePayout', () => {
  it('reads the ordered amount before third-party fees', () => {
    const r = parsePayout(
      "Crédit SwissMediaPartners AG USD 228.99, taux de change 0.7831 Avenue de Tivoli 3 1700 Freiburg Montant d'ordre USD 239.99 Frais tiers USD 11.00",
      17932,
    )
    expect(r).toEqual({ company: 'smp', currency: 'USD', credited: 22899, ordered: 23999 })
  })
  it('matches the company name case-insensitively', () => {
    expect(parsePayout('Crédit DELIVER.MEDIA GMBH CHF 10.61', 1061).company).toBe('dm')
  })
  it('handles thousands separators', () => {
    expect(
      parsePayout("Crédit deliver.media GmbH EUR 1'430.00, taux de change 0.93", 132990)
        .credited,
    ).toBe(143000)
  })
})

describe('planChain payouts', () => {
  it('has no time limit and accepts payouts shortly before the doc date', () => {
    const late = planChain([doc({})], [credit({ date: '2026-04-20' })], [], opts)
    expect(late[0].payout?.credits[0].id).toBe('c1')
    const early = planChain([doc({ date: '2025-10-05' })], [credit({ date: '2025-09-10' })], [], opts)
    expect(early[0].payout?.confidence).toBe('auto')
  })
  it('never pays a doc from the other company or from salary', () => {
    const r = planChain(
      [doc({})],
      [credit({ company: 'dm' }), credit({ id: 'c2', chf: 1_050_000, credited: 1_050_000, ordered: 1_050_000 })],
      [],
      opts,
    )
    expect(r[0].payout).toBeNull()
  })
  it('assigns identical amounts in date order', () => {
    const r = planChain(
      [doc({ id: 'a', date: '2025-11-30' }), doc({ id: 'b', date: '2025-12-31' })],
      [credit({ id: 'late', date: '2026-03-03' }), credit({ id: 'early', date: '2026-01-07' })],
      [],
      opts,
    )
    expect(r.map((x) => x.payout?.credits[0].id)).toEqual(['early', 'late'])
  })
  it('ignores recurring identical company credits (salary)', () => {
    const monthly = ['01', '02', '03'].map((m) =>
      credit({ id: m, date: `2025-${m}-25`, company: 'dm', chf: 102295, credited: 102295, ordered: 102295 }),
    )
    const r = planChain([doc({ company: 'dm', amount: 102295 })], monthly, [], opts)
    expect(r[0].payout).toBeNull()
  })
  it('proposes a combined payout for review', () => {
    const r = planChain(
      [doc({ id: 'a', amount: 6420 }), doc({ id: 'b', amount: 1500 })],
      [credit({ chf: 7920, credited: 7920, ordered: 7920 })],
      [],
      opts,
    )
    expect(r.every((x) => x.payout?.method === 'combined' && x.payout.confidence === 'review')).toBe(true)
  })
  it('expects no payout for rejected or company-card documents', () => {
    const r = planChain(
      [doc({ paymentStatus: 'Abgelehnt' }), doc({ id: 'd2', paymentMethod: 'Kreditkarte' })],
      [credit({})],
      [],
      opts,
    )
    expect(r.map((x) => [x.expectation, x.payout])).toEqual([
      ['rejected', null],
      ['company-card', null],
    ])
  })
})

describe('planChain payment source', () => {
  it('matches foreign documents on the original amount', () => {
    const r = planChain(
      [doc({ currency: 'USD', amount: 5000 })],
      [],
      [pay({ chf: 4000, origCurrency: 'USD', origAmount: 5000 })],
      opts,
    )
    expect(r[0].payment?.method).toBe('exact')
  })
  it('ignores cards that are not used for expenses', () => {
    const r = planChain([doc({})], [], [pay({ source: 'Viseca' })], opts)
    expect(r[0].payment).toBeNull()
  })
  it('only suggests matches on secondary cards', () => {
    const r = planChain([doc({ title: 'QoQa' })], [], [pay({ source: 'Viseca', merchant: 'QoQa' })], {
      ...opts,
      secondarySources: ['Viseca'],
    })
    expect(r[0].payment?.confidence).toBe('review')
  })
  it('treats an exact amount with an unrelated name as a suggestion', () => {
    const r = planChain(
      [doc({ title: 'SBB Klassenwechsel MH', amount: 610 })],
      [],
      [pay({ chf: 610, merchant: 'Migros M Fribourg Gare' })],
      opts,
    )
    expect(r[0].payment?.confidence).toBe('review')
  })
  it('prefers the matching name over the closest date', () => {
    const r = planChain(
      [doc({ title: 'StackBlitz 17273BD2', currency: 'USD', amount: 5000 })],
      [],
      [
        pay({ id: 'medium', merchant: 'Medium', origCurrency: 'USD', origAmount: 5000 }),
        pay({ id: 'sb', date: '2025-06-03', merchant: 'StackBlitz', origCurrency: 'USD', origAmount: 5000 }),
      ],
      opts,
    )
    expect(r[0].payment).toMatchObject({ confidence: 'auto', payment: { id: 'sb' } })
  })
  it('compares names without spaces', () => {
    const r = planChain(
      [doc({ title: 'Eleven Labs MH Revolut 2025/04', currency: 'USD', amount: 10702 })],
      [],
      [pay({ source: 'Revolut', chf: 8600, merchant: 'ElevenLabs' })],
      opts,
    )
    expect(r[0].payment).toMatchObject({ method: 'fx-estimate', confidence: 'auto' })
  })
  it('estimates FX for CHF-only accounts when the name agrees', () => {
    const r = planChain(
      [doc({ currency: 'USD', amount: 26845, title: 'Speechmatics MH Revolut 2025/07' })],
      [],
      [pay({ source: 'Revolut', chf: 21600, merchant: 'Speechmatics' })],
      opts,
    )
    expect(r[0].payment).toMatchObject({ method: 'fx-estimate', confidence: 'auto' })
  })
  it('leaves a same-amount payment of another merchant to its own document', () => {
    const r = planChain(
      [
        doc({ id: 'vercel', date: '2025-09-28', currency: 'USD', amount: 2000, title: 'Vercel Inc MH Revolut 2025/10' }),
        doc({ id: 'netlify', date: '2025-10-05', currency: 'USD', amount: 2000, title: 'Netlify, Inc. QANCPE-00001' }),
      ],
      [],
      [
        pay({ id: 'rev', source: 'Revolut', date: '2025-09-28', chf: 1602, merchant: 'Vercel' }),
        pay({ id: 'sc', source: 'SwissCard', date: '2025-10-04', chf: 1665, origCurrency: 'USD', origAmount: 2000, merchant: 'Netlify' }),
      ],
      { ...opts, expenseSources: ['Revolut', 'SwissCard'] },
    )
    expect(r.map((x) => [x.doc.id, x.payment?.payment.id, x.payment?.confidence])).toEqual([
      ['vercel', 'rev', 'auto'],
      ['netlify', 'sc', 'auto'],
    ])
  })
  it('flags a tip on a meal for review', () => {
    const r = planChain(
      [doc({ title: 'mittagessen Frank + MB + MH', amount: 7680 })],
      [],
      [pay({ chf: 8500, merchant: 'Café du Tram' })],
      opts,
    )
    expect(r[0].payment).toMatchObject({ method: 'tip', confidence: 'review' })
  })
  it('never applies the tip rule to non-meal documents', () => {
    const r = planChain(
      [doc({ title: 'swiss Engineering Beitrag 2026', amount: 24000 })],
      [],
      [pay({ chf: 25500, merchant: 'Chaine du Bonheur' })],
      opts,
    )
    expect(r[0].payment).toBeNull()
  })
  it('expects no card payment for home charging', () => {
    const r = planChain(
      [doc({ title: 'Habegger Mathieu Ladestrom Auto 25/01' })],
      [],
      [pay({})],
      opts,
    )
    expect(r[0]).toMatchObject({ expectation: 'home-charging', payment: null })
  })
  it('recognises the monthly Volkswagen wallbox statement as home charging', () => {
    const r = planChain(
      [doc({ title: 'Volkswagen Group Charging GmbH 08.2025', vendor: 'Volkswagen Group Charging GmbH', amount: 7086 })],
      [],
      [pay({ chf: 7086, merchant: 'Volkswagen' })],
      opts,
    )
    expect(r[0]).toMatchObject({ expectation: 'home-charging', payment: null })
  })
})

describe('isMealMerchant', () => {
  it.each([
    ['boulangerie duvoisin', null, true],
    ['manora rest firbourg', null, true],
    ['piazza bar', null, true],
    ['arie', 'BARS, LOUNGES', true],
    ['coop', null, false],
    ['brick occasion', null, false],
    ['interets moratoires', null, false],
  ])('%s → %s', (m, mcc, want) => {
    expect(isMealMerchant(m, mcc)).toBe(want)
  })
})
