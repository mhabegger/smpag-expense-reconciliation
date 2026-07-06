import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
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
import type { Transaction } from '#/db/types.ts'
import { convertMinor, loadRateMap } from '#/lib/fx/rates.ts'
import {
  recomputeAnchorStatus,
  runMatching as runMatchingEngine,
} from '#/lib/matching/engine.ts'
import { merchantNoteFor } from '#/server/notes-db.ts'
import { txDto } from '#/server/_dto.ts'

export const runMatching = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    z.object({ anchorTxId: z.string().optional() }).parse(d ?? {}),
  )
  .handler(async ({ data }) => {
    return runMatchingEngine({ anchorTxId: data.anchorTxId })
  })

const queueFilter = z.object({
  classification: z
    .enum(['deliver_media', 'swiss_media_partners', 'private', 'unclassified'])
    .optional(),
  status: z
    .enum(['all', 'open', 'unclassified', 'reconciled', 'pending'])
    .default('all'),
  institute: z.string().optional(),
})

// "open" = classified to a company but not fully reconciled — used by BOTH
// the filter and the count so the badge always equals the rows shown
function isOpen(t: Transaction): boolean {
  return (
    (t.classification === 'deliver_media' ||
      t.classification === 'swiss_media_partners') &&
    (t.reconStatus === 'open' || t.reconStatus === 'partially_matched')
  )
}

export const getReconQueue = createServerFn({ method: 'POST' })
  .validator((d: unknown) => queueFilter.parse(d ?? {}))
  .handler(async ({ data: f }) => {
    const accs = db.select().from(accounts).all()
    const byId = new Map(accs.map((a) => [a.id, a]))
    const all = db
      .select()
      .from(transactions)
      .where(
        and(eq(transactions.ledger, 'card'), eq(transactions.direction, 'debit')),
      )
      .orderBy(asc(transactions.classification), desc(transactions.txDate))
      .all()

    const items = all
      .filter((t) => {
        if (f.classification && t.classification !== f.classification) return false
        if (f.institute && byId.get(t.accountId)?.institute !== f.institute)
          return false
        if (f.status === 'unclassified')
          return t.classification === 'unclassified'
        if (f.status === 'pending') return t.pending
        if (f.status === 'open') return isOpen(t)
        if (f.status === 'reconciled') return t.reconStatus === 'matched'
        return true
      })
      .map((t) => ({
        id: t.id,
        txDate: t.txDate,
        merchant: t.merchant ?? t.description,
        amount: t.amount,
        currency: t.currency,
        originalAmount: t.originalAmount,
        originalCurrency: t.originalCurrency,
        classification: t.classification,
        reconStatus: t.reconStatus,
        accountingLinked: t.accountingLinked,
        bankLinked: t.bankLinked,
        noAccountingMatch: t.noAccountingMatch,
        noBankMatch: t.noBankMatch,
        pending: t.pending,
        institute: byId.get(t.accountId)?.institute ?? null,
        accountLabel: byId.get(t.accountId)?.label ?? null,
      }))

    const counts = {
      total: all.length,
      unclassified: all.filter((t) => t.classification === 'unclassified').length,
      reconciled: all.filter((t) => t.reconStatus === 'matched').length,
      pending: all.filter((t) => t.pending).length,
      open: all.filter(isOpen).length,
    }
    return { items, counts }
  })

function txById(ids: string[]): Map<string, Transaction> {
  if (ids.length === 0) return new Map()
  const rows = db
    .select()
    .from(transactions)
    .where(inArray(transactions.id, ids))
    .all()
  return new Map(rows.map((r) => [r.id, r]))
}

