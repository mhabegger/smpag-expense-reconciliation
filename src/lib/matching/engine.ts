import { and, eq, gte, inArray, isNull, lte, ne } from 'drizzle-orm'
import { db } from '#/db/client.ts'
import {
  accounts,
  appSettings,
  companies,
  matchCandidates,
  matchGroupMembers,
  matchGroups,
  transactions,
} from '#/db/schema.ts'
import type { Classification, ReconStatus, Transaction } from '#/db/types.ts'
import { addDays } from '#/lib/date.ts'
import {
  type RateMap,
  convertMinor,
  ensureChfRates,
  loadRateMap,
} from '#/lib/fx/rates.ts'
import { DEFAULT_MATCHING_CONFIG, type MatchingConfig } from '#/lib/matching/config.ts'
import {
  type SubsetItem,
  dateSpreadDays,
  findSubsetSums,
} from '#/lib/matching/groups.ts'
import {
  amountScore,
  compositeAccounting,
  compositeBank,
  dateScoreAcc,
  dateScoreBank,
  scoreAmountPair,
} from '#/lib/matching/scorers.ts'
import { merchantSimilarity, normalizeMerchant } from '#/lib/matching/similarity.ts'

export function getConfig(): MatchingConfig {
  const row = db.select().from(appSettings).get()
  if (row?.config) {
    const stored = row.config as Partial<MatchingConfig>
    // merge section-by-section: a config persisted before a new field was
    // added must not wipe the defaults of its whole section
    return {
      ...DEFAULT_MATCHING_CONFIG,
      ...stored,
      windows: { ...DEFAULT_MATCHING_CONFIG.windows, ...stored.windows },
      amount: { ...DEFAULT_MATCHING_CONFIG.amount, ...stored.amount },
      date: { ...DEFAULT_MATCHING_CONFIG.date, ...stored.date },
      weightsAB: { ...DEFAULT_MATCHING_CONFIG.weightsAB, ...stored.weightsAB },
      weightsAC: { ...DEFAULT_MATCHING_CONFIG.weightsAC, ...stored.weightsAC },
      weightsACText: {
        ...DEFAULT_MATCHING_CONFIG.weightsACText,
        ...stored.weightsACText,
      },
      merchantBlend: {
        ...DEFAULT_MATCHING_CONFIG.merchantBlend,
        ...stored.merchantBlend,
      },
      thresholds: { ...DEFAULT_MATCHING_CONFIG.thresholds, ...stored.thresholds },
      group: { ...DEFAULT_MATCHING_CONFIG.group, ...stored.group },
    }
  }
  return DEFAULT_MATCHING_CONFIG
}

function newRunId(): string {
  return crypto.randomUUID()
}

/** Identity of a candidate pair for dismissed-suggestion filtering. */
function candidateKey(
  candidateTxId: string | null,
  matchType: string,
  groupMemberIds: string[] | null | undefined,
): string {
  const members = groupMemberIds?.length
    ? [...groupMemberIds].sort().join(',')
    : ''
  return `${matchType}|${candidateTxId}|${members}`
}

function usedTransactionIds(): Set<string> {
  // members of groups that have NOT been revoked are considered "used"
  const rows = db
    .select({ txId: matchGroupMembers.txId })
    .from(matchGroupMembers)
    .innerJoin(matchGroups, eq(matchGroupMembers.groupId, matchGroups.id))
    .where(isNull(matchGroups.revokedAt))
    .all()
  return new Set(rows.map((r) => r.txId))
}

function anchorAmountCandidates(
  anchor: Transaction,
  targetCurrency: string,
  targetDate: string,
  rateMap: RateMap,
): Array<{ minor: number; crossCurrency: boolean }> {
  const out: Array<{ minor: number; crossCurrency: boolean }> = []
  const billed = Math.abs(anchor.amount)
  if (anchor.currency === targetCurrency) {
    out.push({ minor: billed, crossCurrency: false })
  } else {
    const conv = convertMinor(rateMap, billed, anchor.currency, targetCurrency, targetDate)
    if (conv != null) out.push({ minor: conv, crossCurrency: true })
  }
  if (anchor.originalAmount != null && anchor.originalCurrency) {
    const orig = Math.abs(anchor.originalAmount)
    if (anchor.originalCurrency === targetCurrency) {
      out.push({ minor: orig, crossCurrency: false })
    } else {
      const conv = convertMinor(
        rateMap,
        orig,
        anchor.originalCurrency,
        targetCurrency,
        targetDate,
      )
      if (conv != null) out.push({ minor: conv, crossCurrency: true })
    }
  }
  // no fallback when conversion is unavailable: comparing raw foreign minor
  // units at same-currency tolerance produced confidently wrong matches
  // (100.00 USD scored 1.0 against 100.00 CHF)
  return out
}

