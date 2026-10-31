import { createServerFn } from '@tanstack/react-start'
import { and, eq, inArray, like, lt, ne } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db/client.ts'
import { accounts, merchantNotes, transactions } from '#/db/schema.ts'
import { isMealMerchant } from '#/lib/matching/expenseChain.ts'

/** Expenses under this amount can't be submitted (covered by the lump sum). */
const SMALL_LIMIT_MINOR = 5000

const triageInput = z.object({
  // 'all' or a 4-digit year
  year: z.union([z.literal('all'), z.string().regex(/^\d{4}$/)]),
})

/**
 * Unclassified card expenses (debits) grouped by merchant, so a whole merchant can be
 * classified at once. Each group carries how the same merchant was classified
 * before (any year) as a hint.
 */
export const getTriage = createServerFn({ method: 'POST' })
  .validator((d: unknown) => triageInput.parse(d))
  .handler(async ({ data }) => {
    const accLabel = new Map(
      db
        .select({ id: accounts.id, label: accounts.label })
        .from(accounts)
        .all()
        .map((a) => [a.id, a.label]),
    )
    const rows = db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.ledger, 'card'),
          eq(transactions.classification, 'unclassified'),
          // expenses only: card bill payments, top-ups and refunds are credits
          lt(transactions.amount, 0),
          data.year === 'all' ? undefined : like(transactions.txDate, `${data.year}-%`),
        ),
      )
      .all()

    const keyOf = (t: { merchantNorm: string | null; merchant: string | null }) =>
      t.merchantNorm || t.merchant || '—'
    const keys = [...new Set(rows.map(keyOf))]

    // the same merchant's expenses that are already classified (any year):
    // shown for context only, the triage buttons never touch them
    const done = new Map<
      string,
      {
        id: string
        txDate: string
        amount: number
        currency: string
        classification: string
        account: string
      }[]
    >()
    if (keys.length) {
      const classified = db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.ledger, 'card'),
            ne(transactions.classification, 'unclassified'),
            lt(transactions.amount, 0),
            inArray(transactions.merchantNorm, keys),
          ),
        )
        .all()
      for (const c of classified) {
        const list = done.get(c.merchantNorm!) ?? []
        list.push({
          id: c.id,
          txDate: c.txDate,
          amount: c.amount,
          currency: c.currency,
          classification: c.classification,
          account: accLabel.get(c.accountId) ?? '?',
        })
        done.set(c.merchantNorm!, list)
      }
    }
    const notes = new Map(
      keys.length
        ? db
            .select()
            .from(merchantNotes)
            .where(inArray(merchantNotes.merchantNorm, keys))
            .all()
            .map((n) => [n.merchantNorm, n.note])
        : [],
    )

    type Row = (typeof rows)[number]
    const byKey = new Map<string, Row[]>()
    for (const r of rows) {
      const k = keyOf(r)
      byKey.set(k, [...(byKey.get(k) ?? []), r])
    }

    const groups = [...byKey.entries()].map(([key, txs]) => {
      txs.sort((a, b) => b.txDate.localeCompare(a.txDate))
      const names = new Map<string, number>()
      for (const t of txs) {
        const n = t.merchant ?? key
        names.set(n, (names.get(n) ?? 0) + 1)
      }
      const merchant = [...names.entries()].sort((a, b) => b[1] - a[1])[0][0]
      const abs = txs.map((t) => Math.abs(t.amount))
      const mcc = txs
        .map((t) => (t.rawPayload as Record<string, unknown> | null)?.['Registered Category'])
        .find((v): v is string => typeof v === 'string')
      return {
        key,
        merchant,
        count: txs.length,
        total: abs.reduce((s, a) => s + a, 0),
        largest: Math.max(...abs),
        small: abs.filter((a) => a < SMALL_LIMIT_MINOR).length,
        firstDate: txs[txs.length - 1].txDate,
        lastDate: txs[0].txDate,
        accounts: [...new Set(txs.map((t) => accLabel.get(t.accountId) ?? '?'))],
        meal: isMealMerchant(key, mcc ?? null),
        classified: (done.get(key) ?? []).sort((a, b) => b.txDate.localeCompare(a.txDate)),
        note: notes.get(key) ?? null,
        rows: txs.map((t) => ({
          id: t.id,
          txDate: t.txDate,
          amount: t.amount,
          currency: t.currency,
          originalAmount: t.originalAmount,
          originalCurrency: t.originalCurrency,
          merchant: t.merchant,
          description: t.description,
          account: accLabel.get(t.accountId) ?? '?',
          note: t.note,
        })),
      }
    })

    const sum = (xs: number[]) => xs.reduce((s, a) => s + a, 0)
    const all = rows.map((r) => Math.abs(r.amount))
    const byAccount = new Map<string, { count: number; total: number }>()
    for (const r of rows) {
      const l = accLabel.get(r.accountId) ?? '?'
      const a = byAccount.get(l) ?? { count: 0, total: 0 }
      a.count++
      a.total += Math.abs(r.amount)
      byAccount.set(l, a)
    }
    return {
      groups,
      summary: {
        count: rows.length,
        total: sum(all),
        smallCount: all.filter((a) => a < SMALL_LIMIT_MINOR).length,
        smallTotal: sum(all.filter((a) => a < SMALL_LIMIT_MINOR)),
        byAccount: [...byAccount.entries()]
          .map(([label, v]) => ({ label, ...v }))
          .sort((a, b) => b.total - a.total),
      },
      smallLimit: SMALL_LIMIT_MINOR,
    }
  })
