// Central, user-tunable configuration for the matching engine.
// Persisted as a single JSON row in app_settings (id = 1); these are the defaults.

export interface MatchingConfig {
  windows: {
    accBefore: number
    accAfter: number
    bankBefore: number
    bankAfter: number
    groupBankBefore: number
    groupBankAfter: number
  }
  amount: {
    absTolMinor: number
    pctTolSame: number
    pctTolCross: number
    fxMarkupTol: number
  }
  date: {
    halfLifeAcc: number
    halfLifeBank: number
  }
  weightsAB: { amount: number; merchant: number; date: number }
  weightsAC: { amount: number; date: number }
  weightsACText: { amount: number; text: number; date: number }
  merchantBlend: { tokenSet: number; jaroWinkler: number; levenshtein: number }
  thresholds: { high: number; mid: number; hide: number }
  group: { maxPool: number; maxResults: number }
  topN: number
  noiseTokens: string[]
  cityCountry: string[]
}

export const DEFAULT_NOISE_TOKENS: string[] = [
  // legal forms
  'gmbh', 'ag', 'sa', 'sarl', 'srl', 'ltd', 'limited', 'inc', 'incorporated',
  'llc', 'plc', 'co', 'kg', 'ohg', 'ug', 'bv', 'nv', 'oy', 'ab', 'spa', 'corp',
  'company', 'holding', 'group',
  // card-network / payment noise
  'visa', 'mastercard', 'mc', 'maestro', 'amex', 'debit', 'credit', 'card',
  'pos', 'kauf', 'achat', 'paiement', 'purchase', 'payment', 'paypal', 'sumup',
  'square', 'stripe', 'klarna', 'twint',
  // generic business words
  'the', 'and', 'und', 'der', 'die', 'das', 'services', 'service', 'online',
  'shop', 'store', 'www', 'com', 'int', 'intl', 'international',
  // misc
  'nr', 'no', 'ref', 'id', 'trans', 'transaction', 'chf', 'usd', 'eur',
]

export const DEFAULT_CITY_COUNTRY: string[] = [
  'zurich', 'zuerich', 'geneva', 'geneve', 'bern', 'basel', 'lausanne',
  'luzern', 'lugano', 'fribourg', 'freiburg', 'romont', 'bulle', 'martigny',
  'gland', 'switzerland', 'schweiz', 'suisse', 'svizzera', 'che', 'usa', 'us',
  'germany', 'deutschland', 'fra', 'france', 'eu', 'sing', 'singapore',
]

export const DEFAULT_MATCHING_CONFIG: MatchingConfig = {
  windows: {
    accBefore: 10,
    accAfter: 10,
    bankBefore: 2,
    bankAfter: 45,
    groupBankBefore: 60,
    groupBankAfter: 5,
  },
  amount: {
    absTolMinor: 5,
    pctTolSame: 0.005,
    pctTolCross: 0.02,
    fxMarkupTol: 0.02,
  },
  date: { halfLifeAcc: 2, halfLifeBank: 7 },
  weightsAB: { amount: 0.45, merchant: 0.35, date: 0.2 },
  weightsAC: { amount: 0.7, date: 0.3 },
  weightsACText: { amount: 0.55, text: 0.2, date: 0.25 },
  merchantBlend: { tokenSet: 0.5, jaroWinkler: 0.3, levenshtein: 0.2 },
  thresholds: { high: 80, mid: 50, hide: 35 },
  group: { maxPool: 15, maxResults: 3 },
  topN: 6,
  noiseTokens: DEFAULT_NOISE_TOKENS,
  cityCountry: DEFAULT_CITY_COUNTRY,
}
