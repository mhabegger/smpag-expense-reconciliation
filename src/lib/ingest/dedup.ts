import { createHash } from 'node:crypto'
import type { Ledger } from '#/db/types.ts'
import type { CanonicalRow } from '#/lib/ingest/types.ts'

function normText(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/**
 * Stable per-row content hash for dedup. When a reference is present the hash is
 * idempotent across overlapping files; when absent, an occurrence index (the Nth
 * identical row within a single import) preserves legitimate same-day duplicates
 * while still catching whole-file re-imports.
 */
export function computeRowHash(
  row: CanonicalRow,
  accountId: string,
  ledger: Ledger,
  occurrence: number,
): string {
  const text = normText(row.merchant ?? row.counterparty ?? row.description)
  const parts = [
    accountId,
    ledger,
    row.txDate,
    row.direction,
    String(row.amount),
    row.currency,
    row.originalAmount == null ? '' : String(row.originalAmount),
    row.originalCurrency ?? '',
    text,
    row.reference ?? '',
    row.reference ? '' : `#${occurrence}`,
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

/** Assign occurrence indices and compute hashes for a batch of rows. */
export function hashRows(
  rows: CanonicalRow[],
  accountId: string,
  ledger: Ledger,
): string[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const baseKey = [
      row.txDate,
      row.direction,
      row.amount,
      row.currency,
      normText(row.merchant ?? row.counterparty ?? row.description),
    ].join('|')
    const n = (seen.get(baseKey) ?? 0) + 1
    seen.set(baseKey, n)
    return computeRowHash(row, accountId, ledger, n)
  })
}
