import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.ts'
import { accounts, appSettings, companies } from '../src/db/schema.ts'
import { DEFAULT_MATCHING_CONFIG } from '../src/lib/matching/config.ts'

type SeedCompany = {
  name: string
  slug: string
  classification: 'deliver_media' | 'swiss_media_partners'
}

const SEED_COMPANIES: SeedCompany[] = [
  { name: 'deliver.media GmbH', slug: 'deliver-media', classification: 'deliver_media' },
  {
    name: 'SwissMediaPartners AG',
    slug: 'swiss-media-partners',
    classification: 'swiss_media_partners',
  },
]

async function upsertCompany(c: SeedCompany): Promise<string> {
  const existing = db
    .select()
    .from(companies)
    .where(eq(companies.slug, c.slug))
    .get()
  if (existing) return existing.id
  const row = db
    .insert(companies)
    .values({ name: c.name, slug: c.slug, classification: c.classification })
    .returning()
    .get()
  return row.id
}

function ensureAccount(opts: {
  kind: 'credit_card' | 'bank' | 'accounting'
  institute: string
  label: string
  companyId?: string
  iban?: string
}): void {
  const existing = db
    .select()
    .from(accounts)
    .where(eq(accounts.institute, opts.institute))
    .get()
  if (existing) return
  db.insert(accounts)
    .values({
      kind: opts.kind,
      institute: opts.institute,
      label: opts.label,
      companyId: opts.companyId ?? null,
      iban: opts.iban ?? null,
    })
    .run()
}

async function main() {
  const companyIds: Record<string, string> = {}
  for (const c of SEED_COMPANIES) {
    companyIds[c.slug] = await upsertCompany(c)
  }

  // credit-card accounts
  ensureAccount({ kind: 'credit_card', institute: 'swisscard', label: 'SwissCard' })
  ensureAccount({ kind: 'credit_card', institute: 'revolut', label: 'Revolut' })
  ensureAccount({ kind: 'credit_card', institute: 'cornercard', label: 'CornerCard' })
  ensureAccount({ kind: 'credit_card', institute: 'viseca', label: 'Viseca' })

  // bank account
  ensureAccount({
    kind: 'bank',
    institute: 'raiffeisen',
    label: 'Raiffeisen',
    iban: 'CH1380808008966931391',
  })

  // accounting books, one per company
  ensureAccount({
    kind: 'accounting',
    institute: 'deliver_media_accounting',
    label: 'deliver.media — Accounting',
    companyId: companyIds['deliver-media'],
  })
  ensureAccount({
    kind: 'accounting',
    institute: 'smp_accounting',
    label: 'SwissMediaPartners — Accounting',
    companyId: companyIds['swiss-media-partners'],
  })

  // matching config (single row)
  const existingSettings = db.select().from(appSettings).get()
  if (!existingSettings) {
    db.insert(appSettings)
      .values({
        id: 1,
        config: DEFAULT_MATCHING_CONFIG as unknown as Record<string, unknown>,
      })
      .run()
  }

  console.log('✓ Seeded companies, accounts, and matching config')
}

main()