/** Recompute an anchor's accounting/bank linkage facets and recon status. */
export function recomputeAnchorStatus(anchorId: string): void {
  const groups = db
    .select()
    .from(matchGroups)
    .where(
      and(eq(matchGroups.anchorTxId, anchorId), isNull(matchGroups.revokedAt)),
    )
    .all()
  const accountingLinked = groups.some((g) => g.matchType === 'accounting')
  const bankLinked = groups.some((g) => g.matchType === 'reimbursement')
  const anchor = db
    .select()
    .from(transactions)
    .where(eq(transactions.id, anchorId))
    .get()
  const accDone = accountingLinked || (anchor?.noAccountingMatch ?? false)
  const bankDone = bankLinked || (anchor?.noBankMatch ?? false)
  let reconStatus: ReconStatus = 'open'
  if (anchor?.classification === 'private') reconStatus = 'ignored'
  else if (accDone && bankDone) reconStatus = 'matched'
  else if (accountingLinked || bankLinked) reconStatus = 'partially_matched'
  // a fully-resolved expense is no longer pending
  const pending = reconStatus === 'matched' ? false : (anchor?.pending ?? false)
  db.update(transactions)
    .set({ accountingLinked, bankLinked, reconStatus, pending, updatedAt: new Date() })
    .where(eq(transactions.id, anchorId))
    .run()
}

export interface RunResult {
  runId: string
  anchors: number
  candidatesCreated: number
}

