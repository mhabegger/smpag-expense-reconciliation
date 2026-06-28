import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------
const id = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID())
const createdAt = () =>
  integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
const updatedAt = () =>
  integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)

// ---------------------------------------------------------------------------
// Enums (as TS unions; SQLite has no native enum)
// ---------------------------------------------------------------------------
export const LEDGERS = ['card', 'bank', 'accounting'] as const
export type Ledger = (typeof LEDGERS)[number]

export const SOURCE_TYPES = ['csv', 'excel', 'camt053', 'mt942'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

export const ACCOUNT_KINDS = ['credit_card', 'bank', 'accounting'] as const
export type AccountKind = (typeof ACCOUNT_KINDS)[number]

export const CLASSIFICATIONS = [
  'deliver_media',
  'swiss_media_partners',
  'private',
  'unclassified',
] as const
export type Classification = (typeof CLASSIFICATIONS)[number]

export const DIRECTIONS = ['debit', 'credit'] as const
export type Direction = (typeof DIRECTIONS)[number]

export const RECON_STATUSES = [
  'open',
  'partially_matched',
  'matched',
  'ignored',
] as const
export type ReconStatus = (typeof RECON_STATUSES)[number]

export const MATCH_TYPES = ['accounting', 'reimbursement'] as const
export type MatchType = (typeof MATCH_TYPES)[number]

// ---------------------------------------------------------------------------
// companies
// ---------------------------------------------------------------------------
export const companies = sqliteTable(
  'companies',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    // which classification value maps to this company
    classification: text('classification').$type<Classification>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('companies_slug_uq').on(t.slug)],
)

