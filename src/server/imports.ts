import { createHash } from 'node:crypto'
import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db/client.ts'
import {
  accounts,
  auditLog,
  importBatches,
  matchCandidates,
  matchGroupMembers,
  matchGroups,
  transactions,
} from '#/db/schema.ts'
import { commitFile } from '#/lib/ingest/commit.ts'
import { analyzeFile, periodOf } from '#/lib/ingest/pipeline.ts'
import { formatMoney } from '#/lib/money.ts'

function bufFromBase64(b64: string): Buffer {
  return Buffer.from(b64, 'base64')
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

// ~30 MB file → ~40 MB base64; statements are a few hundred KB
const MAX_BASE64 = 40_000_000

const previewInput = z.object({
  fileName: z.string(),
  base64: z.string().max(MAX_BASE64),
  presetKey: z.string().optional(),
  fieldMap: z.record(z.string(), z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
})

export const previewImport = createServerFn({ method: 'POST' })
  .validator((d: unknown) => previewInput.parse(d))
  .handler(async ({ data }) => {
    const buf = bufFromBase64(data.base64)
    const fileHash = sha256(buf)
    const result = analyzeFile(buf, data.fileName, {
      presetKey: data.presetKey,
      fieldMap: data.fieldMap as never,
      options: data.options as never,
    })

    // a reverted batch does not block re-import
    const existing = db
      .select()
      .from(importBatches)
      .where(
        and(
          eq(importBatches.fileHash, fileHash),
          eq(importBatches.status, 'committed'),
        ),
      )
      .get()

    const rows = result.rows
    const sampleRows = (rows ?? []).slice(0, 25).map((r) => ({
      txDate: r.txDate,
      direction: r.direction,
      amount: r.amount,
      currency: r.currency,
      amountDisplay: formatMoney(r.amount, r.currency),
      originalAmount: r.originalAmount,
      originalCurrency: r.originalCurrency,
      originalDisplay: r.originalCurrency
        ? formatMoney(r.originalAmount, r.originalCurrency)
        : null,
      merchant: r.merchant,
      description: r.description,
      reference: r.reference,
      errors: r.errors,
    }))

    const period = rows ? periodOf(rows) : { start: null, end: null }
    return {
      meta: {
        kind: result.kind,
        sourceType: result.sourceType,
        encoding: result.encoding,
        delimiter: result.delimiter,
        sheetNames: result.sheetNames,
        selectedSheet: result.selectedSheet,
        headers: result.headers,
        presetKey: result.presetKey,
        presetLabel: result.presetLabel,
        institute: result.institute,
        ledger: result.ledger,
        warnings: result.warnings,
      },
      needsMapping: rows == null,
      sampleRecords: result.sampleRecords.map((rec) =>
        Object.fromEntries(
          Object.entries(rec).map(([k, v]) => [k, v == null ? '' : String(v)]),
        ),
      ),
      sampleRows,
      stats: {
        rowCount: rows?.length ?? 0,
        errorCount: rows?.filter((r) => r.errors.length > 0).length ?? 0,
        fxRows: rows?.filter((r) => r.originalCurrency).length ?? 0,
        period,
      },
      fileHash,
      alreadyImported: !!existing,
    }
  })

const commitInput = z.object({
  fileName: z.string(),
  base64: z.string().max(MAX_BASE64),
  accountId: z.string(),
  presetKey: z.string().optional(),
  fieldMap: z.record(z.string(), z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
})

export const commitImport = createServerFn({ method: 'POST' })
  .validator((d: unknown) => commitInput.parse(d))
  .handler(async ({ data }) => {
    return commitFile({
      buffer: bufFromBase64(data.base64),
      fileName: data.fileName,
      accountId: data.accountId,
      presetKey: data.presetKey,
      fieldMap: data.fieldMap as never,
      options: data.options as never,
    })
  })

export const listBatches = createServerFn({ method: 'GET' }).handler(async () => {
  const batches = db
    .select()
    .from(importBatches)
    .orderBy(desc(importBatches.createdAt))
    .all()
  const accs = db.select().from(accounts).all()
  const byId = new Map(accs.map((a) => [a.id, a]))
  return batches.map((b) => ({
    ...b,
    accountLabel: byId.get(b.accountId)?.label ?? b.accountId,
  }))
})

export const revertImport = createServerFn({ method: 'POST' })
  .validator((d: unknown) => z.string().min(1).parse(d))
  .handler(async ({ data: batchId }) => {
    return db.transaction((tx) => {
      // a transaction is in use if it participates in any non-revoked group —
      // as a MEMBER (accounting/bank rows) or as the ANCHOR (card expenses)
      const activeMembers = new Set(
        tx
          .select({ txId: matchGroupMembers.txId })
          .from(matchGroupMembers)
          .innerJoin(matchGroups, eq(matchGroupMembers.groupId, matchGroups.id))
          .where(isNull(matchGroups.revokedAt))
          .all()
          .map((r) => r.txId),
      )
      const activeAnchors = new Set(
        tx
          .select({ anchorTxId: matchGroups.anchorTxId })
          .from(matchGroups)
          .where(isNull(matchGroups.revokedAt))
          .all()
          .map((r) => r.anchorTxId),
      )

      const rows = tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.importBatchId, batchId))
        .all()
      const ids = rows
        .map((r) => r.id)
        .filter((id) => !activeMembers.has(id) && !activeAnchors.has(id))
      const blocked = rows.length - ids.length

      if (ids.length > 0) {
        // clear dependents first or the FK constraints reject the delete:
        // candidates referencing these txs (either side), then revoked groups
        // they anchor or belong to
        tx.delete(matchCandidates)
          .where(
            or(
              inArray(matchCandidates.anchorTxId, ids),
              inArray(matchCandidates.candidateTxId, ids),
            ),
          )
          .run()
        const revokedGroupIds = tx
          .select({ id: matchGroups.id })
          .from(matchGroups)
          .where(inArray(matchGroups.anchorTxId, ids))
          .all()
          .map((g) => g.id)
        if (revokedGroupIds.length > 0) {
          tx.delete(matchGroupMembers)
            .where(inArray(matchGroupMembers.groupId, revokedGroupIds))
            .run()
          tx.delete(matchGroups)
            .where(inArray(matchGroups.id, revokedGroupIds))
            .run()
        }
        tx.delete(matchGroupMembers)
          .where(inArray(matchGroupMembers.txId, ids))
          .run()
        tx.delete(transactions).where(inArray(transactions.id, ids)).run()
      }

      // only mark reverted when nothing remains — a batch with surviving
      // matched rows is still (partially) live
      if (blocked === 0) {
        tx.update(importBatches)
          .set({ status: 'reverted' })
          .where(eq(importBatches.id, batchId))
          .run()
      }
      tx.insert(auditLog)
        .values({
          entity: 'import_batch',
          entityId: batchId,
          action: 'revert_import',
          detail: { removed: ids.length, blockedByMatches: blocked },
        })
        .run()
      return { removed: ids.length, blockedByMatches: blocked }
    })
  })
