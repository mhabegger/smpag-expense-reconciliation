import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db/client.ts'
import { accounts, companies } from '#/db/schema.ts'

export const listAccounts = createServerFn({ method: 'GET' }).handler(async () => {
  const accs = db.select().from(accounts).all()
  const comps = db.select().from(companies).all()
  const byId = new Map(comps.map((c) => [c.id, c]))
  return accs.map((a) => ({
    ...a,
    company: a.companyId ? (byId.get(a.companyId) ?? null) : null,
  }))
})

export const listCompanies = createServerFn({ method: 'GET' }).handler(async () => {
  return db.select().from(companies).all()
})

export const getAccountByInstitute = createServerFn({ method: 'GET' })
  .validator((d: unknown) => z.string().min(1).parse(d))
  .handler(async ({ data: institute }) => {
    return (
      db.select().from(accounts).where(eq(accounts.institute, institute)).get() ??
      null
    )
  })
