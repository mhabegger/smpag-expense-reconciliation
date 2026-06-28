import type { Direction, Ledger, SourceType } from '#/db/types.ts'

// Canonical fields the wizard maps source columns INTO.
export type NormalizedField =
  | 'txDate'
  | 'bookingDate'
  | 'valueDate'
  | 'amount'
  | 'currency'
  | 'originalAmount'
  | 'originalCurrency'
  | 'fxRate'
  | 'fee'
  | 'direction'
  | 'merchant'
  | 'description'
  | 'reference'
  | 'counterparty'
  | 'category'
  | 'statusText'
  | 'balanceAfter'

export type FieldMap = Partial<Record<NormalizedField, string>>

export type SignConvention =
  | 'signed' // single signed amount column (negative = debit)
  | 'positive_is_debit' // single column, positive value = a charge (debit)
  | 'debit_credit_indicator' // amount magnitude + a direction column
  | 'two_columns' // separate debit and credit columns

export interface MappingOptions {
  dateFormat?: string // 'iso' | 'excel-serial' | a date-fns pattern like 'dd.MM.yyyy'
  decimalSeparator?: ',' | '.'
  thousandsSeparator?: "'" | ',' | '.' | ' ' | ''
  amountInCurrencyCell?: boolean // e.g. "120.65 USD"
  signConvention?: SignConvention
  debitCreditColumn?: string
  debitValues?: string[]
  creditValues?: string[]
  debitColumn?: string
  creditColumn?: string
  invertSign?: boolean
  defaultCurrency?: string
  defaultDirection?: Direction
  // excel
  sheetName?: string
  headerRow?: number
  // csv
  delimiter?: string
  encoding?: string
  // structural row handling
  dropRowsWithoutField?: NormalizedField // drop rows where this canonical field is empty (continuation rows)
}

/** A fully normalized transaction row produced by a parser. Amounts are signed
 * MINOR units (debit negative, credit positive). */
export interface CanonicalRow {
  txDate: string // ISO yyyy-mm-dd
  bookingDate?: string | null
  valueDate?: string | null
  direction: Direction
  amount: number // signed minor units
  currency: string
  originalAmount?: number | null // signed minor units in original currency
  originalCurrency?: string | null
  fxRate?: number | null
  merchant?: string | null
  description?: string | null
  reference?: string | null
  counterparty?: string | null
  category?: string | null
  statusText?: string | null
  raw: Record<string, unknown>
  errors: string[]
}

export interface ParseResult {
  rows: CanonicalRow[]
  headers: string[] // source headers (tabular) or [] for structured
  warnings: string[]
}

export interface BuiltinPreset {
  key: string
  label: string
  institute: string
  ledger: Ledger
  sourceType: SourceType
  /** Distinct header tokens used to recognise this format automatically. */
  headerSignature: string[]
  /** A dedicated structured/custom parser id, when the format is not generic-tabular. */
  customParser?: 'raiffeisenCsv' | 'camt053' | 'mt942'
  fieldMap: FieldMap
  options: MappingOptions
}