export async function runMatching(
  opts: { anchorTxId?: string } = {},
): Promise<RunResult> {
  const cfg = getConfig()
  const runId = newRunId()

  // Ensure FX rates for any non-CHF transactions (best effort / online).
  const nonChf = db
    .select({ date: transactions.txDate, currency: transactions.currency })
    .from(transactions)
    .where(ne(transactions.currency, 'CHF'))
    .all()
  const origCcy = db
    .select({
      date: transactions.txDate,
      currency: transactions.originalCurrency,
    })
    .from(transactions)
    .where(ne(transactions.originalCurrency, 'CHF'))
    .all()
    .filter((r) => r.currency)
  await ensureChfRates([
    ...nonChf,
    ...origCcy.map((r) => ({ date: r.date, currency: r.currency as string })),
  ])
  const rateMap = loadRateMap()

  const noise = new Set(cfg.noiseTokens)
  const city = new Set(cfg.cityCountry)
  const used = usedTransactionIds()

  // classification -> accounting account ids
  const comps = db.select().from(companies).all()
  const accs = db.select().from(accounts).all()
  const acctAccountsByClass = new Map<Classification, string[]>()
  for (const c of comps) {
    const ids = accs
      .filter((a) => a.kind === 'accounting' && a.companyId === c.id)
      .map((a) => a.id)
    acctAccountsByClass.set(c.classification, ids)
  }

  // anchors: card debits classified to a company
  const anchorWhere = [
    eq(transactions.ledger, 'card'),
    eq(transactions.direction, 'debit'),
    inArray(transactions.classification, ['deliver_media', 'swiss_media_partners']),
  ]
  if (opts.anchorTxId) anchorWhere.push(eq(transactions.id, opts.anchorTxId))
  const anchors = db
    .select()
    .from(transactions)
    .where(and(...anchorWhere))
    .all()

  let created = 0

  // one transaction for the whole run: ~100x faster inserts in better-sqlite3
  // and no anchors left with cleared-but-unreplaced suggestions on a crash
  db.transaction(() => {
  for (const anchor of anchors) {
    // clear prior *suggested* candidates for this anchor (keep dismissed)
    db.delete(matchCandidates)
      .where(
        and(
          eq(matchCandidates.anchorTxId, anchor.id),
          eq(matchCandidates.status, 'suggested'),
        ),
      )
      .run()

    // pairs the user already dismissed must not be re-suggested by a re-run
    const dismissedRows = db
      .select({
        candidateTxId: matchCandidates.candidateTxId,
        matchType: matchCandidates.matchType,
        groupMemberIds: matchCandidates.groupMemberIds,
      })
      .from(matchCandidates)
      .where(
        and(
          eq(matchCandidates.anchorTxId, anchor.id),
          eq(matchCandidates.status, 'dismissed'),
        ),
      )
      .all()
    const dismissed = new Set(
      dismissedRows.map((d) => candidateKey(d.candidateTxId, d.matchType, d.groupMemberIds)),
    )

    const merchNorm =
      anchor.merchantNorm ??
      normalizeMerchant(anchor.merchant ?? anchor.description, noise, city)

    // ---- Accounting leg ----
    if (!anchor.accountingLinked) {
      const acctIds = acctAccountsByClass.get(anchor.classification) ?? []
      if (acctIds.length > 0) {
        const lo = addDays(anchor.txDate, -cfg.windows.accBefore)
        const hi = addDays(anchor.txDate, cfg.windows.accAfter)
        const candRows = db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.ledger, 'accounting'),
              inArray(transactions.accountId, acctIds),
              gte(transactions.txDate, lo),
              lte(transactions.txDate, hi),
            ),
          )
          .all()
        const scored = candRows
          .filter((c) => !used.has(c.id))
          .map((c) => {
            const amtCands = anchorAmountCandidates(
              anchor,
              c.currency,
              c.txDate,
              rateMap,
            )
            const amt = amountScore(amtCands, Math.abs(c.amount), cfg)
            const cNorm =
              c.merchantNorm ??
              normalizeMerchant(c.merchant ?? c.description, noise, city)
            const merch = merchantSimilarity(merchNorm, cNorm, cfg.merchantBlend)
            const dt = dateScoreAcc(anchor.txDate, c.txDate, cfg)
            const score = compositeAccounting(
              { amount: amt, merchant: merch, date: dt },
              cfg,
            )
            return { c, amt, merch, dt, score }
          })
          .filter((x) => !dismissed.has(candidateKey(x.c.id, 'accounting', null)))
          .filter((x) => x.score >= cfg.thresholds.hide)
          .sort((a, b) => b.score - a.score)
          .slice(0, cfg.topN)

        for (const s of scored) {
          db.insert(matchCandidates)
            .values({
              anchorTxId: anchor.id,
              candidateTxId: s.c.id,
              groupMemberIds: null,
              matchType: 'accounting',
              score: s.score,
              scoreBreakdown: {
                amount: Math.round(s.amt * 100),
                date: Math.round(s.dt * 100),
                merchant: s.merch == null ? null : Math.round(s.merch * 100),
                currency: 100,
              },
              convertedAmount: Math.abs(s.c.amount),
              reason: `amount ${Math.round(s.amt * 100)} · merchant ${
                s.merch == null ? '–' : Math.round(s.merch * 100)
              } · date ${Math.round(s.dt * 100)}`,
              runId,
            })
            .run()
          created++
        }
      }
    }

    // ---- Bank leg (single) ----
    if (!anchor.bankLinked) {
      const lo = addDays(anchor.txDate, -cfg.windows.bankBefore)
      const hi = addDays(anchor.txDate, cfg.windows.bankAfter)
      const bankRows = db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.ledger, 'bank'),
            eq(transactions.direction, 'credit'),
            gte(transactions.txDate, lo),
            lte(transactions.txDate, hi),
          ),
        )
        .all()
      const scored = bankRows
        .filter((b) => !used.has(b.id))
        .map((b) => {
          const amtCands = anchorAmountCandidates(
            anchor,
            b.currency,
            b.txDate,
            rateMap,
          )
          const amt = amountScore(amtCands, Math.abs(b.amount), cfg)
          const bNorm =
            b.merchantNorm ??
            normalizeMerchant(b.counterparty ?? b.description, noise, city)
          const text = merchantSimilarity(merchNorm, bNorm, cfg.merchantBlend)
          const dt = dateScoreBank(anchor.txDate, b.valueDate ?? b.txDate, cfg)
          const score = compositeBank({ amount: amt, text, date: dt }, cfg)
          return { b, amt, text, dt, score }
        })
        .filter((x) => !dismissed.has(candidateKey(x.b.id, 'reimbursement', null)))
        .filter((x) => x.score >= cfg.thresholds.hide)
        .sort((a, b) => b.score - a.score)
        .slice(0, cfg.topN)

      for (const s of scored) {
        db.insert(matchCandidates)
          .values({
            anchorTxId: anchor.id,
            candidateTxId: s.b.id,
            groupMemberIds: null,
            matchType: 'reimbursement',
            score: s.score,
            scoreBreakdown: {
              amount: Math.round(s.amt * 100),
              date: Math.round(s.dt * 100),
              merchant: s.text == null ? null : Math.round(s.text * 100),
              currency: 100,
            },
            convertedAmount: Math.abs(s.b.amount),
            reason: `amount ${Math.round(s.amt * 100)} · date ${Math.round(
              s.dt * 100,
            )}`,
            runId,
          })
          .run()
        created++
      }

      // ---- Bank leg (grouped: N expenses -> 1 credit) ----
      created += generateGroupCandidates(anchor, rateMap, cfg, used, runId, dismissed)
    }
  }
  })

  return { runId, anchors: anchors.length, candidatesCreated: created }
}

