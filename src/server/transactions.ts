import { createServerFn } from '@tanstack/react-start'
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  like,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db/client.ts'
import {
  accounts,
  auditLog,
  merchantNotes,
  transactions,
} from '#/db/schema.ts'
import {
  CLASSIFICATIONS,
  LEDGERS,
  RECON_STATUSES,
} from '#/db/schema.ts'
import { recomputeAnchorStatus } from '#/lib/matching/engine.ts'
import { merchantNoteFor } from '#/server/notes-db.ts'
import { txDto, txDtoList } from '#/server/_dto.ts'

const txFilter = z.object({
  ledger: z.enum(LEDGERS).optional(),
  classification: z.enum(CLASSIFICATIONS).optional(),
  reconStatus: z.enum(RECON_STATUSES).optional(),
  accountId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  search: z.string().optional(),
  sortBy: z
    .enum(['txDate', 'bookingDate', 'amount', 'merchant'])
    .default('txDate'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  page: z.number().int().min(0).default(0),
  pageSize: z.number().int().min(1).max(500).default(50),
})

export const listTransactions = createServerFn({ method: 'POST' })
  .validator((d: unknown) => txFilter.parse(d))
  .handler(async ({ data: f }) => {
    const conds = buildConds(f)
    const where = conds.length ? and(...conds) : undefined

    const total =
      db.select({ c: count() }).from(transactions).where(where).get()?.c ?? 0

    const dir = f.sortDir === 'asc' ? asc : desc
    const sortCol =
      f.sortBy === 'amount'
        ? sql`abs(${transactions.amount})`
        : f.sortBy === 'bookingDate'
          ? transactions.bookingDate
          : f.sortBy === 'merchant'
            ? transactions.merchant
            : transactions.txDate
    const rows = db
      .select()
      .from(transactions)
      .where(where)
      .orderBy(dir(sortCol), desc(transactions.createdAt))
      .limit(f.pageSize)
      .offset(f.page * f.pageSize)
      .all()

    // attach merchant notes (keyed by normalized merchant)
    const norms = [
      ...new Set(rows.map((r) => r.merchantNorm).filter(Boolean)),
    ] as string[]
    const noteByNorm = new Map(
      (norms.length
        ? db
            .select()
            .from(merchantNotes)
            .where(inArray(merchantNotes.merchantNorm, norms))
            .all()
        : []
      ).map((n) => [n.merchantNorm, n.note]),
    )
    const out = txDtoList(rows).map((r) => ({
      ...r,
      merchantNote: r.merchantNorm ? (noteByNorm.get(r.merchantNorm) ?? null) : null,
    }))
    return { rows: out, total }
  })

export const getTransaction = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const tx = db
      .select()
      .from(transactions)
      .where(eq(transactions.id, id))
      .get()
    if (!tx) return null
    const account = db
      .select()
      .from(accounts)
      .where(eq(accounts.id, tx.accountId))
      .get()
    return {
      tx: txDto(tx),
      rawJson: JSON.stringify(tx.rawPayload ?? {}, null, 2),
      account: account ?? null,
      merchantNote: merchantNoteFor(tx.merchantNorm),
    }
  })

/** Set classification to ANY value incl. 'unclassified' (used for undo). */
function applyClassification(id: string, classification: string) {
  const isUnclassified = classification === 'unclassified'
  db.update(transactions)
    .set({
      classification: classification as never,
      classifiedAt: isUnclassified ? null : new Date(),
      classificationSource: isUnclassified ? null : 'user',
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, id))
    .run()
  recomputeAnchorStatus(id)
}

const setClassInput = z.object({
  id: z.string(),
  classification: z.enum(CLASSIFICATIONS),
})

export const setClassification = createServerFn({ method: 'POST' })
  .validator((d: unknown) => setClassInput.parse(d))
  .handler(async ({ data }) => {
    applyClassification(data.id, data.classification)
    return { ok: true as const }
  })

const restoreInput = z.object({
  items: z.array(
    z.object({ id: z.string(), classification: z.enum(CLASSIFICATIONS) }),
  ),
})

