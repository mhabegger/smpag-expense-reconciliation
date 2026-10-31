/**
 * Accounting-anchored expense chain:
 *
 *   payment (card / bank debit)  →  accounting document  →  payout (bank credit)
 *
 * The companies reimburse each submitted document with its own bank credit at
 * the exact document amount, so the accounting document — not the card
 * expense — is the natural anchor. Pure functions; the caller loads the rows
 * and decides what to persist.
 */
import { merchantSimilarity, normalizeMerchant } from './similarity.ts'
import type { MerchantBlend } from './similarity.ts'

export type CompanyKey = 'smp' | 'dm'

export interface ChainDoc {
  id: string
  company: CompanyKey
  date: string
  title: string
  vendor: string | null
  amount: number // positive minor units in `currency`
  currency: string
  paymentStatus: string | null // Accounto Zahlungsstatus
  paymentMethod: string | null // Accounto Zahlungsart
}

export interface ChainCredit {
  id: string
  date: string
  chf: number // positive minor units actually credited (CHF)
  company: CompanyKey | null
  currency: string // currency the company paid in
  credited: number // amount in `currency` that arrived
  ordered: number // amount the company ordered (before third-party fees)
}

export interface ChainPayment {
  id: string
  source: string // account label, e.g. 'SwissCard' or 'Raiffeisen'
  ledger: 'card' | 'bank'
  date: string
  chf: number // positive minor units
  origCurrency: string | null
  origAmount: number | null // positive minor units
  merchant: string | null
  classification: string
}

export type Confidence = 'auto' | 'review'

export interface PaymentLink {
  payment: ChainPayment
  method: 'exact' | 'fx-estimate' | 'tip'
  confidence: Confidence
  nameScore: number | null
}

export interface PayoutLink {
  credits: ChainCredit[]
  method: 'single' | 'combined'
  confidence: Confidence
  /** other documents settled by the same combined credit */
  siblings: string[]
}

export interface ChainResult {
  doc: ChainDoc
  /** why no payment/payout is expected, when that is the case */
  expectation: 'normal' | 'rejected' | 'company-card' | 'home-charging'
  payment: PaymentLink | null
  payout: PayoutLink | null
}

export interface ChainOptions {
  /** accounts on which private-paid, reimbursable expenses can appear */
  expenseSources: string[]
  /** accounts that occasionally carry one — matches there always need review */
  secondarySources?: string[]
  noiseTokens: Set<string>
  cityCountry: Set<string>
  blend: MerchantBlend
  /** CHF per unit of `currency` on `date` (null when unknown) */
  rate: (currency: string, date: string) => number | null
}

const DAY = 86_400_000
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(a) - Date.parse(b)) / DAY)

/** Monthly salary transfers are far above any single expense. */
export const SALARY_THRESHOLD_MINOR = 900_000