function generateGroupCandidates(
  anchor: Transaction,
  rateMap: RateMap,
  cfg: MatchingConfig,
  used: Set<string>,
  runId: string,
  dismissed: Set<string>,
): number {
  let created = 0
  // bank credits that could cover a group containing this anchor: the credit
  // may arrive up to groupBankBefore days AFTER the expense (it reimburses up
  // to that many days of prior expenses) and at most groupBankAfter days
  // before it. The previous bounds ([-bankBefore, +groupBankAfter] = [-2, +5])
  // meant an expense reimbursed three weeks later never got a group candidate.
  const lo = addDays(anchor.txDate, -cfg.windows.groupBankAfter)
  const hi = addDays(anchor.txDate, cfg.windows.groupBankBefore)
  const bankRows = db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.ledger, 'bank'),
        eq(transactions.direction, 'credit'),
        gte(transactions.txDate, lo),
        lte(transactions.txDate, hi),
      ),
    )
    .all()
    .filter((b) => !used.has(b.id))

  for (const B of bankRows) {
    const targetMinor = Math.abs(B.amount)
    const anchorInB = anchorAmountCandidates(anchor, B.currency, B.txDate, rateMap)
    if (anchorInB.length === 0) continue // anchor not priceable in B's currency
    const anchorMinor = anchorInB[0].minor
    if (anchorMinor > targetMinor) continue // anchor alone already exceeds credit

    // pool: open company expenses near B
    const pLo = addDays(B.txDate, -cfg.windows.groupBankBefore)
    const pHi = addDays(B.txDate, cfg.windows.groupBankAfter)
    const pool = db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.ledger, 'card'),
          eq(transactions.direction, 'debit'),
          eq(transactions.classification, anchor.classification),
          eq(transactions.bankLinked, false),
          gte(transactions.txDate, pLo),
          lte(transactions.txDate, pHi),
        ),
      )
      .all()
      .filter((e) => !used.has(e.id))

    const crossById = new Map<string, boolean>()
    const items: SubsetItem[] = []
    for (const e of pool) {
      const cands = anchorAmountCandidates(e, B.currency, B.txDate, rateMap)
      if (cands.length === 0) continue // not priceable in B's currency
      if (cands[0].minor > targetMinor) continue
      crossById.set(e.id, cands[0].crossCurrency)
      items.push({ id: e.id, minor: cands[0].minor, date: e.txDate })
    }
    // cap pool to maxPool nearest to B, keep anchor
    let capped = items
    if (items.length > cfg.group.maxPool) {
      const anchorItem = items.find((i) => i.id === anchor.id)
      const rest = items
        .filter((i) => i.id !== anchor.id)
        .sort(
          (a, b) =>
            Math.abs(new Date(a.date).getTime() - new Date(B.txDate).getTime()) -
            Math.abs(new Date(b.date).getTime() - new Date(B.txDate).getTime()),
        )
        .slice(0, cfg.group.maxPool - 1)
      capped = anchorItem ? [anchorItem, ...rest] : rest
    }

    const tol = Math.max(cfg.amount.absTolMinor, targetMinor * cfg.amount.pctTolCross)
    const subsets = findSubsetSums(capped, targetMinor, tol, {
      minSize: 2,
      maxSize: 8,
      maxResults: cfg.group.maxResults,
    }).filter((g) => g.ids.includes(anchor.id))

    const ranked = subsets
      .map((g) => {
        // subsets were found with cross-currency tolerance when any member was
        // converted — score with the same tolerance or 1–2% deviations get
        // found by the DFS and then silently zeroed here
        const cross = g.ids.some((mid) => crossById.get(mid))
        const amountFit = scoreAmountPair(g.sum, targetMinor, cross, cfg)
        const cohesion = 0.5 ** (dateSpreadDays(g.members) / 5)
        const parsimony = 1 / g.members.length ** 0.2
        const score = Math.round(100 * amountFit * cohesion * parsimony)
        return { g, score }
      })
      .filter((x) => !dismissed.has(candidateKey(B.id, 'reimbursement', x.g.ids)))
      .filter((x) => x.score >= cfg.thresholds.hide)
      .sort((a, b) => b.score - a.score)
      .slice(0, cfg.group.maxResults)

    for (const r of ranked) {
      db.insert(matchCandidates)
        .values({
          anchorTxId: anchor.id,
          candidateTxId: B.id,
          groupMemberIds: r.g.ids,
          matchType: 'reimbursement',
          score: r.score,
          scoreBreakdown: {
            amount: r.score,
            date: 0,
            merchant: null,
            currency: 100,
          },
          convertedAmount: r.g.sum,
          reason: `group of ${r.g.ids.length} expenses → 1 credit`,
          runId,
        })
        .run()
      created++
    }
  }
  return created
}
