import { createHash } from 'node:crypto'
import { createServerFn } from '@tanstack/react-start'
import { desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db/client.ts'
import {
  accounts,
  importBatches,
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

const previewInput = z.object({
  fileName: z.string(),
  base64: z.string(),
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

    const existing = db
      .select()
      .from(importBatches)
      .where(eq(importBatches.fileHash, fileHash))
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
  base64: z.string(),
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
  .validator((id: string) => id)
  .handler(async ({ data: batchId }) => {
    const usedRows = new Set(
      db
        .select({ txId: matchGroupMembers.txId })
        .from(matchGroupMembers)
        .innerJoin(matchGroups, eq(matchGroupMembers.groupId, matchGroups.id))
        .where(isNull(matchGroups.revokedAt))
        .all()
        .map((r) => r.txId),
    )
    const rows = db
      .select()
      .from(transactions)
      .where(eq(transactions.importBatchId, batchId))
      .all()
    let removed = 0
    let blocked = 0
    for (const r of rows) {
      if (usedRows.has(r.id)) {
        blocked++
        continue
      }
      db.delete(transactions).where(eq(transactions.id, r.id)).run()
      removed++
    }
    db.update(importBatches)
      .set({ status: 'reverted' })
      .where(eq(importBatches.id, batchId))
      .run()
    return { removed, blockedByMatches: blocked }
  })
