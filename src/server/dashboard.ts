import { createServerFn } from '@tanstack/react-start'
import { and, eq } from 'drizzle-orm'
import { db } from '#/db/client.ts'
import { accounts, companies, transactions } from '#/db/schema.ts'
import type { Transaction } from '#/db/types.ts'

/** CHF value in minor units; null when a foreign amount has no stored rate. */
function chfOrNull(t: Transaction): number | null {
  if (t.chfEquiv != null) return Math.abs(t.chfEquiv)
  return t.currency === 'CHF' ? Math.abs(t.amount) : null
}

// Unconvertible foreign amounts count as 0 rather than passing their raw
// minor units off as CHF; totals.missingFx reports how many were skipped.
function chf(t: Transaction): number {
  return chfOrNull(t) ?? 0
}

export const getDashboard = createServerFn({ method: 'GET' }).handler(async () => {
  const comps = db.select().from(companies).all()
  const accs = db.select().from(accounts).all()
  const accById = new Map(accs.map((a) => [a.id, a]))

  const cardDebits = db
    .select()
    .from(transactions)
    .where(
      and(eq(transactions.ledger, 'card'), eq(transactions.direction, 'debit')),
    )
    .all()

  const perCompany = comps.map((c) => {
    const exp = cardDebits.filter((t) => t.classification === c.classification)
    const totalChf = exp.reduce((s, t) => s + chf(t), 0)
    const registered = exp.filter((t) => t.accountingLinked)
    const reimbursed = exp.filter((t) => t.bankLinked)
    const fullyReconciled = exp.filter(
      (t) => t.accountingLinked && t.bankLinked,
    )
    const outstanding = exp
      .filter((t) => !t.bankLinked)
      .reduce((s, t) => s + chf(t), 0)
    return {
      companyId: c.id,
      name: c.name,
      slug: c.slug,
      classification: c.classification,
      count: exp.length,
      totalChf,
      registeredCount: registered.length,
      registeredPct: exp.length ? registered.length / exp.length : 0,
      reimbursedCount: reimbursed.length,
      reimbursedPct: exp.length ? reimbursed.length / exp.length : 0,
      fullyReconciledCount: fullyReconciled.length,
      outstandingChf: outstanding,
    }
  })

  const toRow = (t: Transaction) => ({
    id: t.id,
    txDate: t.txDate,
    merchant: t.merchant ?? t.description,
    amount: t.amount,
    currency: t.currency,
    chf: chf(t),
    classification: t.classification,
    institute: accById.get(t.accountId)?.institute ?? null,
  })

  const companyExpenses = cardDebits.filter(
    (t) =>
      t.classification === 'deliver_media' ||
      t.classification === 'swiss_media_partners',
  )

  const notRegistered = companyExpenses
    .filter((t) => !t.accountingLinked && !t.noAccountingMatch)
    .sort((a, b) => chf(b) - chf(a))
    .slice(0, 50)
    .map(toRow)

  const registeredNotReimbursed = companyExpenses
    .filter((t) => t.accountingLinked && !t.bankLinked && !t.noBankMatch)
    .sort((a, b) => chf(b) - chf(a))
    .slice(0, 50)
    .map(toRow)

  const unclassified = cardDebits.filter(
    (t) => t.classification === 'unclassified',
  ).length

  // unused reimbursement candidates: bank credits never linked
  const bankCredits = db
    .select()
    .from(transactions)
    .where(
      and(eq(transactions.ledger, 'bank'), eq(transactions.direction, 'credit')),
    )
    .all()

  return {
    perCompany,
    exceptions: {
      notRegistered,
      registeredNotReimbursed,
    },
    totals: {
      cardExpenses: cardDebits.length,
      unclassified,
      missingFx: cardDebits.filter((t) => chfOrNull(t) == null).length,
      pending: cardDebits.filter((t) => t.pending).length,
      bankCredits: bankCredits.length,
      privateCount: cardDebits.filter((t) => t.classification === 'private')
        .length,
    },
  }
})
