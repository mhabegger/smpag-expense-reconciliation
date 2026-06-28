import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db/client.ts'
import { merchantNotes, transactions } from '#/db/schema.ts'

export const setTransactionNote = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    z.object({ id: z.string(), note: z.string() }).parse(d),
  )
  .handler(async ({ data }) => {
    db.update(transactions)
      .set({ note: data.note.trim() || null, updatedAt: new Date() })
      .where(eq(transactions.id, data.id))
      .run()
    return { ok: true as const }
  })

export const setMerchantNote = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    z.object({ merchantNorm: z.string().min(1), note: z.string() }).parse(d),
  )
  .handler(async ({ data }) => {
    const note = data.note.trim()
    if (!note) {
      db.delete(merchantNotes)
        .where(eq(merchantNotes.merchantNorm, data.merchantNorm))
        .run()
      return { ok: true as const }
    }
    db.insert(merchantNotes)
      .values({ merchantNorm: data.merchantNorm, note, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: merchantNotes.merchantNorm,
        set: { note, updatedAt: new Date() },
      })
      .run()
    return { ok: true as const }
  })