// ---------------------------------------------------------------------------
// accounts — unified source ledgers (cards, bank, accounting books)
// ---------------------------------------------------------------------------
export const accounts = sqliteTable(
  'accounts',
  {
    id: id(),
    kind: text('kind').$type<AccountKind>().notNull(),
    // institute: swisscard | revolut | cornercard | viseca | raiffeisen
    //            | deliver_media_accounting | smp_accounting | generic
    institute: text('institute').notNull(),
    label: text('label').notNull(),
    companyId: text('company_id').references(() => companies.id),
    defaultCurrency: text('default_currency').notNull().default('CHF'),
    iban: text('iban'),
    cardLast4: text('card_last4'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('accounts_kind_idx').on(t.kind)],
)

// ---------------------------------------------------------------------------
// column_mappings — per-institute reusable presets
// ---------------------------------------------------------------------------
export const columnMappings = sqliteTable(
  'column_mappings',
  {
    id: id(),
    name: text('name').notNull(),
    institute: text('institute').notNull(),
    sourceType: text('source_type').$type<SourceType>().notNull(),
    ledger: text('ledger').$type<Ledger>().notNull(),
    // built-in presets are seeded and recognised by `builtinKey`
    builtinKey: text('builtin_key'),
    headerSignature: text('header_signature'),
    fieldMap: text('field_map', { mode: 'json' })
      .$type<Record<string, string>>()
      .notNull(),
    options: text('options', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    version: integer('version').notNull().default(1),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('column_mappings_institute_idx').on(t.institute, t.sourceType)],
)

// ---------------------------------------------------------------------------
// import_batches
// ---------------------------------------------------------------------------
export const importBatches = sqliteTable(
  'import_batches',
  {
    id: id(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    sourceType: text('source_type').$type<SourceType>().notNull(),
    ledger: text('ledger').$type<Ledger>().notNull(),
    fileName: text('file_name').notNull(),
    fileHash: text('file_hash').notNull(),
    fileSize: integer('file_size').notNull(),
    mappingId: text('mapping_id').references(() => columnMappings.id),
    status: text('status')
      .$type<'committed' | 'reverted'>()
      .notNull()
      .default('committed'),
    rowCount: integer('row_count').notNull().default(0),
    insertedCount: integer('inserted_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    detectedEncoding: text('detected_encoding'),
    detectedDelimiter: text('detected_delimiter'),
    periodStart: text('period_start'),
    periodEnd: text('period_end'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('import_batches_file_hash_uq').on(t.fileHash),
    index('import_batches_account_idx').on(t.accountId),
  ],
)

// ---------------------------------------------------------------------------
// transactions — the unified core ledger table
// ---------------------------------------------------------------------------
export const transactions = sqliteTable(
  'transactions',
  {
    id: id(),
    importBatchId: text('import_batch_id')
      .notNull()
      .references(() => importBatches.id),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    ledger: text('ledger').$type<Ledger>().notNull(),

    // dates (ISO YYYY-MM-DD)
    txDate: text('tx_date').notNull(),
    bookingDate: text('booking_date'),
    valueDate: text('value_date'),

    direction: text('direction').$type<Direction>().notNull(),

    // billed/booked amount (signed minor units) + currency
    amount: integer('amount').notNull(),
    currency: text('currency').notNull().default('CHF'),

    // original (foreign-currency) amount, when present
    originalAmount: integer('original_amount'),
    originalCurrency: text('original_currency'),
    fxRate: real('fx_rate'),

    // CHF-equivalent minor units (precomputed at import for matching band filter)
    chfEquiv: integer('chf_equiv'),

    // descriptive
    merchant: text('merchant'),
    merchantNorm: text('merchant_norm'),
    description: text('description'),
    reference: text('reference'),
    counterparty: text('counterparty'),
    category: text('category'),
    statusText: text('status_text'),

    // classification (card rows)
    classification: text('classification')
      .$type<Classification>()
      .notNull()
      .default('unclassified'),
    classifiedAt: integer('classified_at', { mode: 'timestamp' }),
    classificationSource: text('classification_source').$type<
      'user' | 'rule' | 'inherited'
    >(),

    // reconciliation facets
    reconStatus: text('recon_status')
      .$type<ReconStatus>()
      .notNull()
      .default('open'),
    accountingLinked: integer('accounting_linked', { mode: 'boolean' })
      .notNull()
      .default(false),
    bankLinked: integer('bank_linked', { mode: 'boolean' })
      .notNull()
      .default(false),
    // deliberate "no match exists" markers set by the user in the wizard
    noAccountingMatch: integer('no_accounting_match', { mode: 'boolean' })
      .notNull()
      .default(false),
    noBankMatch: integer('no_bank_match', { mode: 'boolean' })
      .notNull()
      .default(false),
    // "recheck later": flagged when nothing matched yet; revisited after new imports
    pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
    // free-text note on this specific booking
    note: text('note'),

    // dedup + raw
    rowHash: text('row_hash').notNull(),
    rawPayload: text('raw_payload', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('transactions_row_hash_uq').on(t.rowHash),
    index('transactions_ledger_date_idx').on(t.ledger, t.txDate),
    index('transactions_chf_idx').on(t.chfEquiv, t.currency),
    index('transactions_class_idx').on(t.classification),
    index('transactions_recon_idx').on(t.reconStatus),
    index('transactions_account_idx').on(t.accountId),
  ],
)

// ---------------------------------------------------------------------------
// match_candidates — cached, recomputable suggestions
// ---------------------------------------------------------------------------
export const matchCandidates = sqliteTable(
  'match_candidates',
  {
    id: id(),
    anchorTxId: text('anchor_tx_id')
      .notNull()
      .references(() => transactions.id),
    // single-candidate match (null when this is a group suggestion)
    candidateTxId: text('candidate_tx_id').references(() => transactions.id),
    // group suggestion: JSON array of member tx ids that sum to the anchor
    groupMemberIds: text('group_member_ids', { mode: 'json' }).$type<
      string[] | null
    >(),
    matchType: text('match_type').$type<MatchType>().notNull(),
    score: integer('score').notNull(), // 0..100
    scoreBreakdown: text('score_breakdown', { mode: 'json' })
      .$type<{
        amount: number
        date: number
        merchant: number | null
        currency: number
      }>()
      .notNull(),
    convertedAmount: integer('converted_amount'),
    fxRateUsed: real('fx_rate_used'),
    reason: text('reason'),
    status: text('status')
      .$type<'suggested' | 'dismissed'>()
      .notNull()
      .default('suggested'),
    runId: text('run_id').notNull(),
    stale: integer('stale', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('match_candidates_anchor_idx').on(
      t.anchorTxId,
      t.matchType,
      t.score,
    ),
  ],
)

// ---------------------------------------------------------------------------
// match_groups + members — confirmed reconciliations (supports one-to-many)
// ---------------------------------------------------------------------------
export const matchGroups = sqliteTable(
  'match_groups',
  {
    id: id(),
    anchorTxId: text('anchor_tx_id')
      .notNull()
      .references(() => transactions.id),
    matchType: text('match_type').$type<MatchType>().notNull(),
    matchedAmount: integer('matched_amount').notNull(),
    currency: text('currency').notNull(),
    confidence: integer('confidence').notNull().default(0),
    note: text('note'),
    confirmedBy: text('confirmed_by').notNull().default('user'),
    confirmedAt: createdAt(),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (t) => [index('match_groups_anchor_idx').on(t.anchorTxId, t.matchType)],
)

export const matchGroupMembers = sqliteTable(
  'match_group_members',
  {
    id: id(),
    groupId: text('group_id')
      .notNull()
      .references(() => matchGroups.id),
    txId: text('tx_id')
      .notNull()
      .references(() => transactions.id),
    contributedAmount: integer('contributed_amount').notNull(),
  },
  (t) => [
    uniqueIndex('match_group_members_uq').on(t.groupId, t.txId),
    index('match_group_members_tx_idx').on(t.txId),
  ],
)

// ---------------------------------------------------------------------------
// fx_rates — cached exchange rates
// ---------------------------------------------------------------------------
export const fxRates = sqliteTable(
  'fx_rates',
  {
    id: id(),
    date: text('date').notNull(), // ISO date the rate applies to
    base: text('base').notNull(),
    quote: text('quote').notNull(),
    rate: real('rate').notNull(), // 1 base = rate quote
    source: text('source')
      .$type<'frankfurter' | 'manual' | 'card'>()
      .notNull()
      .default('frankfurter'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('fx_rates_uq').on(t.date, t.base, t.quote, t.source),
    index('fx_rates_lookup_idx').on(t.base, t.quote, t.date),
  ],
)

// ---------------------------------------------------------------------------
// classification_rules — optional auto-classify
// ---------------------------------------------------------------------------
export const classificationRules = sqliteTable('classification_rules', {
  id: id(),
  pattern: text('pattern').notNull(),
  isRegex: integer('is_regex', { mode: 'boolean' }).notNull().default(false),
  classification: text('classification').$type<Classification>().notNull(),
  priority: integer('priority').notNull().default(0),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
})

// ---------------------------------------------------------------------------
// audit_log
// ---------------------------------------------------------------------------
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: id(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),
    detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_entity_idx').on(t.entity, t.entityId)],
)

// ---------------------------------------------------------------------------
// merchant_notes — a persistent note per merchant (keyed by normalized name)
// ---------------------------------------------------------------------------
export const merchantNotes = sqliteTable('merchant_notes', {
  merchantNorm: text('merchant_norm').primaryKey(),
  note: text('note').notNull(),
  updatedAt: updatedAt(),
})

// ---------------------------------------------------------------------------
// app_settings — single-row matching configuration (id = 1)
// ---------------------------------------------------------------------------
export const appSettings = sqliteTable('app_settings', {
  id: integer('id').primaryKey().default(1),
  config: text('config', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull(),
  updatedAt: updatedAt(),
})
