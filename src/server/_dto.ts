import type { Transaction } from '#/db/types.ts'

// rawPayload is an arbitrary JSON blob (Record<string, unknown>) which the
// server-fn serializer can't statically verify. Strip it from anything we send
// to the client; expose it separately as a JSON string when needed.
export type TxDto = Omit<Transaction, 'rawPayload'>

export function txDto(t: Transaction): TxDto {
  const { rawPayload, ...rest } = t
  return rest
}

export function txDtoList(rows: Transaction[]): TxDto[] {
  return rows.map(txDto)
}
