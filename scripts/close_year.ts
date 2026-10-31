/**
 * Year-closing pass: link accounting documents to their payment and payout,
 * classify the paying card expense, drop sub-50 CHF meals to private, and
 * write an exceptions report for everything that needs a human.
 *
 *   tsx scripts/close_year.ts [--year=2025] [--dry-run]
 *   tsx scripts/close_year.ts --undo        # removes everything this script wrote
 *
 * Only high-confidence links are written (marker: confirmed_by = 'auto-close').
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { and, eq, inArray } from 'drizzle-orm'
import { db, sqlite } from '../src/db/client.ts'
import {
  auditLog,
  matchGroupMembers,
  matchGroups,
  transactions,
} from '../src/db/schema.ts'
import { recomputeAnchorStatus } from '../src/lib/matching/engine.ts'
import {
  isMealMerchant,
  salaryLikeCredits,
  type ChainPayment,
  type ChainResult,
  type CompanyKey,
} from '../src/lib/matching/expenseChain.ts'
import {
  buildYearPlan,
  COMPANY_CLASS as CLASS,
  EXPENSE_SOURCES,
  SECONDARY_SOURCES,
} from '../src/lib/matching/yearPlan.ts'

const MARKER = 'auto-close'
const MEAL_LIMIT_MINOR = 5000
const LABEL: Record<CompanyKey, string> = { smp: 'SMP', dm: 'DM' }

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const year = Number(args.find((a) => a.startsWith('--year='))?.slice(7) ?? 2025)

const fmt = (minor: number, cur = 'CHF') =>
  `${(minor / 100).toLocaleString('de-CH', { minimumFractionDigits: 2 })} ${cur}`

function undo() {
  const groups = db
    .select()
    .from(matchGroups)
    .where(eq(matchGroups.confirmedBy, MARKER))
    .all()
  const ruled = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.classificationSource, 'rule'))
    .all()
  db.transaction((tx) => {
    const ids = groups.map((g) => g.id)
    if (ids.length) {
      tx.delete(matchGroupMembers).where(inArray(matchGroupMembers.groupId, ids)).run()
      tx.delete(matchGroups).where(inArray(matchGroups.id, ids)).run()
    }
    tx.update(transactions)
      .set({ classification: 'unclassified', classificationSource: null, classifiedAt: null })
      .where(eq(transactions.classificationSource, 'rule'))
      .run()
    tx.insert(auditLog)
      .values({
        entity: 'close_year',
        entityId: String(year),
        action: 'undo',
        detail: { groups: ids.length, reclassified: ruled.length },
      })
      .run()
  })
  for (const id of new Set([...groups.map((g) => g.anchorTxId), ...ruled.map((r) => r.id)]))
    recomputeAnchorStatus(id)
  console.log(`undone: ${groups.length} links, ${ruled.length} classifications`)
}

async function main() {
  if (args.includes('--undo')) return undo()

  const { plan, linkedPlan, paidOutDocs, docsAll, credits, taken, all } = buildYearPlan(year)

  // ---- decide what to write ------------------------------------------------
  type Conflict = { r: ChainResult; current: string }
  const conflicts: Conflict[] = []
  const writes: { r: ChainResult; anchorId: string; withPayment: boolean }[] = []
  for (const r of plan) {
    const p = r.payment?.confidence === 'auto' ? r.payment.payment : null
    if (p && p.classification !== 'unclassified' && p.classification !== CLASS[r.doc.company]) {
      conflicts.push({ r, current: p.classification })
      continue
    }
    if (p) writes.push({ r, anchorId: p.id, withPayment: true })
    else if (r.payout?.confidence === 'auto') writes.push({ r, anchorId: r.doc.id, withPayment: false })
  }
  const linkedPayouts = linkedPlan.filter((r) => r.payout?.confidence === 'auto')
  const planned = new Set(plan.flatMap((r) => (r.payment ? [r.payment.payment.id] : [])))
  const meals = all.filter(
    (t) =>
      t.ledger === 'card' &&
      t.direction === 'debit' &&
      t.txDate.startsWith(String(year)) &&
      t.classification === 'unclassified' &&
      !t.accountingLinked &&
      !planned.has(t.id) &&
      Math.abs(t.chfEquiv ?? t.amount) < MEAL_LIMIT_MINOR &&
      isMealMerchant(
        t.merchantNorm,
        (t.rawPayload['Registered Category'] as string | null) ?? null,
      ),
  )

  // ---- persist ---------------------------------------------------------------
  if (!dryRun) {
    mkdirSync('data/backups', { recursive: true })
    await sqlite.backup(`data/backups/app-before-close-${year}-${Date.now()}.db`)
    const now = new Date()
    db.transaction((tx) => {
      const group = (
        anchorTxId: string,
        matchType: 'accounting' | 'reimbursement',
        memberId: string,
        amount: number,
        currency: string,
        confidence: number,
      ) => {
        const g = tx
          .insert(matchGroups)
          .values({ anchorTxId, matchType, matchedAmount: amount, currency, confidence, confirmedBy: MARKER })
          .returning()
          .get()
        tx.insert(matchGroupMembers)
          .values({ groupId: g.id, txId: memberId, contributedAmount: amount })
          .run()
      }
      for (const { r, anchorId, withPayment } of writes) {
        if (withPayment) {
          tx.update(transactions)
            .set({ classification: CLASS[r.doc.company], classificationSource: 'rule', classifiedAt: now })
            .where(and(eq(transactions.id, anchorId), eq(transactions.classification, 'unclassified')))
            .run()
          group(anchorId, 'accounting', r.doc.id, r.doc.amount, r.doc.currency,
            r.payment!.method === 'exact' ? 95 : 80)
          // a payout linked to the document itself moves to the payment
          if (paidOutDocs.has(r.doc.id))
            tx.update(matchGroups)
              .set({ anchorTxId: anchorId })
              .where(
                and(eq(matchGroups.anchorTxId, r.doc.id), eq(matchGroups.matchType, 'reimbursement')),
              )
              .run()
        }
        if (r.payout?.confidence === 'auto') {
          const c = r.payout.credits[0]
          const contributed = withPayment ? r.payment!.payment.chf : c.chf
          group(anchorId, 'reimbursement', c.id, contributed, 'CHF', 95)
        }
      }
      for (const r of linkedPayouts) {
        const p = all.find((t) => t.id === r.paymentId)!
        group(r.paymentId, 'reimbursement', r.payout!.credits[0].id, Math.abs(p.amount), 'CHF', 95)
      }
      for (const t of meals)
        tx.update(transactions)
          .set({ classification: 'private', classificationSource: 'rule', classifiedAt: now })
          .where(eq(transactions.id, t.id))
          .run()
      tx.insert(auditLog)
        .values({
          entity: 'close_year',
          entityId: String(year),
          action: 'apply',
          detail: { links: writes.length, payouts: linkedPayouts.length, meals: meals.length },
        })
        .run()
    })
    for (const id of new Set([
      ...writes.map((w) => w.anchorId),
      ...writes.filter((w) => paidOutDocs.has(w.r.doc.id)).map((w) => w.r.doc.id),
      ...linkedPayouts.map((r) => r.paymentId),
      ...meals.map((m) => m.id),
    ]))
      recomputeAnchorStatus(id)
  }

  // ---- report ----------------------------------------------------------------
  const line = (r: ChainResult) =>
    `${LABEL[r.doc.company]} · ${r.doc.date} · **${fmt(r.doc.amount, r.doc.currency)}** · ${r.doc.vendor && !r.doc.title.includes(r.doc.vendor) ? `${r.doc.vendor} — ` : ''}${r.doc.title || '(no title)'}`
  const payLine = (p: ChainPayment) =>
    `${p.source} ${p.date} ${fmt(p.chf)}${p.origCurrency ? ` (${fmt(p.origAmount!, p.origCurrency)})` : ''} “${p.merchant ?? ''}”`
  const out: string[] = []
  const sec = (title: string, rows: string[], note?: string) => {
    out.push(`\n## ${title} (${rows.length})\n`)
    if (note) out.push(`${note}\n`)
    out.push(rows.length ? rows.map((r) => `- ${r}`).join('\n') : '_none_')
  }
  const expected = (r: ChainResult) => r.expectation === 'normal' || r.expectation === 'home-charging'
  const byCo = (co: CompanyKey) => {
    const rs = plan.filter((r) => r.doc.company === co)
    const allCo = docsAll.filter((d) => d.company === co)
    return `| ${LABEL[co]} | ${allCo.length} | ${allCo.length - rs.length} | ${rs.filter((r) => r.payout?.confidence === 'auto').length} | ${rs.filter((r) => r.payment?.confidence === 'auto').length} | ${rs.filter((r) => !expected(r)).length} |`
  }
  out.push(`# ${year} closing — exceptions\n`)
  out.push(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}${dryRun ? ' (dry run — nothing written)' : ''}.\n`)
  out.push('| Company | Documents | Already linked | Payout found | Payment found | Rejected / company card |')
  out.push('|---|---|---|---|---|---|')
  out.push(byCo('smp'), byCo('dm'))
  out.push(`\nWritten: ${writes.length} documents linked; ${linkedPayouts.length} payouts for already-linked documents; ${meals.length} meals < 50 CHF set to private.`)

  // documents already linked to their payment are checked for a payout too
  const unpaid = [...plan, ...linkedPlan].filter(
    (r) => expected(r) && !r.payout && !paidOutDocs.has(r.doc.id),
  )
  sec('Paid per Accounto, but no payout found in the bank',
    unpaid.filter((r) => r.doc.paymentStatus === 'Abgestimmt').map(line))
  sec('Not yet paid per Accounto',
    unpaid.filter((r) => r.doc.paymentStatus !== 'Abgestimmt')
      .map((r) => `${line(r)} · status ${r.doc.paymentStatus}`))
  sec('Combined payouts (one credit for several documents) — please confirm',
    [...new Set(plan.filter((r) => r.payout?.method === 'combined').map((r) => r.payout!.credits[0]))]
      .map((c) => `${c.date} ${fmt(c.credited, c.currency)} = ${plan.filter((r) => r.payout?.credits[0] === c).map((r) => `${r.doc.title} ${fmt(r.doc.amount, r.doc.currency)}`).join(' + ')}`))
  sec('Probable payment — please confirm',
    plan.filter((r) => r.payment?.confidence === 'review')
      .map((r) => `${line(r)} → ${payLine(r.payment!.payment)} · ${r.payment!.method === 'tip' ? 'card amount higher (tip?)' : r.payment!.method === 'exact' ? `same amount, ${r.payment!.payment.source === 'Viseca' ? 'on Viseca' : 'merchant name differs'}` : 'FX estimate'}`))
  sec('Card expense already classified differently — not changed',
    conflicts.map(({ r, current }) => `${line(r)} → ${payLine(r.payment!.payment)} is **${current}**`))
  sec('No card or bank payment found',
    plan.filter((r) => r.expectation === 'normal' && !r.payment).map((r) => `${line(r)}${r.payout ? ' · paid out' : ''}`),
    `Searched ${EXPENSE_SOURCES.join(', ')}, Raiffeisen debits and (for suggestions only) ${SECONDARY_SOURCES.join(', ')}. Home charging and company-card documents are excluded.`)
  sec('Rejected in Accounto', plan.filter((r) => r.expectation === 'rejected').map(line))
  sec('Paid with a company card (no reimbursement expected)', plan.filter((r) => r.expectation === 'company-card').map(line))
  const salaryLike = salaryLikeCredits(credits)
  const usedCredits = new Set([
    ...taken.credits,
    ...plan.flatMap((r) => r.payout?.credits.map((c) => c.id) ?? []),
  ])
  sec(`Company credits in ${year} not explained by any document`,
    credits
      .filter((c) => c.company && c.date.startsWith(String(year)) && !salaryLike.has(c.id) && !usedCredits.has(c.id))
      .map((c) => `${c.date} ${LABEL[c.company!]} ${fmt(c.chf)}${c.currency !== 'CHF' ? ` (${fmt(c.ordered, c.currency)} ordered)` : ''}`))
  const mealGroups = new Map<string, { n: number; sum: number }>()
  for (const m of meals) {
    const g = mealGroups.get(m.merchantNorm ?? '?') ?? { n: 0, sum: 0 }
    g.n++
    g.sum += Math.abs(m.chfEquiv ?? m.amount)
    mealGroups.set(m.merchantNorm ?? '?', g)
  }
  sec('Meals under 50 CHF set to private (by merchant)',
    [...mealGroups].sort((a, b) => b[1].n - a[1].n).map(([m, g]) => `${m} — ${g.n}× · ${fmt(g.sum)}`))

  mkdirSync('reports', { recursive: true })
  const file = `reports/${year}-closing-exceptions.md`
  writeFileSync(file, out.join('\n') + '\n')
  console.log(out.join('\n'))
  console.log(`\nreport: ${file}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
