import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, TriangleAlert, Clock } from 'lucide-react'
import { getDashboard } from '#/server/dashboard.ts'
import { PageHeader } from '#/components/layout/AppShell.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card.tsx'
import { Progress } from '#/components/ui/progress.tsx'
import { Amount, COMPANY_DOT } from '#/components/shared/bits.tsx'
import { formatMoney } from '#/lib/money.ts'
import { pct } from '#/lib/format.ts'
import { cn } from '#/lib/utils.ts'

const dashboardQuery = {
  queryKey: ['dashboard'],
  queryFn: () => getDashboard(),
}

export const Route = createFileRoute('/')({
  component: Dashboard,
  loader: ({ context }) => context.queryClient.ensureQueryData(dashboardQuery),
})

function Dashboard() {
  const { data, isLoading } = useQuery(dashboardQuery)

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="What each company still owes you, and what's missing."
      />
      <div className="space-y-8 px-8 py-6">
        {isLoading || !data ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              {data.perCompany.map((c) => (
                <Card key={c.companyId}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            'size-2.5 rounded-full',
                            COMPANY_DOT[c.classification],
                          )}
                        />
                        {c.name}
                      </span>
                      <span className="text-sm font-normal text-muted-foreground">
                        {c.count} expenses
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <div className="text-xs text-muted-foreground">
                        Outstanding (not yet reimbursed)
                      </div>
                      <div className="text-3xl font-semibold tabular-nums text-warning">
                        {formatMoney(c.outstandingChf, 'CHF')}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <Metric
                        label="Registered"
                        value={`${c.registeredCount}/${c.count}`}
                        ratio={c.registeredPct}
                      />
                      <Metric
                        label="Reimbursed"
                        value={`${c.reimbursedCount}/${c.count}`}
                        ratio={c.reimbursedPct}
                      />
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Total expenses</span>
                      <Amount
                        minor={c.totalChf}
                        currency="CHF"
                        className="font-medium"
                      />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-5">
              <StatCard label="Card expenses" value={data.totals.cardExpenses} />
              <StatCard
                label="Unclassified"
                value={data.totals.unclassified}
                tone={data.totals.unclassified > 0 ? 'warning' : undefined}
              />
              <StatCard
                label="Pending recheck"
                value={data.totals.pending}
                tone={data.totals.pending > 0 ? 'warning' : undefined}
              />
              <StatCard label="Private" value={data.totals.privateCount} />
              <StatCard label="Bank credits" value={data.totals.bankCredits} />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <ExceptionList
                title="Not registered for payout"
                hint="Company expenses with no matching accounting entry"
                icon={<TriangleAlert className="size-4 text-warning" />}
                rows={data.exceptions.notRegistered}
              />
              <ExceptionList
                title="Registered but not reimbursed"
                hint="Awaiting the money to come back to your account"
                icon={<Clock className="size-4 text-warning" />}
                rows={data.exceptions.registeredNotReimbursed}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  ratio,
}: {
  label: string
  value: string
  ratio: number
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{value}</span>
      </div>
      <Progress value={ratio * 100} className="mt-1.5 h-1.5" />
      <div className="mt-1 text-xs text-muted-foreground">{pct(ratio)}</div>
    </div>
  )
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'warning'
}) {
  return (
    <Card>
      <CardContent className="py-5">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div
          className={
            'mt-1 text-2xl font-semibold tabular-nums' +
            (tone === 'warning' ? ' text-warning' : '')
          }
        >
          {value}
        </div>
      </CardContent>
    </Card>
  )
}

function ExceptionList({
  title,
  hint,
  icon,
  rows,
}: {
  title: string
  hint: string
  icon: React.ReactNode
  rows: Array<{
    id: string
    txDate: string
    merchant: string | null
    amount: number
    currency: string
    chf: number
    classification: string
  }>
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
          <span className="ml-auto text-sm font-normal text-muted-foreground">
            {rows.length}
          </span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardHeader>
      <CardContent className="px-0">
        {rows.length === 0 ? (
          <div className="px-6 py-6 text-sm text-muted-foreground">
            Nothing here — all clear.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.slice(0, 8).map((r) => (
              <li key={r.id}>
                <Link
                  to="/reconcile/$id"
                  params={{ id: r.id }}
                  className="flex items-center gap-3 px-6 py-2.5 text-sm hover:bg-accent"
                >
                  <span className="w-20 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {r.txDate}
                  </span>
                  <span className="flex-1 truncate">{r.merchant ?? '—'}</span>
                  <Amount
                    minor={r.amount}
                    currency={r.currency}
                    className="font-medium"
                  />
                  <ArrowRight className="size-3.5 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
