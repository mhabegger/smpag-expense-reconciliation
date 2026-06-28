import { eq } from 'drizzle-orm'
import { db } from '#/db/client.ts'
import { merchantNotes } from '#/db/schema.ts'

// Server-only helper (touches the DB). Kept out of notes.ts so it never rides
// into the client bundle via the server-fn imports there.
export function merchantNoteFor(merchantNorm: string | null): string | null {
  if (!merchantNorm) return null
  return (
    db
      .select()
      .from(merchantNotes)
      .where(eq(merchantNotes.merchantNorm, merchantNorm))
      .get()?.note ?? null
  )
}
