import { XMLParser } from 'fast-xml-parser'
import { toMinor } from '#/lib/money.ts'
import { collapseSpaces } from '#/lib/ingest/transforms.ts'
import type { CanonicalRow, ParseResult } from '#/lib/ingest/types.ts'

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

function text(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'object' && '#text' in (v as Record<string, unknown>)) {
    return collapseSpaces(String((v as Record<string, unknown>)['#text']))
  }
  const s = collapseSpaces(String(v))
  return s === '' ? null : s
}

/** Parse an ISO 20022 camt.053 (or camt.052) bank statement XML. */
export function parseCamt053(xml: string): ParseResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) =>
      ['Stmt', 'Rpt', 'Ntry', 'NtryDtls', 'TxDtls', 'Ustrd'].includes(name),
  })
  const doc = parser.parse(xml)
  const root =
    doc?.Document?.BkToCstmrStmt ?? doc?.Document?.BkToCstmrAcctRpt ?? null
  const rows: CanonicalRow[] = []
  const warnings: string[] = []
  if (!root) {
    return { rows, headers: [], warnings: ['No camt statement found in XML'] }
  }

  const statements = asArray(root.Stmt ?? root.Rpt)
  for (const stmt of statements) {
    const stmtCcy: string | null = text(stmt?.Acct?.Ccy) ?? null
    for (const ntry of asArray(stmt?.Ntry)) {
      const amtNode = ntry?.Amt
      const ccy =
        (amtNode && (amtNode['@_Ccy'] as string)) ?? stmtCcy ?? 'CHF'
      const magnitude = Number(text(amtNode) ?? '0')
      const cdtDbt = text(ntry?.CdtDbtInd) ?? 'DBIT'
      const direction = cdtDbt.startsWith('CRDT') ? 'credit' : 'debit'
      const bookingDate =
        text(ntry?.BookgDt?.Dt) ?? text(ntry?.BookgDt?.DtTm)?.slice(0, 10) ?? null
      const valueDate =
        text(ntry?.ValDt?.Dt) ?? text(ntry?.ValDt?.DtTm)?.slice(0, 10) ?? null
      const status = text(ntry?.Sts?.Cd) ?? text(ntry?.Sts)

      const txDetailsList = asArray(ntry?.NtryDtls).flatMap((d) =>
        asArray(d?.TxDtls),
      )

      if (txDetailsList.length === 0) {
        rows.push(
          buildRow({
            magnitude,
            ccy,
            direction,
            txDate: valueDate ?? bookingDate ?? '',
            bookingDate,
            valueDate,
            description:
              text(ntry?.AddtlNtryInf) ?? text(ntry?.NtryRef) ?? null,
            reference: text(ntry?.AcctSvcrRef) ?? text(ntry?.NtryRef),
            counterparty: null,
            origAmount: null,
            origCcy: null,
            fxRate: null,
            status,
            raw: ntry,
          }),
        )
        continue
      }

      for (const tx of txDetailsList) {
        const ustrd = asArray(tx?.RmtInf?.Ustrd)
          .map((u) => text(u))
          .filter(Boolean)
          .join(' ')
        const counterparty =
          direction === 'credit'
            ? text(tx?.RltdPties?.Dbtr?.Nm) ?? text(tx?.RltdPties?.Dbtr?.Pty?.Nm)
            : text(tx?.RltdPties?.Cdtr?.Nm) ?? text(tx?.RltdPties?.Cdtr?.Pty?.Nm)
        const ccyXchg = tx?.AmtDtls?.TxAmt?.CcyXchg
        const srcCcy = ccyXchg ? text(ccyXchg.SrcCcy) : null
        const xchgRate = ccyXchg ? Number(text(ccyXchg.XchgRate) ?? '0') : null
        const txAmtNode = tx?.AmtDtls?.TxAmt?.Amt
        const txAmtCcy = txAmtNode && (txAmtNode['@_Ccy'] as string)
        const origMagnitude =
          srcCcy && srcCcy !== ccy && txAmtNode
            ? Number(text(txAmtNode) ?? '0')
            : null

        const perTxMagnitude =
          txDetailsList.length > 1 && txAmtNode && txAmtCcy === ccy
            ? Number(text(txAmtNode) ?? String(magnitude))
            : magnitude

        rows.push(
          buildRow({
            magnitude: perTxMagnitude,
            ccy,
            direction,
            txDate: valueDate ?? bookingDate ?? '',
            bookingDate,
            valueDate,
            description: ustrd || text(ntry?.AddtlNtryInf) || null,
            reference:
              text(tx?.Refs?.EndToEndId) ??
              text(tx?.Refs?.TxId) ??
              text(ntry?.AcctSvcrRef),
            counterparty,
            origAmount: origMagnitude,
            origCcy: srcCcy && srcCcy !== ccy ? srcCcy : null,
            fxRate: xchgRate || null,
            status,
            raw: tx,
          }),
        )
      }
    }
  }
  return { rows, headers: [], warnings }
}

function buildRow(p: {
  magnitude: number
  ccy: string
  direction: 'debit' | 'credit'
  txDate: string
  bookingDate: string | null
  valueDate: string | null
  description: string | null
  reference: string | null
  counterparty: string | null
  origAmount: number | null
  origCcy: string | null
  fxRate: number | null
  status: string | null
  raw: unknown
}): CanonicalRow {
  const sign = p.direction === 'debit' ? -1 : 1
  return {
    txDate: p.txDate,
    bookingDate: p.bookingDate,
    valueDate: p.valueDate,
    direction: p.direction,
    amount: toMinor(Math.abs(p.magnitude), p.ccy) * sign,
    currency: p.ccy,
    originalAmount:
      p.origAmount != null && p.origCcy
        ? toMinor(Math.abs(p.origAmount), p.origCcy) * sign
        : null,
    originalCurrency: p.origCcy,
    fxRate: p.fxRate,
    merchant: null,
    description: p.description,
    reference: p.reference,
    counterparty: p.counterparty,
    category: null,
    statusText: p.status,
    raw: (p.raw as Record<string, unknown>) ?? {},
    errors: p.txDate ? [] : ['missing date'],
  }
}
