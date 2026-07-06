import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '#/db/client.ts'
import { accounts, auditLog, importBatches, transactions } from '#/db/schema.ts'
import type { Ledger, NewTransaction } from '#/db/types.ts'
import {
  convertMinor,
  ensureChfRates,
  loadRateMap,
  type RateMap,
  storeRate,
} from '#/lib/fx/rates.ts'
import { hashRows } from '#/lib/ingest/dedup.ts'
import { analyzeFile, periodOf } from '#/lib/ingest/pipeline.ts'
import type { CanonicalRow, FieldMap, MappingOptions } from '#/lib/ingest/types.ts'
import { fromMinor } from '#/lib/money.ts'
import { getConfig } from '#/lib/matching/engine.ts'
import { normalizeMerchant } from '#/lib/matching/similarity.ts'

export interface CommitParams {
  buffer: Buffer
  fileName: string
  accountId: string
  presetKey?: string
  fieldMap?: FieldMap
  options?: MappingOptions
}

export type CommitResult =
  | {
      ok: true
      batchId: string
      inserted: number
      duplicates: number
      skipped: number
      rowCount: number
    }
  | { ok: false; error: string; batchId?: string }

function chfEquivOf(row: CanonicalRow, rateMap: RateMap): number | null {
  const sign = row.direction === 'debit' ? -1 : 1
  if (row.currency === 'CHF') return row.amount
  const conv = convertMinor(
    rateMap,
    Math.abs(row.amount),
    row.currency,
    'CHF',
    row.txDate,
  )
  if (conv != null) return conv * sign
  if (row.originalCurrency === 'CHF' && row.originalAmount != null)
    return row.originalAmount
  return null
}

export async function commitFile(params: CommitParams): Promise<CommitResult> {
  const { buffer, fileName, accountId } = params
  const fileHash = createHash('sha256').update(buffer).digest('hex')

  const dup = db
    .select()
    .from(importBatches)
    .where(
      and(
        eq(importBatches.fileHash, fileHash),
        eq(importBatches.status, 'committed'),
      ),
    )
    .get()
  if (dup) {
    return {
      ok: false,
      error: 'This exact file was already imported.',
      batchId: dup.id,
    }
  }

  const result = analyzeFile(buffer, fileName, {
    presetKey: params.presetKey,
    fieldMap: params.fieldMap,
    options: params.options,
  })
  const allRows = result.rows
  if (!allRows || allRows.length === 0) {
    return { ok: false, error: 'No rows parsed from file.' }
  }

  // never commit rows that failed to parse: an 'unparseable amount' row would
  // be stored as 0.00 on date '' and silently counted as a success
  const rows = allRows.filter((r) => r.errors.length === 0)
  const skipped = allRows.length - rows.length
  if (rows.length === 0) {
    return { ok: false, error: `All ${allRows.length} rows have parse errors.` }
  }

  const account = db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get()
  if (!account) return { ok: false, error: 'Unknown account.' }
  const ledger: Ledger =
    result.ledger ??
    (account.kind === 'bank'
      ? 'bank'
      : account.kind === 'accounting'
        ? 'accounting'
        : 'card')

  // FX: ensure CHF rates for non-CHF rows, derive card rates from FX rows.
  await ensureChfRates(
    rows
      .filter((r) => r.currency !== 'CHF')
      .map((r) => ({ date: r.txDate, currency: r.currency })),
  )
  await ensureChfRates(
    rows
      .filter((r) => r.originalCurrency && r.originalCurrency !== 'CHF')
      .map((r) => ({ date: r.txDate, currency: r.originalCurrency as string })),
  )
  for (const r of rows) {
    if (
      r.originalCurrency &&
      r.originalAmount &&
      r.amount &&
      r.originalCurrency !== r.currency
    ) {
      // ratio of MAJOR units — a minor-unit ratio is off by 10^Δdecimals for
      // 0/3-decimal currencies (JPY 100x, BHD 10x)
      const rate =
        fromMinor(Math.abs(r.amount), r.currency) /
        fromMinor(Math.abs(r.originalAmount), r.originalCurrency)
      if (Number.isFinite(rate) && rate > 0)
        storeRate(r.txDate, r.originalCurrency, r.currency, rate, 'card')
    }
  }
  const rateMap = loadRateMap()
  const cfg = getConfig()
  const noise = new Set(cfg.noiseTokens)
  const city = new Set(cfg.cityCountry)

  const hashes = hashRows(rows, account.id, ledger)
  const period = periodOf(rows)

  const summary = db.transaction((tx) => {
    const batch = tx
      .insert(importBatches)
      .values({
        accountId: account.id,
        sourceType: result.sourceType,
        ledger,
        fileName,
        fileHash,
        fileSize: buffer.length,
        status: 'committed',
        rowCount: rows.length,
        detectedEncoding: result.encoding,
        detectedDelimiter: result.delimiter,
        periodStart: period.start,
        periodEnd: period.end,
      })
      .returning()
      .get()

    let inserted = 0
    rows.forEach((r, i) => {
      const merchantNorm = normalizeMerchant(
        r.merchant ?? r.counterparty ?? r.description,
        noise,
        city,
      )
      const values: NewTransaction = {
        importBatchId: batch.id,
        accountId: account.id,
        ledger,
        txDate: r.txDate,
        bookingDate: r.bookingDate ?? null,
        valueDate: r.valueDate ?? null,
        direction: r.direction,
        amount: r.amount,
        currency: r.currency,
        originalAmount: r.originalAmount ?? null,
        originalCurrency: r.originalCurrency ?? null,
        fxRate: r.fxRate ?? null,
        chfEquiv: chfEquivOf(r, rateMap),
        merchant: r.merchant ?? null,
        merchantNorm: merchantNorm || null,
        description: r.description ?? null,
        reference: r.reference ?? null,
        counterparty: r.counterparty ?? null,
        category: r.category ?? null,
        statusText: r.statusText ?? null,
        classification: 'unclassified',
        reconStatus: 'open',
        rowHash: hashes[i],
        rawPayload: r.raw,
      }
      const res = tx
        .insert(transactions)
        .values(values)
        .onConflictDoNothing({ target: transactions.rowHash })
        .run()
      inserted += res.changes
    })

    const duplicates = rows.length - inserted
    tx.update(importBatches)
      .set({ insertedCount: inserted, duplicateCount: duplicates })
      .where(eq(importBatches.id, batch.id))
      .run()
    tx.insert(auditLog)
      .values({
        entity: 'import_batch',
        entityId: batch.id,
        action: 'commit_import',
        detail: { fileName, inserted, duplicates, skipped },
      })
      .run()
    return { batchId: batch.id, inserted, duplicates, rowCount: allRows.length }
  })

  return { ok: true, skipped, ...summary }
}
