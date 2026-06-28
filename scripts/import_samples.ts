import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client.ts'
import {
  accounts,
  matchCandidates,
  matchGroupMembers,
  matchGroups,
  transactions,
} from '../src/db/schema.ts'
import { analyzeFile } from '../src/lib/ingest/pipeline.ts'
import { commitFile } from '../src/lib/ingest/commit.ts'
import { runMatching } from '../src/lib/matching/engine.ts'
import { formatMoney } from '../src/lib/money.ts'

async function main() {
  const dir = resolve('samples')
  const accs = db.select().from(accounts).all()
  const byInstitute = new Map(accs.map((a) => [a.institute, a]))

  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const buf = readFileSync(resolve(dir, name))
    const meta = analyzeFile(buf, name)
    const institute = meta.institute
    const account = institute ? byInstitute.get(institute) : undefined
    if (!account) {
      console.log(`SKIP ${name} (no account for institute=${institute})`)
      continue
    }
    const res = await commitFile({
      buffer: buf,
      fileName: name,
      accountId: account.id,
      presetKey: meta.presetKey ?? undefined,
    })
    if (res.ok) {
      console.log(
        `OK   ${name} → ${account.label}: +${res.inserted} (${res.duplicates} dup)`,
      )
    } else {
      console.log(`FAIL ${name}: ${res.error}`)
    }
  }

  const counts = db
    .select({ ledger: transactions.ledger, c: sql<number>`count(*)` })
    .from(transactions)
    .groupBy(transactions.ledger)
    .all()
  console.log('\nLedger counts:', counts)

  if (process.env.VERIFY === '1') {
    console.log('\n--- VERIFY: classify all card debits → swiss_media_partners ---')
    db.update(transactions)
      .set({ classification: 'swiss_media_partners' })
      .where(
        and(eq(transactions.ledger, 'card'), eq(transactions.direction, 'debit')),
      )
      .run()
    const r = await runMatching({})
    console.log('runMatching:', r)

    const anchors = db
      .select()
      .from(transactions)
      .where(
        and(eq(transactions.ledger, 'card'), eq(transactions.direction, 'debit')),
      )
      .all()
    let withAcct = 0
    let withBank = 0
    const examples: string[] = []
    for (const a of anchors) {
      const cands = db
        .select()
        .from(matchCandidates)
        .where(eq(matchCandidates.anchorTxId, a.id))
        .all()
      const acct = cands.filter((c) => c.matchType === 'accounting')
      const bank = cands.filter((c) => c.matchType === 'reimbursement')
      if (acct.length) withAcct++
      if (bank.length) withBank++
      if (acct.length && examples.length < 8) {
        const top = acct.sort((x, y) => y.score - x.score)[0]
        const tgt = db
          .select()
          .from(transactions)
          .where(eq(transactions.id, top.candidateTxId!))
          .get()
        examples.push(
          `  [${top.score}] ${a.merchant ?? a.description} ${formatMoney(
            a.amount,
            a.currency,
          )} ↔ ${tgt?.merchant ?? tgt?.description} ${formatMoney(
            tgt?.amount ?? 0,
            tgt?.currency ?? 'CHF',
          )}`,
        )
      }
    }
    console.log(
      `anchors=${anchors.length} withAccountingCandidate=${withAcct} withBankCandidate=${withBank}`,
    )
    console.log('Example accounting matches:')
    console.log(examples.join('\n'))

    // revert to a clean slate
    console.log('\n--- VERIFY: reverting classifications + clearing matches ---')
    db.delete(matchGroupMembers).run()
    db.delete(matchGroups).run()
    db.delete(matchCandidates).run()
    db.update(transactions)
      .set({
        classification: 'unclassified',
        accountingLinked: false,
        bankLinked: false,
        reconStatus: 'open',
      })
      .where(eq(transactions.ledger, 'card'))
      .run()
    console.log('reverted.')
  }
}

main()
