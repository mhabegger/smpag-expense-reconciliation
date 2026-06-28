declare module '@centrapay/swift-parser' {
  export interface SwiftTransaction {
    date: Date
    entryDate?: Date
    amount: { toString(): string; toNumber?: () => number } | number | string
    currency: string
    details?: string
    transactionType?: string
    reference?: string
    bankReference?: string
    extraDetails?: string
    reversal?: boolean
    structuredDetails?: Record<string, string>
  }
  export interface SwiftStatement {
    transactionReference?: string
    accountIdentification?: string
    number?: { statement?: string; sequence?: string }
    statementDate?: Date
    currency?: string
    transactions: SwiftTransaction[]
  }
  export function parse(opts: {
    type: string
    data: string
    validate?: boolean
  }): SwiftStatement[]
  const _default: { parse: typeof parse }
  export default _default
}