export const restoreClassifications = createServerFn({ method: 'POST' })
  .validator((d: unknown) => restoreInput.parse(d))
  .handler(async ({ data }) => {
    for (const it of data.items) applyClassification(it.id, it.classification)
    return { restored: data.items.length }
  })

const classifyInput = z.object({
  id: z.string(),
  classification: z.enum(['deliver_media', 'swiss_media_partners', 'private']),
})

export const classifyTransaction = createServerFn({ method: 'POST' })
  .validator((d: unknown) => classifyInput.parse(d))
  .handler(async ({ data }) => {
    db.update(transactions)
      .set({
        classification: data.classification,
        classifiedAt: new Date(),
        classificationSource: 'user',
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, data.id))
      .run()
    recomputeAnchorStatus(data.id)
    db.insert(auditLog)
      .values({
        entity: 'transaction',
        entityId: data.id,
        action: 'classify',
        detail: { classification: data.classification },
      })
      .run()
    const updated = db
      .select()
      .from(transactions)
      .where(eq(transactions.id, data.id))
      .get()
    return updated ? txDto(updated) : null
  })

/** Build the WHERE conditions shared by list + bulk-by-filter (card-only enforced for bulk). */
function buildConds(
  f: z.infer<typeof txFilter>,
  opts: { cardOnly?: boolean } = {},
): SQL[] {
  const conds: SQL[] = []
  if (opts.cardOnly) conds.push(eq(transactions.ledger, 'card'))
  else if (f.ledger) conds.push(eq(transactions.ledger, f.ledger))
  if (f.classification)
    conds.push(eq(transactions.classification, f.classification))
  if (f.reconStatus) conds.push(eq(transactions.reconStatus, f.reconStatus))
  if (f.accountId) conds.push(eq(transactions.accountId, f.accountId))
  if (f.dateFrom) conds.push(gte(transactions.txDate, f.dateFrom))
  if (f.dateTo) conds.push(lte(transactions.txDate, f.dateTo))
  if (f.search) {
    const q = `%${f.search}%`
    const s = or(
      like(transactions.merchant, q),
      like(transactions.description, q),
      like(transactions.counterparty, q),
      like(transactions.reference, q),
    )
    if (s) conds.push(s)
  }
  return conds
}

const bulkByFilterInput = z.object({
  filter: txFilter,
  classification: z.enum(['deliver_media', 'swiss_media_partners', 'private']),
})

/** Classify EVERY card expense matching the current filter (across all pages). */
export const bulkClassifyByFilter = createServerFn({ method: 'POST' })
  .validator((d: unknown) => bulkByFilterInput.parse(d))
  .handler(async ({ data }) => {
    const conds = buildConds(data.filter, { cardOnly: true })
    const where = conds.length ? and(...conds) : undefined
    const prev = db
      .select({
        id: transactions.id,
        classification: transactions.classification,
      })
      .from(transactions)
      .where(where)
      .all()
    const ids = prev.map((r) => r.id)
    if (ids.length === 0) return { updated: 0, prev: [] as typeof prev }
    db.update(transactions)
      .set({
        classification: data.classification,
        classifiedAt: new Date(),
        classificationSource: 'user',
        updatedAt: new Date(),
      })
      .where(where)
      .run()
    for (const id of ids) recomputeAnchorStatus(id)
    db.insert(auditLog)
      .values({
        entity: 'transaction',
        entityId: 'bulk',
        action: 'bulk_classify_by_filter',
        detail: { classification: data.classification, count: ids.length },
      })
      .run()
    return { updated: ids.length, prev }
  })

const bulkClassifyInput = z.object({
  ids: z.array(z.string()).min(1),
  classification: z.enum(['deliver_media', 'swiss_media_partners', 'private']),
})

export const bulkClassify = createServerFn({ method: 'POST' })
  .validator((d: unknown) => bulkClassifyInput.parse(d))
  .handler(async ({ data }) => {
    db.update(transactions)
      .set({
        classification: data.classification,
        classifiedAt: new Date(),
        classificationSource: 'user',
        updatedAt: new Date(),
      })
      .where(inArray(transactions.id, data.ids))
      .run()
    for (const id of data.ids) recomputeAnchorStatus(id)
    return { updated: data.ids.length }
  })
