/**
 * Replace a company's accounting data with a fresh Accounto export.
 *
 *   tsx scripts/replace_accounting.ts <export.xlsx> [--dry-run]
 *
 * Accounto exports are full snapshots (status changes, deleted and re-filed
 * documents), so instead of merging we import the new file and retire every
 * earlier batch of the same accounting account. Confirmed matches survive:
 * they are re-pointed to the new row with the same Accounto document ID.
 * Matches whose document disappeared are revoked and the card expense gets a
 * note so it shows up for review.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../src/db/client.ts'
import {
  accounts,
  auditLog,
  importBatches,
  matchCandidates,
  matchGroupMembers,
  matchGroups,
  transactions,
} from '../src/db/schema.ts'
import { analyzeFile } from '../src/lib/ingest/pipeline.ts'
import { commitFile } from '../src/lib/ingest/commit.ts'
import { recomputeAnchorStatus } from '../src/lib/matching/engine.ts'

const docId = (raw: Record<string, unknown>) =>
  raw.ID == null ? null : String(raw.ID)

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const path = args.find((a) => !a.startsWith('--'))
  if (!path) throw new Error('usage: replace_accounting.ts <file> [--dry-run]')

  const buf = readFileSync(resolve(path))
  const name = basename(path)
  const meta = analyzeFile(buf, name)
  if (meta.ledger !== 'accounting' || !meta.institute)
    throw new Error(`${name} is not an accounting export (${meta.presetKey})`)
  const account = db
    .select()
    .from(accounts)
    .where(eq(accounts.institute, meta.institute))
    .get()
  if (!account) throw new Error(`no account for institute ${meta.institute}`)

  const oldBatchIds = db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.accountId, account.id),
        eq(importBatches.status, 'committed'),
      ),
    )
    .all()
    .map((b) => b.id)
  const oldRows = oldBatchIds.length
    ? db
        .select()
        .from(transactions)
        .where(inArray(transactions.importBatchId, oldBatchIds))
        .all()
    : []
  console.log(
    `${account.label}: ${oldRows.length} rows in ${oldBatchIds.length} old batch(es)`,
  )
  if (dryRun) {
    console.log('dry run — nothing changed')
    return
  }

  const res = await commitFile({
    buffer: buf,
    fileName: name,
    accountId: account.id,
    presetKey: meta.presetKey ?? undefined,
  })
  if (!res.ok) throw new Error(`import failed: ${res.error}`)
  console.log(`imported ${name}: +${res.inserted} (${res.duplicates} dup)`)

  const newBatch = res.batchId
  const newByDoc = new Map(
    db
      .select()
      .from(transactions)
      .where(eq(transactions.importBatchId, newBatch))
      .all()
      .map((t) => [docId(t.rawPayload), t]),
  )

  db.transaction((tx) => {
    const oldIds = oldRows.map((r) => r.id)
    const oldById = new Map(oldRows.map((r) => [r.id, r]))
    const touchedAnchors = new Set<string>()

    // re-point (or revoke) every active match that uses an old row
    const members = oldIds.length
      ? tx
          .select({
            memberId: matchGroupMembers.id,
            txId: matchGroupMembers.txId,
            groupId: matchGroups.id,
            anchorTxId: matchGroups.anchorTxId,
          })
          .from(matchGroupMembers)
          .innerJoin(matchGroups, eq(matchGroupMembers.groupId, matchGroups.id))
          .where(
            and(
              inArray(matchGroupMembers.txId, oldIds),
              isNull(matchGroups.revokedAt),
            ),
          )
          .all()
      : []
    for (const m of members) {
      const old = oldById.get(m.txId)!
      const id = docId(old.rawPayload)
      const replacement = id ? newByDoc.get(id) : undefined
      touchedAnchors.add(m.anchorTxId)
      if (replacement) {
        tx.update(matchGroupMembers)
          .set({ txId: replacement.id })
          .where(eq(matchGroupMembers.id, m.memberId))
          .run()
        console.log(`  kept match → doc ${id} (${old.merchant})`)
      } else {
        tx.update(matchGroups)
          .set({ revokedAt: new Date() })
          .where(eq(matchGroups.id, m.groupId))
          .run()
        const anchor = tx
          .select({ note: transactions.note })
          .from(transactions)
          .where(eq(transactions.id, m.anchorTxId))
          .get()
        const flag = `Accounto doc ${id} ("${old.merchant}", ${old.txDate}) disappeared from the ${account.label} export on ${new Date().toISOString().slice(0, 10)} — check what happened to it.`
        tx.update(transactions)
          .set({ note: anchor?.note ? `${anchor.note}\n${flag}` : flag })
          .where(eq(transactions.id, m.anchorTxId))
          .run()
        console.log(`  REVOKED match: doc ${id} (${old.merchant}) is gone`)
      }
    }

    // remove the old rows (revoked groups/candidates referencing them first)
    if (oldIds.length) {
      tx.delete(matchCandidates)
        .where(
          or(
            inArray(matchCandidates.anchorTxId, oldIds),
            inArray(matchCandidates.candidateTxId, oldIds),
          ),
        )
        .run()
      tx.delete(matchGroupMembers)
        .where(inArray(matchGroupMembers.txId, oldIds))
        .run()
      tx.delete(transactions).where(inArray(transactions.id, oldIds)).run()
      tx.update(importBatches)
        .set({ status: 'reverted' })
        .where(inArray(importBatches.id, oldBatchIds))
        .run()
    }
    tx.insert(auditLog)
      .values({
        entity: 'import_batch',
        entityId: newBatch,
        action: 'replace_accounting',
        detail: {
          replacedBatches: oldBatchIds,
          removed: oldIds.length,
          inserted: res.inserted,
          relinked: members.length,
        },
      })
      .run()
    for (const a of touchedAnchors) recomputeAnchorStatus(a)
  })
  console.log(`removed ${oldRows.length} old rows; done`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
