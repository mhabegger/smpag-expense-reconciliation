/**
 * Recompute transactions.merchant_norm after a change to normalizeMerchant.
 *
 *   tsx scripts/renormalize_merchants.ts [--dry-run]
 *
 * Uses the same source field and config as the import (commit.ts).
 */
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.ts'
import { transactions } from '../src/db/schema.ts'
import { getConfig } from '../src/lib/matching/engine.ts'
import { normalizeMerchant } from '../src/lib/matching/similarity.ts'

const dryRun = process.argv.includes('--dry-run')
const cfg = getConfig()
const noise = new Set(cfg.noiseTokens)
const city = new Set(cfg.cityCountry)

const rows = db.select().from(transactions).all()
const changes: { id: string; from: string | null; to: string }[] = []
for (const t of rows) {
  const to = normalizeMerchant(t.merchant ?? t.counterparty ?? t.description, noise, city)
  if ((t.merchantNorm ?? '') !== to) changes.push({ id: t.id, from: t.merchantNorm, to })
}
const pairs = new Map<string, number>()
for (const c of changes) {
  const k = `${c.from} → ${c.to}`
  pairs.set(k, (pairs.get(k) ?? 0) + 1)
}
for (const [k, n] of [...pairs].sort()) console.log(`${String(n).padStart(4)}  ${k}`)
console.log(`${changes.length} of ${rows.length} rows change`)
if (!dryRun) {
  db.transaction((tx) => {
    for (const c of changes)
      tx.update(transactions).set({ merchantNorm: c.to }).where(eq(transactions.id, c.id)).run()
  })
  console.log('updated')
}
