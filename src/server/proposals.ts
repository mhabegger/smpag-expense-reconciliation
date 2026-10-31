import { createServerFn } from '@tanstack/react-start'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db/client.ts'
import {
  accounts,
  auditLog,
  matchCandidates,
  matchGroupMembers,
  matchGroups,
  transactions,
} from '#/db/schema.ts'
import { recomputeAnchorStatus } from '#/lib/matching/engine.ts'
import { buildYearPlan, COMPANY_CLASS } from '#/lib/matching/yearPlan.ts'
import { CLASSIFICATIONS, type Classification } from '#/db/schema.ts'

/** The company classification an accounting book belongs to. */
function classOfBook(accountId: string): Classification | null {
  const inst = db
    .select({ institute: accounts.institute })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get()?.institute
  return inst === 'smp_accounting'
    ? COMPANY_CLASS.smp
    : inst === 'deliver_media_accounting'
      ? COMPANY_CLASS.dm
      : null
}

const yearInput = z.object({ year: z.number().int().min(2000).max(2100) })
const pairInput = z.object({ docId: z.string().min(1), paymentId: z.string().min(1) })

/** Pairs the user rejected: stored as dismissed accounting candidates. */
function dismissedPairs(): Set<string> {
  return new Set(
    db
      .select({ a: matchCandidates.anchorTxId, c: matchCandidates.candidateTxId })
      .from(matchCandidates)
      .where(
        and(eq(matchCandidates.matchType, 'accounting'), eq(matchCandidates.status, 'dismissed')),
      )
      .all()
      .map((r) => `${r.a}|${r.c}`),
  )
}

/**
 * Probable document ↔ payment links that need a human: the same amount on
 * a card that's not normally used for expenses, a differing merchant name,
 * or a card amount above the document (tip).
 */
export const getProposals = createServerFn({ method: 'POST' })
  .validator((d: unknown) => yearInput.parse(d))
  .handler(async ({ data }) => {
    const { plan, credits } = buildYearPlan(data.year)
    const dismissed = dismissedPairs()
    const creditById = new Map(credits.map((c) => [c.id, c]))
    return plan
      .filter((r) => r.payment?.confidence === 'review')
      .filter((r) => !dismissed.has(`${r.payment!.payment.id}|${r.doc.id}`))
      .map((r) => {
        const p = r.payment!.payment
        const credit = r.payout?.credits[0] ? creditById.get(r.payout.credits[0].id) : null
        return {
          doc: r.doc,
          payment: p,
          method: r.payment!.method,
          reason:
            r.payment!.method === 'tip'
              ? 'Card amount higher than the document (tip?)'
              : r.payment!.method === 'fx-estimate'
                ? 'Amount converted from a foreign currency'
                : p.source === 'Viseca'
                  ? 'Same amount, paid with Viseca'
                  : 'Same amount, different merchant name',
          classificationConflict:
            p.classification !== 'unclassified' && p.classification !== COMPANY_CLASS[r.doc.company]
              ? p.classification
              : null,
          payout: credit ? { date: credit.date, chf: credit.chf } : null,
        }
      })
  })

