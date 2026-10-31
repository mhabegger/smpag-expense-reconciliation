import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Sparkles, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { getReconQueue, runMatching } from '#/server/matching.ts'
import { PageHeader } from '#/components/layout/AppShell.tsx'
import { Button } from '#/components/ui/button.tsx'
import { Card, CardContent } from '#/components/ui/card.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select.tsx'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table.tsx'
import {
  Amount,
  ClassificationBadge,
  COMPANY_DOT,
  Pill,
  ReconBadge,
} from '#/components/shared/bits.tsx'
import { formatMoney } from '#/lib/money.ts'
import { cn } from '#/lib/utils.ts'
import { sortIcon } from '#/components/shared/sort.tsx'

type QueueStatus = 'all' | 'open' | 'unclassified' | 'reconciled' | 'pending'
const queueQuery = (status: QueueStatus) => ({
  queryKey: ['reconQueue', { status }],
  queryFn: () => getReconQueue({ data: { status } }),
})

export const Route = createFileRoute('/reconcile/')({
  component: ReconcileQueue,
  loader: ({ context }) => context.queryClient.ensureQueryData(queueQuery('open')),
})

function ReconcileQueue() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [status, setStatus] = useState<QueueStatus>('open')
  const [sortBy, setSortBy] = useState<
    'txDate' | 'merchant' | 'amount' | 'classification' | 'reconStatus'
  >('txDate')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const toggleSort = (by: typeof sortBy) => {
    if (sortBy === by) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortBy(by)
      setSortDir('desc')
    }
  }

  const { data } = useQuery(queueQuery(status))

  const match = useMutation({
    mutationFn: () => runMatching({ data: {} }),
    onSuccess: (res) => {
      toast.success(
        `Matched ${res.anchors} expenses · ${res.candidatesCreated} candidates`,
      )
      qc.invalidateQueries({ queryKey: ['reconQueue'] })
      qc.invalidateQueries({ queryKey: ['reconcileItem'] })
    },
  })

  const counts = data?.counts
  const items = data?.items ?? []
  const sortedItems = [...items].sort((a, b) => {
    let c = 0
    switch (sortBy) {
      case 'amount':
        c = Math.abs(a.amount) - Math.abs(b.amount)
        break
      case 'merchant':
        c = (a.merchant ?? '').localeCompare(b.merchant ?? '')
        break
      case 'classification':
        c = a.classification.localeCompare(b.classification)
        break
      case 'reconStatus':
        c = a.reconStatus.localeCompare(b.reconStatus)
        break
      default:
        c = a.txDate.localeCompare(b.txDate)
    }
    return sortDir === 'asc' ? c : -c
  })

  return (
    <div>
      <PageHeader
        title="Reconcile"
        description="Go through each card expense: classify, then confirm the matches."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => match.mutate()}
              disabled={match.isPending}
            >
              {match.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              Run matching
            </Button>
            <Button
              disabled={sortedItems.length === 0}
              onClick={() =>
                sortedItems[0] &&
                navigate({
                  to: '/reconcile/$id',
                  params: { id: sortedItems[0].id },
                })
              }
            >
              <Play className="size-4" /> Start reviewing
            </Button>
          </div>
        }
      />
      <div className="space-y-4 px-8 py-6">
        {counts && data && (
          <div className="grid gap-3 sm:grid-cols-6">
            <Card>
              <CardContent className="py-4">
                <div className="text-xs text-muted-foreground">Not yet reimbursed</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums text-warning">
                  {formatMoney(data.outstanding.total, 'CHF')}
                </div>
                <div className="mt-2 space-y-0.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span className={cn('size-2 rounded-full', COMPANY_DOT.swiss_media_partners)} />
                      SMP
                    </span>
                    <span className="tabular-nums">{formatMoney(data.outstanding.smp, 'CHF')}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span className={cn('size-2 rounded-full', COMPANY_DOT.deliver_media)} />
                      DM
                    </span>
                    <span className="tabular-nums">{formatMoney(data.outstanding.dm, 'CHF')}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Stat label="Total expenses" value={counts.total} />
            <Stat label="Unclassified" value={counts.unclassified} tone="warning" />
            <Stat label="Open" value={counts.open} tone="warning" />
            <Stat label="Pending" value={counts.pending} tone="warning" />
            <Stat label="Reconciled" value={counts.reconciled} tone="success" />
          </div>
        )}

        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={(v) => setStatus(v as never)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="open">Open (needs work)</SelectItem>
              <SelectItem value="unclassified">Unclassified</SelectItem>
              <SelectItem value="pending">Pending (recheck later)</SelectItem>
              <SelectItem value="reconciled">Reconciled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort('txDate')}
                  >
                    <span className="inline-flex items-center gap-1">
                      Date {sortIcon('txDate', sortBy, sortDir)}
                    </span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort('merchant')}
                  >
                    <span className="inline-flex items-center gap-1">
                      Merchant {sortIcon('merchant', sortBy, sortDir)}
                    </span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none text-right"
                    onClick={() => toggleSort('amount')}
                  >
                    <span className="inline-flex items-center justify-end gap-1">
                      Amount {sortIcon('amount', sortBy, sortDir)}
                    </span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort('classification')}
                  >
                    <span className="inline-flex items-center gap-1">
                      Class {sortIcon('classification', sortBy, sortDir)}
                    </span>
                  </TableHead>
                  <TableHead>Acct</TableHead>
                  <TableHead>Bank</TableHead>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort('reconStatus')}
                  >
                    <span className="inline-flex items-center gap-1">
                      Status {sortIcon('reconStatus', sortBy, sortDir)}
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedItems.map((it) => (
                  <TableRow
                    key={it.id}
                    className="cursor-pointer"
                    onClick={() =>
                      navigate({ to: '/reconcile/$id', params: { id: it.id } })
                    }
                  >
                    <TableCell className="text-xs tabular-nums">{it.txDate}</TableCell>
                    <TableCell className="max-w-[280px] truncate">
                      {it.merchant ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount minor={it.amount} currency={it.currency} />
                    </TableCell>
                    <TableCell>
                      <ClassificationBadge value={it.classification} />
                    </TableCell>
                    <TableCell>
                      {it.accountingLinked ? (
                        <Pill tone="success">✓</Pill>
                      ) : it.noAccountingMatch ? (
                        <Pill>n/a</Pill>
                      ) : (
                        ''
                      )}
                    </TableCell>
                    <TableCell>
                      {it.bankLinked ? (
                        <Pill tone="success">✓</Pill>
                      ) : it.noBankMatch ? (
                        <Pill>n/a</Pill>
                      ) : (
                        ''
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5">
                        {it.pending && <Pill tone="warning">Pending</Pill>}
                        <ReconBadge value={it.reconStatus} />
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
                {items.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      Nothing here. Import card statements, then Run matching.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'warning' | 'success'
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div
          className={
            'mt-1 text-xl font-semibold tabular-nums' +
            (tone === 'warning'
              ? ' text-warning'
              : tone === 'success'
                ? ' text-success'
                : '')
          }
        >
          {value}
        </div>
      </CardContent>
    </Card>
  )
}
