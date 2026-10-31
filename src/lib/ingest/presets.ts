import type { BuiltinPreset } from '#/lib/ingest/types.ts'

/**
 * Built-in, pre-tested mapping presets for the seven confirmed real-world
 * formats. Each is recognised automatically by its header signature; the
 * generic mapping wizard covers anything else.
 */
export const BUILTIN_PRESETS: BuiltinPreset[] = [
  // ---- SwissCard (XLSX) ----------------------------------------------------
  {
    key: 'swisscard_xlsx',
    label: 'SwissCard (Excel)',
    institute: 'swisscard',
    ledger: 'card',
    sourceType: 'excel',
    headerSignature: [
      'Transaction date',
      'Merchant',
      'Debit/Credit',
      'Amount in foreign currency',
    ],
    fieldMap: {
      txDate: 'Transaction date',
      description: 'Description',
      merchant: 'Merchant',
      currency: 'Currency',
      amount: 'Amount',
      originalCurrency: 'Foreign Currency',
      originalAmount: 'Amount in foreign currency',
      category: 'Merchant Category',
      statusText: 'Status',
    },
    options: {
      dateFormat: 'excel-serial',
      decimalSeparator: '.',
      signConvention: 'debit_credit_indicator',
      debitCreditColumn: 'Debit/Credit',
      debitValues: ['debit'],
      creditValues: ['credit'],
      defaultCurrency: 'CHF',
    },
  },

  // ---- Revolut (CSV) -------------------------------------------------------
  {
    key: 'revolut_csv',
    label: 'Revolut (CSV)',
    institute: 'revolut',
    ledger: 'card',
    sourceType: 'csv',
    headerSignature: ['Type', 'Started Date', 'Completed Date', 'State', 'Balance'],
    fieldMap: {
      txDate: 'Started Date',
      bookingDate: 'Completed Date',
      description: 'Description',
      merchant: 'Description',
      amount: 'Amount',
      currency: 'Currency',
      category: 'Type',
      statusText: 'State',
    },
    options: {
      dateFormat: 'iso',
      decimalSeparator: '.',
      signConvention: 'signed',
      defaultCurrency: 'CHF',
      // holds released by the merchant (EV chargers block 45–50 CHF) and declines
      skipStatuses: ['REVERTED', 'DECLINED', 'FAILED'],
    },
  },

  // ---- CornerCard (XLS) ----------------------------------------------------
  {
    key: 'cornercard_xls',
    label: 'CornerCard (Excel)',
    institute: 'cornercard',
    ledger: 'card',
    sourceType: 'excel',
    headerSignature: ['Date', 'Description', 'Card', 'Amount', 'Status'],
    fieldMap: {
      txDate: 'Date',
      description: 'Description',
      merchant: 'Description',
      currency: 'Currency',
      amount: 'Amount',
      statusText: 'Status',
    },
    options: {
      dateFormat: 'dd/MM/yyyy',
      decimalSeparator: '.',
      signConvention: 'positive_is_debit',
      defaultCurrency: 'CHF',
    },
  },

  // ---- Viseca (CSV) --------------------------------------------------------
  {
    key: 'viseca_csv',
    label: 'Viseca (CSV)',
    institute: 'viseca',
    ledger: 'card',
    sourceType: 'csv',
    headerSignature: [
      'TransactionId',
      'MerchantName',
      'OriginalCurrency',
      'Exchange Rate',
    ],
    fieldMap: {
      txDate: 'Date',
      valueDate: 'ValutaDate',
      amount: 'Amount',
      currency: 'Currency',
      originalAmount: 'OriginalAmount',
      originalCurrency: 'OriginalCurrency',
      merchant: 'MerchantName',
      description: 'Details',
      reference: 'TransactionId',
      category: 'Type',
      statusText: 'StateType',
      fxRate: 'Exchange Rate',
    },
    options: {
      dateFormat: 'iso',
      decimalSeparator: '.',
      signConvention: 'positive_is_debit',
      defaultCurrency: 'CHF',
    },
  },

  // ---- Raiffeisen (CSV, custom two-row parser) -----------------------------
  {
    key: 'raiffeisen_csv',
    label: 'Raiffeisen (CSV)',
    institute: 'raiffeisen',
    ledger: 'bank',
    sourceType: 'csv',
    headerSignature: ['IBAN', 'Booked At', 'Credit/Debit Amount', 'Valuta Date'],
    customParser: 'raiffeisenCsv',
    fieldMap: {},
    options: { delimiter: ';', encoding: 'windows-1252', defaultCurrency: 'CHF' },
  },

  // ---- Accounting: deliver.media (XLSX) ------------------------------------
  {
    key: 'accounting_delivermedia_xlsx',
    label: 'deliver.media — Accounting (Excel)',
    institute: 'deliver_media_accounting',
    ledger: 'accounting',
    sourceType: 'excel',
    headerSignature: [
      'ID',
      'Titel',
      'Dokumentendatum',
      'Erstellt am',
      'Zahlungsstatus',
      'Betrag',
    ],
    fieldMap: {
      reference: 'ID',
      merchant: 'Titel',
      description: 'Titel',
      txDate: 'Dokumentendatum',
      amount: 'Betrag',
      category: 'Zahlungsart',
      statusText: 'Zahlungsstatus',
    },
    options: {
      dateFormat: 'excel-serial',
      decimalSeparator: '.',
      amountInCurrencyCell: true,
      signConvention: 'positive_is_debit',
      dropRowsWithoutField: 'reference',
      defaultCurrency: 'CHF',
    },
  },

  // ---- Accounting: SwissMediaPartners (XLSX) -------------------------------
  {
    key: 'accounting_smp_xlsx',
    label: 'SwissMediaPartners — Accounting (Excel)',
    institute: 'smp_accounting',
    ledger: 'accounting',
    sourceType: 'excel',
    headerSignature: [
      'ID',
      'Titel',
      'Dokumentendatum',
      'Zahlungsstatus',
      'Betrag',
      'Verarbeitungsmethode',
    ],
    fieldMap: {
      reference: 'ID',
      merchant: 'Titel',
      description: 'Titel',
      txDate: 'Dokumentendatum',
      amount: 'Betrag',
      category: 'Zahlungsart',
      statusText: 'Zahlungsstatus',
    },
    options: {
      dateFormat: 'excel-serial',
      decimalSeparator: '.',
      amountInCurrencyCell: true,
      signConvention: 'positive_is_debit',
      dropRowsWithoutField: 'reference',
      defaultCurrency: 'CHF',
    },
  },
]

function normToken(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/** Find the best built-in preset for a set of source headers (or null). */
export function matchPresetByHeaders(headers: string[]): BuiltinPreset | null {
  const set = new Set(headers.map(normToken))
  let best: { preset: BuiltinPreset; score: number } | null = null
  for (const preset of BUILTIN_PRESETS) {
    const sig = preset.headerSignature.map(normToken)
    const present = sig.filter((t) => set.has(t)).length
    if (present === sig.length) {
      const score = present
      if (!best || score > best.score) best = { preset, score }
    }
  }
  return best?.preset ?? null
}

export function getPresetByKey(key: string): BuiltinPreset | null {
  return BUILTIN_PRESETS.find((p) => p.key === key) ?? null
}

export function getPresetForInstitute(institute: string): BuiltinPreset | null {
  return BUILTIN_PRESETS.find((p) => p.institute === institute) ?? null
}
