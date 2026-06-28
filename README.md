# Expense Reconciliation

A local-first web app that reconciles personal credit-card expenses against
company accounting exports and your Raiffeisen bank statements — so you can see,
per company, **what you registered for payout** and **what was actually
reimbursed**.

Built for two companies: **deliver.media GmbH** and **SwissMediaPartners AG**.

Everything runs on your machine. All data lives in a local SQLite file
(`data/app.db`); nothing is uploaded anywhere except optional FX-rate lookups
(ECB via Frankfurter).

## Stack

TanStack Start (Router/Query/Table/Form) · React 19 · Vite · SQLite via
better-sqlite3 + Drizzle ORM · Tailwind v4 + shadcn/ui (dark mode) · pnpm.

## First run

```bash
pnpm install
pnpm setup        # runs migrations + seeds companies/accounts
pnpm dev          # http://localhost:3000
```

`pnpm setup` is `db:migrate` + `db:seed`. To wipe and start over: `pnpm db:reset`.

## How to use it

1. **Import** (`/import/new`) — drop a statement. Format, encoding, delimiter and
   the right preset are auto-detected for all supported sources:

   | Source | Format | Notes |
   | --- | --- | --- |
   | SwissCard | `.xlsx` | serial dates, Debit/Credit column, FX columns |
   | CornerCard | `.xls` | `DD/MM/YYYY`, inverted sign, no FX |
   | Viseca | `.csv` | clean merchant, FX + exchange rate, 3-decimal amounts |
   | Revolut | `.csv` | already-signed amounts |
   | Raiffeisen | `.csv` | `;`/Latin-1, two-row merge, counterparty text |
   | Raiffeisen | camt.053 / MT942 | also supported (XML / SWIFT) |
   | deliver.media / SwissMediaPartners | `.xlsx` | German headers, amount+currency split |

   Re-importing the same or an overlapping file is safe — duplicate rows are
   skipped (per-row content hashing).

2. **Reconcile** (`/reconcile`) — click *Run matching*, then *Start reviewing*.
   For each card expense: classify it (`1` deliver.media, `2` SwissMediaPartners,
   `3` Private), then confirm the suggested **accounting** entry and **bank**
   reimbursement. Cross-currency (USD/EUR↔CHF) and grouped reimbursements
   (several expenses → one transfer) are handled. Keyboard: `↑/↓` select,
   `Enter` accept, `x` reject, `←/→` prev/next.

3. **Dashboard** (`/`) — per company: outstanding amount owed to you, % registered,
   % reimbursed, plus exception lists (*not registered*, *registered but not
   reimbursed*) that deep-link into the review wizard.

## Loading your real data

Upload exports via `/import/new`, or drop them in `./samples/` and bulk-load:

```bash
pnpm tsx scripts/import_samples.ts
```

`/data` and `/samples` are git-ignored.

## Scripts

- `pnpm dev` / `pnpm build` / `pnpm start` — develop / build / serve production
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm test` — unit tests (parsers, scorers, similarity, subset-sum, money)
- `pnpm db:generate` — generate a migration after editing `src/db/schema.ts`
- `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` / `pnpm db:studio`

## Where things live

- `src/db/` — Drizzle schema, client, types
- `src/lib/ingest/` — detection, parsers, presets, canonical mapping, dedup, commit
- `src/lib/matching/` — scoring, similarity, subset-sum groups, the engine
- `src/lib/fx/` — Frankfurter (ECB) rate fetch + cache
- `src/server/` — TanStack Start server functions (the API surface)
- `src/routes/` — pages; `src/components/` — UI
