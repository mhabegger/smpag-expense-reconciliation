/**
 * Load one year's accounting documents, bank credits and card/bank payments
 * from the DB and run planChain on them. Shared by scripts/close_year.ts and
 * the suggestions page.
 */
import { eq, isNull } from 'drizzle-orm'
import { db } from '#/db/client.ts'
import { accounts, matchGroupMembers, matchGroups, transactions } from '#/db/schema.ts'
import type { Classification } from '#/db/schema.ts'
import { loadRateMap, rateFromMap } from '#/lib/fx/rates.ts'
import { getConfig } from './engine.ts'
import {
  parsePayout,
  planChain,
  type ChainCredit,
  type ChainDoc,
  type ChainPayment,
  type CompanyKey,
} from './expenseChain.ts'

export const EXPENSE_SOURCES = ['Revolut', 'CornerCard', 'SwissCard']
export const SECONDARY_SOURCES = ['Viseca']
export const COMPANY_CLASS: Record<CompanyKey, Classification> = {
  smp: 'swiss_media_partners',
  dm: 'deliver_media',
}

export function buildYearPlan(year: number) {
  const cfg = getConfig()
  const accts = new Map(db.select().from(accounts).all().map((a) => [a.id, a]))
  const companyOf = (accountId: string): CompanyKey | null => {
    const inst = accts.get(accountId)?.institute
    return inst === 'smp_accounting' ? 'smp' : inst === 'deliver_media_accounting' ? 'dm' : null
  }

  // already-confirmed links are kept and never reassigned
  const active = db
    .select({
      anchor: matchGroups.anchorTxId,
      type: matchGroups.matchType,
      member: matchGroupMembers.txId,
    })
    .from(matchGroups)
    .innerJoin(matchGroupMembers, eq(matchGroupMembers.groupId, matchGroups.id))
    .where(isNull(matchGroups.revokedAt))
    .all()
  const linkedDocs = new Set(active.filter((a) => a.type === 'accounting').map((a) => a.member))
  const taken = {
    credits: new Set(active.filter((a) => a.type === 'reimbursement').map((a) => a.member)),
    payments: new Set(active.map((a) => a.anchor)),
  }

  const all = db.select().from(transactions).all()
  const docsAll: ChainDoc[] = all
    .filter((t) => t.ledger === 'accounting' && t.txDate.startsWith(String(year)))
    .map((t) => ({
      id: t.id,
      company: companyOf(t.accountId)!,
      date: t.txDate,
      title: t.merchant ?? t.description ?? '',
      vendor: (t.rawPayload.Adresse as string | null)?.trim() || null,
      amount: Math.abs(t.amount),
      currency: t.currency,
      paymentStatus: (t.rawPayload.Zahlungsstatus as string | null) ?? null,
      paymentMethod: (t.rawPayload.Zahlungsart as string | null) ?? null,
    }))
  // documents whose payout is linked directly (no payment found at the time),
  // plus bookings marked "no payout expected" (e.g. settled via the shareholder
  // current account instead of a bank transfer)
  const paidOutDocs = new Set([
    ...active.filter((a) => a.type === 'reimbursement').map((a) => a.anchor),
    ...all.filter((t) => t.noBankMatch).map((t) => t.id),
  ])
  const docs = docsAll.filter((d) => !linkedDocs.has(d.id) && !paidOutDocs.has(d.id))
  const credits: ChainCredit[] = all
    .filter((t) => t.ledger === 'bank' && t.direction === 'credit')
    .map((t) => ({
      id: t.id,
      date: t.txDate,
      chf: t.amount,
      ...parsePayout(`${t.counterparty ?? ''} ${t.description ?? ''}`, t.amount),
    }))
  const lo = `${year - 1}-12-01`
  const hi = `${year + 1}-02-15`
  const payments: ChainPayment[] = all
    .filter(
      (t) =>
        (t.ledger === 'card' || t.ledger === 'bank') &&
        t.direction === 'debit' &&
        t.txDate >= lo &&
        t.txDate <= hi,
    )
    .map((t) => ({
      id: t.id,
      source: accts.get(t.accountId)?.label ?? '?',
      ledger: t.ledger as 'card' | 'bank',
      date: t.txDate,
      chf: Math.abs(t.amount),
      origCurrency: t.originalCurrency,
      origAmount: t.originalAmount == null ? null : Math.abs(t.originalAmount),
      merchant: t.merchant ?? t.counterparty ?? t.description,
      classification: t.classification,
    }))

  const rateMap = loadRateMap()
  const opts = {
    expenseSources: EXPENSE_SOURCES,
    secondarySources: SECONDARY_SOURCES,
    noiseTokens: new Set(cfg.noiseTokens),
    cityCountry: new Set(cfg.cityCountry),
    blend: cfg.merchantBlend,
    rate: (cur: string, date: string) => rateFromMap(rateMap, date, cur, 'CHF'),
  }
  const open = planChain(docs, credits, payments, opts, taken)
  // already paid out: only the payment is still to be found, never another payout
  const paidPlan = planChain(
    docsAll.filter((d) => !linkedDocs.has(d.id) && paidOutDocs.has(d.id)),
    [],
    payments,
    opts,
    {
      credits: new Set(),
      payments: new Set([
        ...taken.payments,
        ...open.flatMap((r) => (r.payment ? [r.payment.payment.id] : [])),
      ]),
    },
  )
  const plan = [...open, ...paidPlan]

  // A document already linked to its payment still needs its payout: Accounto
  // marks documents "Abgestimmt" that were never actually paid.
  const paymentOfDoc = new Map(
    active.filter((a) => a.type === 'accounting').map((a) => [a.member, a.anchor]),
  )
  const awaiting = docsAll.filter(
    (d) =>
      paymentOfDoc.has(d.id) &&
      !paidOutDocs.has(paymentOfDoc.get(d.id)!) &&
      !paidOutDocs.has(d.id),
  )
  const planned = plan.flatMap((r) => r.payout?.credits.map((c) => c.id) ?? [])
  const linkedPlan = planChain(awaiting, credits, [], opts, {
    credits: new Set([...taken.credits, ...planned]),
    payments: new Set(),
  }).map((r) => ({ ...r, paymentId: paymentOfDoc.get(r.doc.id)! }))

  return { plan, linkedPlan, paidOutDocs, docsAll, credits, payments, taken, all }
}