const parseAmount = (s: string) =>
  Math.round(parseFloat(s.replace(/['’]/g, '')) * 100)

/**
 * Read company + paid currency/amounts from a Raiffeisen credit text, e.g.
 * "Crédit SwissMediaPartners AG USD 228.99, taux de change 0.7831 …
 *  Montant d'ordre USD 239.99 Frais tiers USD 11.00".
 */
export function parsePayout(
  text: string,
  chf: number,
): Pick<ChainCredit, 'company' | 'currency' | 'credited' | 'ordered'> {
  const company: CompanyKey | null = /swiss\s*media\s*partners/i.test(text)
    ? 'smp'
    : /deliver\.?\s*media/i.test(text)
      ? 'dm'
      : null
  const fx = text.match(
    /\b(USD|EUR|GBP|CAD)\s+([\d'’]+\.\d{2}),\s*taux de change/i,
  )
  if (!fx) return { company, currency: 'CHF', credited: chf, ordered: chf }
  const currency = fx[1].toUpperCase()
  const credited = parseAmount(fx[2])
  const order = text.match(
    new RegExp(`Montant d'ordre\\s+${currency}\\s+([\\d'’]+\\.\\d{2})`, 'i'),
  )
  return {
    company,
    currency,
    credited,
    ordered: order ? parseAmount(order[1]) : credited,
  }
}

function expectationOf(d: ChainDoc): ChainResult['expectation'] {
  if (d.paymentStatus === 'Abgelehnt') return 'rejected'
  if (d.paymentMethod === 'Kreditkarte' || d.paymentMethod === 'Debitkarte')
    return 'company-card'
  // monthly wallbox statement (Volkswagen/Elli PDF): kWh × local tariff, never a card payment
  if (/ladestrom|volkswagen group charging|\belli\b/i.test(`${d.title} ${d.vendor ?? ''}`))
    return 'home-charging'
  return 'normal'
}

const payoutMatches = (d: ChainDoc, c: ChainCredit) =>
  c.company === d.company &&
  c.currency === d.currency &&
  (c.ordered === d.amount || c.credited === d.amount)

/** Companies pay after the document date, sometimes slightly before it. */
const PAYOUT_EARLIEST_DAYS = -30

function* combinations<T>(items: T[], k: number, start = 0): Generator<T[]> {
  if (k === 0) {
    yield []
    return
  }
  for (let i = start; i <= items.length - k; i++)
    for (const rest of combinations(items, k - 1, i + 1)) yield [items[i], ...rest]
}

export function planChain(
  docs: ChainDoc[],
  credits: ChainCredit[],
  payments: ChainPayment[],
  opts: ChainOptions,
  /** ids already part of confirmed matches (never reassigned) */
  taken: { credits: Set<string>; payments: Set<string> } = {
    credits: new Set(),
    payments: new Set(),
  },
): ChainResult[] {
  const sorted = [...docs].sort((a, b) => a.date.localeCompare(b.date))
  const usedCredits = new Set(taken.credits)
  const usedPayments = new Set(taken.payments)
  const results: ChainResult[] = sorted.map((doc) => ({
    doc,
    expectation: expectationOf(doc),
    payment: null,
    payout: null,
  }))
  const salaryLike = salaryLikeCredits(credits)
  const companyCredits = credits
    .filter((c) => c.company && !salaryLike.has(c.id))
    .sort((a, b) => a.date.localeCompare(b.date))

  // ---- payouts: one credit per document, earliest eligible first --------
  for (const r of results) {
    if (r.expectation === 'rejected' || r.expectation === 'company-card') continue
    const c = companyCredits.find(
      (c) =>
        !usedCredits.has(c.id) &&
        payoutMatches(r.doc, c) &&
        daysBetween(c.date, r.doc.date) >= PAYOUT_EARLIEST_DAYS,
    )
    if (c) {
      usedCredits.add(c.id)
      r.payout = { credits: [c], method: 'single', confidence: 'auto', siblings: [] }
    }
  }

  // ---- payouts: a leftover credit that equals 2–4 unpaid documents -------
  for (const c of companyCredits) {
    if (usedCredits.has(c.id)) continue
    const pool = results.filter(
      (r) =>
        !r.payout &&
        r.expectation !== 'rejected' &&
        r.expectation !== 'company-card' &&
        r.doc.company === c.company &&
        r.doc.currency === c.currency &&
        daysBetween(c.date, r.doc.date) >= PAYOUT_EARLIEST_DAYS &&
        daysBetween(c.date, r.doc.date) <= 365,
    )
    let found: ChainResult[] | null = null
    for (let k = 2; k <= 4 && !found && pool.length >= k; k++)
      for (const combo of combinations(pool, k)) {
        const sum = combo.reduce((s, r) => s + r.doc.amount, 0)
        if (sum === c.ordered || sum === c.credited) {
          found = combo
          break
        }
      }
    if (!found) continue
    usedCredits.add(c.id)
    for (const r of found)
      r.payout = {
        credits: [c],
        method: 'combined',
        confidence: 'review',
        siblings: found.filter((o) => o !== r).map((o) => o.doc.id),
      }
  }

  // ---- payment source ----------------------------------------------------
  const norm = (s: string | null | undefined) =>
    normalizeMerchant(s, opts.noiseTokens, opts.cityCountry)
  const secondary = new Set(opts.secondarySources ?? [])
  const eligible = payments.filter((p) =>
    p.ledger === 'bank' ||
    opts.expenseSources.includes(p.source) ||
    secondary.has(p.source),
  )
  // a match on a secondary account is never written without a human
  const conf = (p: ChainPayment, ok: boolean): Confidence =>
    ok && !secondary.has(p.source) ? 'auto' : 'review'
  for (const r of results) {
    if (r.expectation === 'home-charging') continue
    const d = r.doc
    const docName = norm(`${d.vendor ?? ''} ${d.title}`)
    const nameScore = (p: ChainPayment) => {
      const pn = norm(p.merchant)
      const s = merchantSimilarity(docName, pn, opts.blend)
      // "ElevenLabs" vs "Eleven Labs": compare without spaces as well
      const compact = pn.replace(/ /g, '')
      return compact.length >= 5 && docName.replace(/ /g, '').includes(compact)
        ? Math.max(s ?? 0, 0.85)
        : s
    }
    // bills are often paid by e-banking some days after the invoice date
    const inWindow = (p: ChainPayment) => {
      const dd = daysBetween(p.date, d.date)
      return p.ledger === 'bank' ? dd >= -5 && dd <= 35 : Math.abs(dd) <= 10
    }
    const open = eligible.filter((p) => !usedPayments.has(p.id) && inWindow(p))
    const byCloseness = (a: ChainPayment, b: ChainPayment) =>
      Math.abs(daysBetween(a.date, d.date)) - Math.abs(daysBetween(b.date, d.date))
    const fxCandidates = () => {
      if (d.currency === 'CHF') return []
      const rate = opts.rate(d.currency, d.date)
      if (rate == null) return []
      const est = d.amount * rate
      return open
        .filter((p) => p.origCurrency == null && Math.abs(p.chf - est) <= est * 0.04 + 30)
        .map((p) => ({ p, s: nameScore(p) ?? 0 }))
        .filter((x) => x.s >= 0.6)
        .sort((a, b) => b.s - a.s)
    }

    // 1) exact amount in the document currency (CHF receipts may differ by
    //    rounding). Small amounts collide by coincidence, so the best name
    //    wins and a weak name is only a suggestion.
    const exact = open
      .filter((p) =>
        d.currency === 'CHF'
          ? p.origCurrency == null &&
            (p.chf === d.amount || (Math.abs(p.chf - d.amount) <= 10 && (nameScore(p) ?? 0) >= 0.4))
          : p.origCurrency === d.currency && p.origAmount === d.amount,
      )
      .map((p) => ({ p, s: nameScore(p) ?? 0 }))
      .sort((a, b) => b.s - a.s || byCloseness(a.p, b.p))
    const fx = fxCandidates()
    // an amount-only hit loses to a converted amount from the same merchant
    // (20 USD Vercel on Revolut vs. 20 USD Netlify on SwissCard)
    if (exact.length && !(exact[0].s < 0.4 && fx.length)) {
      const { p, s } = exact[0]
      usedPayments.add(p.id)
      r.payment = { payment: p, method: 'exact', confidence: conf(p, s >= 0.4), nameScore: s }
      continue
    }

    // 2) foreign document paid from a CHF-only account (Revolut): estimate
    if (fx.length) {
      const { p, s } = fx[0]
      usedPayments.add(p.id)
      r.payment = {
        payment: p,
        method: 'fx-estimate',
        confidence: conf(p, s >= 0.75 && fx.length === 1),
        nameScore: s,
      }
      continue
    }

    // 3) restaurant / hotel receipts: the card amount includes a tip or tax.
    //    Only for meal-like documents or when the names agree.
    if (d.currency === 'CHF' && r.expectation === 'normal' && d.amount >= 2000) {
      const mealDoc = MEAL_DOC.test(`${d.vendor ?? ''} ${d.title}`)
      const cands = open
        .filter(
          (p) =>
            p.ledger === 'card' &&
            p.origCurrency == null &&
            p.chf > d.amount &&
            p.chf <= d.amount * 1.2 + 100 &&
            daysBetween(p.date, d.date) >= -1 &&
            daysBetween(p.date, d.date) <= 3,
        )
        .map((p) => ({ p, s: nameScore(p) ?? 0 }))
        .filter((x) => x.s >= 0.6 || (mealDoc && isMealMerchant(norm(x.p.merchant), null)))
        .sort((a, b) => b.s - a.s || byCloseness(a.p, b.p))
      if (cands.length) {
        const { p, s } = cands[0]
        usedPayments.add(p.id)
        r.payment = {
          payment: p,
          method: 'tip',
          confidence: conf(p, s >= 0.6 && cands.length === 1),
          nameScore: s,
        }
      }
    }
  }
  return results
}

/**
 * Credits that are not expense payouts: anything at salary level, plus a
 * company paying the same amount (≥ 500 CHF) three or more times.
 */
export function salaryLikeCredits(credits: ChainCredit[]): Set<string> {
  const counts = new Map<string, number>()
  const key = (c: ChainCredit) => `${c.company}|${c.chf}`
  for (const c of credits)
    if (c.company && c.chf >= 50_000) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1)
  return new Set(
    credits
      .filter(
        (c) =>
          c.company &&
          (c.chf >= SALARY_THRESHOLD_MINOR || (counts.get(key(c)) ?? 0) >= 3),
      )
      .map((c) => c.id),
  )
}

const MEAL_DOC =
  /essen|mittag|abend|apero|apéro|drinks|dinner|lunch|fr[uü]hst[uü]ck|verpflegung|restaurant|resto|caf[eé]|brasserie|hotel|motel|[uü]bernachtung/i

// ---------------------------------------------------------------------------
// Meals: sub-50 CHF restaurant/café/bakery spend is covered by the ZEP meal
// lump sum, never submitted as an expense.
// ---------------------------------------------------------------------------
const FOOD_MCC =
  /EATING PLACES|RESTAURANTS|BARS|LOUNGES|FAST FOOD|BAKERIES|CATERERS/i
const FOOD_NAME =
  /\b(rest|restaurant|ristorante|brasserie|bistro|pizzeria|pizza|trattoria|cafe|caffe|coffee|barista|brulerie|bar|pub|boulangerie|boul|bakery|bakerybakery|backerei|baeckerei|bread|patisserie|confiserie|gelato|glacier|burgers?|mcdonalds?|mcdonaldis|donald s|kebab|sushi|tibits|kitchen|tandoori|burrito|turbobao|umamido|frittenwerk|holy cow|cinnamon roll|cookie|juice|food|selecta|elvetino|epi d or|fleur de pains|passe creme|piquenique|brew|notzet|moosbar|kleine chance|sawa|bekaa|ly thanh|tea ?room|snack|take ?away|imbiss)\b/

export function isMealMerchant(
  merchantNorm: string | null,
  mcc: string | null,
): boolean {
  if (mcc && FOOD_MCC.test(mcc)) return true
  return !!merchantNorm && FOOD_NAME.test(merchantNorm)
}