/** Link the document to the payment, classify the payment, move its payout. */
export const confirmProposal = createServerFn({ method: 'POST' })
  .validator((d: unknown) => pairInput.parse(d))
  .handler(async ({ data }) => {
    const touched = new Set<string>()
    const res = db.transaction((tx) => {
      const doc = tx.select().from(transactions).where(eq(transactions.id, data.docId)).get()
      const pay = tx.select().from(transactions).where(eq(transactions.id, data.paymentId)).get()
      if (!doc || !pay) return { ok: false as const, error: 'Document or payment no longer exists' }
      const used = tx
        .select({ id: matchGroups.id })
        .from(matchGroupMembers)
        .innerJoin(matchGroups, eq(matchGroupMembers.groupId, matchGroups.id))
        .where(
          and(
            eq(matchGroupMembers.txId, doc.id),
            eq(matchGroups.matchType, 'accounting'),
            isNull(matchGroups.revokedAt),
          ),
        )
        .get()
      if (used) return { ok: false as const, error: 'This document is already linked' }

      const cls = classOfBook(doc.accountId)
      const prevClassification = pay.classification
      // confirming means the payment was this company's expense
      if (cls && pay.classification !== cls)
        tx.update(transactions)
          .set({
            classification: cls,
            classificationSource: 'user',
            classifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(transactions.id, pay.id))
          .run()

      const g = tx
        .insert(matchGroups)
        .values({
          anchorTxId: pay.id,
          matchType: 'accounting',
          matchedAmount: Math.abs(doc.amount),
          currency: doc.currency,
          confidence: 100,
        })
        .returning()
        .get()
      tx.insert(matchGroupMembers)
        .values({ groupId: g.id, txId: doc.id, contributedAmount: Math.abs(doc.amount) })
        .run()

      // a payout already linked to the document now belongs to the payment
      tx.update(matchGroups)
        .set({ anchorTxId: pay.id })
        .where(
          and(
            eq(matchGroups.anchorTxId, doc.id),
            eq(matchGroups.matchType, 'reimbursement'),
            isNull(matchGroups.revokedAt),
          ),
        )
        .run()

      tx.insert(auditLog)
        .values({
          entity: 'transaction',
          entityId: pay.id,
          action: 'confirm_proposal',
          detail: { docId: doc.id, groupId: g.id },
        })
        .run()
      touched.add(pay.id)
      touched.add(doc.id)
      return { ok: true as const, groupId: g.id, prevClassification }
    })
    for (const id of touched) recomputeAnchorStatus(id)
    return res
  })

/** "Not this one": remember the rejection so it isn't proposed again. */
export const dismissProposal = createServerFn({ method: 'POST' })
  .validator((d: unknown) => pairInput.parse(d))
  .handler(async ({ data }) => {
    db.insert(matchCandidates)
      .values({
        anchorTxId: data.paymentId,
        candidateTxId: data.docId,
        matchType: 'accounting',
        score: 0,
        scoreBreakdown: { amount: 0, date: 0, merchant: null, currency: 0 },
        reason: 'Rejected on the suggestions page',
        status: 'dismissed',
        runId: 'proposals',
      })
      .run()
    return { ok: true as const }
  })

/** Undo a dismissal (used by Ctrl+Z). */
export const undismissProposal = createServerFn({ method: 'POST' })
  .validator((d: unknown) => pairInput.parse(d))
  .handler(async ({ data }) => {
    db.delete(matchCandidates)
      .where(
        and(
          eq(matchCandidates.anchorTxId, data.paymentId),
          eq(matchCandidates.candidateTxId, data.docId),
          eq(matchCandidates.status, 'dismissed'),
          eq(matchCandidates.runId, 'proposals'),
        ),
      )
      .run()
    return { ok: true as const }
  })

const undoInput = pairInput.extend({
  groupId: z.string().min(1),
  prevClassification: z.string(),
})

/** Undo a confirmation (used by Ctrl+Z): drop the link, move the payout back. */
export const unconfirmProposal = createServerFn({ method: 'POST' })
  .validator((d: unknown) => undoInput.parse(d))
  .handler(async ({ data }) => {
    db.transaction((tx) => {
      tx.delete(matchGroupMembers).where(eq(matchGroupMembers.groupId, data.groupId)).run()
      tx.delete(matchGroups).where(eq(matchGroups.id, data.groupId)).run()
      // proposals never use a payment that already had links (planChain skips
      // taken payments), so any payout on it now came from the document
      const payoutForDoc = tx
        .select({ id: matchGroups.id })
        .from(matchGroups)
        .innerJoin(matchGroupMembers, eq(matchGroupMembers.groupId, matchGroups.id))
        .where(
          and(
            eq(matchGroups.anchorTxId, data.paymentId),
            eq(matchGroups.matchType, 'reimbursement'),
            isNull(matchGroups.revokedAt),
          ),
        )
        .all()
      const prev = z.enum(CLASSIFICATIONS).parse(data.prevClassification)
      tx.update(transactions)
        .set(
          prev === 'unclassified'
            ? { classification: prev, classificationSource: null, classifiedAt: null }
            : { classification: prev, classificationSource: 'user', classifiedAt: new Date() },
        )
        .where(eq(transactions.id, data.paymentId))
        .run()
      for (const g of payoutForDoc)
        tx.update(matchGroups).set({ anchorTxId: data.docId }).where(eq(matchGroups.id, g.id)).run()
    })
    recomputeAnchorStatus(data.paymentId)
    recomputeAnchorStatus(data.docId)
    return { ok: true as const }
  })
