import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type * as s from './schema.ts'

export type Company = InferSelectModel<typeof s.companies>
export type Account = InferSelectModel<typeof s.accounts>
export type NewAccount = InferInsertModel<typeof s.accounts>
export type ColumnMapping = InferSelectModel<typeof s.columnMappings>
export type NewColumnMapping = InferInsertModel<typeof s.columnMappings>
export type ImportBatch = InferSelectModel<typeof s.importBatches>
export type Transaction = InferSelectModel<typeof s.transactions>
export type NewTransaction = InferInsertModel<typeof s.transactions>
export type MatchCandidate = InferSelectModel<typeof s.matchCandidates>
export type NewMatchCandidate = InferInsertModel<typeof s.matchCandidates>
export type MatchGroup = InferSelectModel<typeof s.matchGroups>
export type MatchGroupMember = InferSelectModel<typeof s.matchGroupMembers>
export type FxRate = InferSelectModel<typeof s.fxRates>
export type ClassificationRule = InferSelectModel<typeof s.classificationRules>

export type {
  Ledger,
  SourceType,
  AccountKind,
  Classification,
  Direction,
  ReconStatus,
  MatchType,
} from './schema.ts'