export const getReconcileItem = createServerFn({ method: 'GET' })
  .validator((d: unknown) => z.string().min(1).parse(d))
  .handler(async ({ data: id }) => {
    const tx = db.select().from(transactions).where(eq(transactions.id, id)).get()
    if (!tx) return null
    const account = db
      .select()
      .from(accounts)
      .where(eq(accounts.id, tx.accountId))
      .get()

    const cands = db
      .select()
      .from(matchCandidates)
      .where(
        and(
          eq(matchCandidates.anchorTxId, id),
          eq(matchCandidates.status, 'suggested'),
        ),
      )
      .orderBy(desc(matchCandidates.score))
      .all()

    const refIds = new Set<string>()
    for (const c of cands) {
      if (c.candidateTxId) refIds.add(c.candidateTxId)
      for (const m of c.groupMemberIds ?? []) refIds.add(m)
    }
    const refMap = txById([...refIds])

    const expand = (c: (typeof cands)[number]) => ({
      id: c.id,
      matchType: c.matchType,
      score: c.score,
      scoreBreakdown: c.scoreBreakdown,
      reason: c.reason,
      convertedAmount: c.convertedAmount,
      candidate: c.candidateTxId
        ? (() => {
            const t = refMap.get(c.candidateTxId)
            return t ? txDto(t) : null
          })()
        : null,
      groupMembers: (c.groupMemberIds ?? [])
        .map((mid) => refMap.get(mid))
        .filter((x): x is Transaction => !!x)
        .map(txDto),
    })

    const accountingCandidates = cands
      .filter((c) => c.matchType === 'accounting')
      .map(expand)
    const bankCandidates = cands
      .filter((c) => c.matchType === 'reimbursement')
      .map(expand)

    // confirmed groups for this anchor
    const groups = db
      .select()
      .from(matchGroups)
      .where(
        and(eq(matchGroups.anchorTxId, id), isNull(matchGroups.revokedAt)),
      )
      .all()
    const groupViews = groups.map((g) => {
      const members = db
        .select()
        .from(matchGroupMembers)
        .where(eq(matchGroupMembers.groupId, g.id))
        .all()
      const mTx = txById(members.map((m) => m.txId))
      return {
        ...g,
        members: members.map((m) => {
          const t = mTx.get(m.txId)
          return { ...m, tx: t ? txDto(t) : null }
        }),
      }
    })

    // other bookings from the same merchant (history) + a classification suggestion
    const norm = tx.merchantNorm
    const relatedRows = norm
      ? db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.ledger, 'card'),
              eq(transactions.merchantNorm, norm),
              ne(transactions.id, tx.id),
            ),
          )
          .orderBy(desc(transactions.txDate))
          .limit(30)
          .all()
      : []
    const related = relatedRows.map((r) => ({
      id: r.id,
      txDate: r.txDate,
      amount: r.amount,
      currency: r.currency,
      merchant: r.merchant ?? r.description,
      classification: r.classification,
      reconStatus: r.reconStatus,
      accountingLinked: r.accountingLinked,
      bankLinked: r.bankLinked,
      pending: r.pending,
    }))
    // suggestion considers the FULL merchant history, not just the 30 shown
    const tallyRows = norm
      ? db
          .select({
            cls: transactions.classification,
            c: sql<number>`count(*)`,
          })
          .from(transactions)
          .where(
            and(
              eq(transactions.ledger, 'card'),
              eq(transactions.merchantNorm, norm),
              ne(transactions.id, tx.id),
              ne(transactions.classification, 'unclassified'),
            ),
          )
          .groupBy(transactions.classification)
          .all()
      : []
    const top = tallyRows.sort((a, b) => b.c - a.c)[0]
    const suggestion = top ? { classification: top.cls, count: top.c } : null

    return {
      tx: txDto(tx),
      account: account ?? null,
      accountingCandidates,
      bankCandidates,
      groups: groupViews,
      related,
      suggestion,
      merchantNote: merchantNoteFor(tx.merchantNorm),
    }
  })

/** Thrown inside the confirm transaction to roll back with a user-facing message. */
class ConfirmError extends Error {}

