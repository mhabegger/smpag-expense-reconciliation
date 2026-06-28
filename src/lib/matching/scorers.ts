import { daysBetween, daysBetweenSigned } from '#/lib/date.ts'
import type { MatchingConfig } from '#/lib/matching/config.ts'

/** Score similarity of two magnitudes (minor units, positive) in [0,1]. */
export function scoreAmountPair(
  aMinor: number,
  bMinor: number,
  crossCurrency: boolean,
  cfg: MatchingConfig,
): number {
  const a = Math.abs(aMinor)
  const b = Math.abs(bMinor)
  const diff = Math.abs(a - b)
  const absTol = cfg.amount.absTolMinor
  const pct = crossCurrency
    ? cfg.amount.pctTolCross + cfg.amount.fxMarkupTol
    : cfg.amount.pctTolSame
  const tol = Math.max(absTol, b * pct)
  if (diff <= absTol) return 1
  if (diff >= 2 * tol) return 0
  if (diff >= tol) return 0.25 * (1 - (diff - tol) / tol)
  return 1 - 0.4 * (diff / tol)
}

/**
 * Best amount score across multiple candidate amounts for the expense (e.g.
 * billed-converted AND original-currency exact). Each candidate carries whether
 * it was a cross-currency conversion.
 */
export function amountScore(
  candidates: Array<{ minor: number; crossCurrency: boolean }>,
  targetMinor: number,
  cfg: MatchingConfig,
): number {
  let best = 0
  for (const c of candidates) {
    best = Math.max(best, scoreAmountPair(c.minor, targetMinor, c.crossCurrency, cfg))
    if (best >= 1) break
  }
  return best
}

/** Exponential-decay date score for accounting (symmetric). */
export function dateScoreAcc(
  expenseDate: string,
  targetDate: string,
  cfg: MatchingConfig,
): number {
  const d = daysBetween(expenseDate, targetDate)
  return 0.5 ** (d / cfg.date.halfLifeAcc)
}

/** Asymmetric date score for bank reimbursements (must come after the charge). */
export function dateScoreBank(
  expenseDate: string,
  bankDate: string,
  cfg: MatchingConfig,
): number {
  const signed = daysBetweenSigned(expenseDate, bankDate) // + => bank after charge
  if (signed < -cfg.windows.bankBefore) return 0.05
  return 0.5 ** (Math.abs(signed) / cfg.date.halfLifeBank)
}

export interface AccountingScoreParts {
  amount: number
  merchant: number | null
  date: number
}

export function compositeAccounting(
  parts: AccountingScoreParts,
  cfg: MatchingConfig,
): number {
  const w = cfg.weightsAB
  if (parts.merchant == null) {
    // re-normalize amount+date weights when no merchant text exists
    const total = w.amount + w.date
    const s = (w.amount * parts.amount + w.date * parts.date) / total
    return Math.round(100 * s)
  }
  const s =
    w.amount * parts.amount + w.merchant * parts.merchant + w.date * parts.date
  return Math.round(100 * s)
}

export interface BankScoreParts {
  amount: number
  text: number | null
  date: number
}

export function compositeBank(parts: BankScoreParts, cfg: MatchingConfig): number {
  if (parts.text == null) {
    const w = cfg.weightsAC
    const s = w.amount * parts.amount + w.date * parts.date
    return Math.round(100 * s)
  }
  const w = cfg.weightsACText
  const s = w.amount * parts.amount + w.text * parts.text + w.date * parts.date
  return Math.round(100 * s)
}
