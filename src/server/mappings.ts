import { createServerFn } from '@tanstack/react-start'
import { db } from '#/db/client.ts'
import { columnMappings } from '#/db/schema.ts'
import { BUILTIN_PRESETS } from '#/lib/ingest/presets.ts'

export const listMappings = createServerFn({ method: 'GET' }).handler(async () => {
  const builtins = BUILTIN_PRESETS.map((p) => ({
    key: p.key,
    label: p.label,
    institute: p.institute,
    ledger: p.ledger,
    sourceType: p.sourceType,
    builtin: true as const,
  }))
  const saved = db
    .select()
    .from(columnMappings)
    .all()
    .map((m) => ({
      key: m.id,
      label: m.name,
      institute: m.institute,
      ledger: m.ledger,
      sourceType: m.sourceType,
      builtin: false as const,
    }))
  return [...builtins, ...saved]
})