export const confirmCandidate = createServerFn({ method: 'POST' })
  .validator((d: unknown) => z.string().min(1).parse(d))
  .handler(async ({ data: candidateId }) => {
    const cand = db
      .select()
      .from(matchCandidates)
      .where(eq(matchCandidates.id, candidateId))
      .get()
    if (!cand) return { ok: false as const, error: 'Candidate not found' }

    const rateMap = loadRateMap()
    let result: { affected: string[]; groupIds: string[] }
    try {
      result = db.transaction((tx) => {
      // candidates are a cache generated against an older snapshot: a tx may
      // have been consumed by another confirmation since. Re-check here or one
      // bank credit could "reimburse" two unrelated expenses.
      const isUsed = (
        txId: string,
        matchType: 'accounting' | 'reimbursement',
      ): boolean =>
        !!tx
          .select({ id: matchGroupMembers.id })
          .from(matchGroupMembers)
          .innerJoin(matchGroups, eq(matchGroupMembers.groupId, matchGroups.id))
          .where(
            and(
              eq(matchGroupMembers.txId, txId),
              eq(matchGroups.matchType, matchType),
              isNull(matchGroups.revokedAt),
            ),
          )
          .limit(1)
          .get()
      const groupIds: string[] = []
      const createGroup = (
        anchorId: string,
        matchType: 'accounting' | 'reimbursement',
        memberTxId: string,
        matchedAmount: number,
        currency: string,
      ) => {
        const g = tx
          .insert(matchGroups)
          .values({
            anchorTxId: anchorId,
            matchType,
            matchedAmount,
            currency,
            confidence: cand.score,
          })
          .returning()
          .get()
        tx.insert(matchGroupMembers)
          .values({ groupId: g.id, txId: memberTxId, contributedAmount: matchedAmount })
          .run()
        groupIds.push(g.id)
        return g.id
      }

      const affected: string[] = []
      if (cand.matchType === 'accounting' && cand.candidateTxId) {
        const target = tx
          .select()
          .from(transactions)
          .where(eq(transactions.id, cand.candidateTxId))
          .get()
        if (!target)
          throw new ConfirmError('Accounting entry no longer exists')
        if (isUsed(target.id, 'accounting'))
          throw new ConfirmError(
            'This accounting entry is already matched to another expense',
          )
        createGroup(
          cand.anchorTxId,
          'accounting',
          target.id,
          Math.abs(target.amount),
          target.currency,
        )
        affected.push(cand.anchorTxId)
        tx.delete(matchCandidates)
          .where(
            and(
              eq(matchCandidates.anchorTxId, cand.anchorTxId),
              eq(matchCandidates.matchType, 'accounting'),
              eq(matchCandidates.status, 'suggested'),
            ),
          )
          .run()
      } else if (cand.matchType === 'reimbursement' && cand.candidateTxId) {
        const bank = tx
          .select()
          .from(transactions)
          .where(eq(transactions.id, cand.candidateTxId))
          .get()
        if (!bank) throw new ConfirmError('Bank credit no longer exists')
        if (isUsed(bank.id, 'reimbursement'))
          throw new ConfirmError(
            'This bank credit already reimburses another expense',
          )
        const expenseIds = cand.groupMemberIds ?? [cand.anchorTxId]
        for (const expId of expenseIds) {
          const exp = tx
            .select()
            .from(transactions)
            .where(eq(transactions.id, expId))
            .get()
          if (!exp) continue
          if (exp.bankLinked)
            throw new ConfirmError(
              'An expense in this group is already reimbursed — re-run matching',
            )
          const contributed =
            exp.currency === bank.currency
              ? Math.abs(exp.amount)
              : convertMinor(
                  rateMap,
                  Math.abs(exp.amount),
                  exp.currency,
                  bank.currency,
                  exp.txDate,
                )
          // never record raw foreign minor units as a bank-currency amount
          if (contributed == null)
            throw new ConfirmError(
              `No FX rate for ${exp.currency}→${bank.currency} on ${exp.txDate} — run matching to fetch rates`,
            )
          createGroup(expId, 'reimbursement', bank.id, contributed, bank.currency)
          affected.push(expId)
          tx.delete(matchCandidates)
            .where(
              and(
                eq(matchCandidates.anchorTxId, expId),
                eq(matchCandidates.matchType, 'reimbursement'),
                eq(matchCandidates.status, 'suggested'),
              ),
            )
            .run()
        }
      }

      tx.insert(auditLog)
        .values({
          entity: 'match',
          entityId: cand.anchorTxId,
          action: 'confirm_match',
          detail: { candidateId, matchType: cand.matchType, affected },
        })
        .run()
      return { affected, groupIds }
      })
    } catch (e) {
      if (e instanceof ConfirmError)
        return { ok: false as const, error: e.message }
      throw e
    }

    for (const id of result.affected) recomputeAnchorStatus(id)
    return {
      ok: true as const,
      affected: result.affected,
      groupIds: result.groupIds,
    }
  })

export const rejectCandidate = createServerFn({ method: 'POST' })
  .validator((d: unknown) => z.string().min(1).parse(d))
  .handler(async ({ data: candidateId }) => {
    const res = db
      .update(matchCandidates)
      .set({ status: 'dismissed' })
      .where(eq(matchCandidates.id, candidateId))
      .run()
    return { ok: res.changes > 0 }
  })

export const restoreCandidate = createServerFn({ method: 'POST' })
  .validator((d: unknown) => z.string().min(1).parse(d))
  .handler(async ({ data: candidateId }) => {
    const res = db
      .update(matchCandidates)
      .set({ status: 'suggested' })
      .where(eq(matchCandidates.id, candidateId))
      .run()
    return { ok: res.changes > 0 }
  })

export const revokeGroup = createServerFn({ method: 'POST' })
  .validator((d: unknown) => z.string().min(1).parse(d))
  .handler(async ({ data: groupId }) => {
    const g = db
      .select()
      .from(matchGroups)
      .where(eq(matchGroups.id, groupId))
      .get()
    if (!g) return { ok: false as const }
    db.update(matchGroups)
      .set({ revokedAt: new Date() })
      .where(eq(matchGroups.id, groupId))
      .run()
    db.insert(auditLog)
      .values({
        entity: 'match',
        entityId: g.anchorTxId,
        action: 'revoke_group',
        detail: { groupId, matchType: g.matchType },
      })
      .run()
    recomputeAnchorStatus(g.anchorTxId)
    return { ok: true as const }
  })

export const markPending = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    z.object({ anchorTxId: z.string(), value: z.boolean().default(true) }).parse(d),
  )
  .handler(async ({ data }) => {
    db.update(transactions)
      .set({ pending: data.value, updatedAt: new Date() })
      .where(eq(transactions.id, data.anchorTxId))
      .run()
    return { ok: true as const }
  })

const noMatchInput = z.object({
  anchorTxId: z.string(),
  leg: z.enum(['accounting', 'reimbursement']),
  value: z.boolean().default(true),
})

export const markNoMatch = createServerFn({ method: 'POST' })
  .validator((d: unknown) => noMatchInput.parse(d))
  .handler(async ({ data }) => {
    db.update(transactions)
      .set(
        data.leg === 'accounting'
          ? { noAccountingMatch: data.value, updatedAt: new Date() }
          : { noBankMatch: data.value, updatedAt: new Date() },
      )
      .where(eq(transactions.id, data.anchorTxId))
      .run()
    recomputeAnchorStatus(data.anchorTxId)
    return { ok: true as const }
  })
