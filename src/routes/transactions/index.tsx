import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  bulkClassifyByFilter,
  classifyTransaction,
  listTransactions,
  restoreClassifications,
  setClassification as setTxClassification,
} from '#/server/transactions.ts'
import { pushUndo } from '#/lib/undo.ts'
import { listAccounts } from '#/server/accounts.ts'
import { PageHeader } from '#/components/layout/AppShell.tsx'
import { Input } from '#/components/ui/input.tsx'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog.tsx'
import { Amount, Pill, ReconBadge } from '#/components/shared/bits.tsx'
import { Users, Loader2, StickyNote } from 'lucide-react'
import { cn } from '#/lib/utils.ts'
import { TransactionDetailDialog } from '#/components/shared/TransactionDetailDialog.tsx'
import { sortIcon } from '#/components/shared/sort.tsx'
import type { Ledger } from '#/db/types.ts'

const PAGE_SIZE = 50

export const Route = createFileRoute('/transactions/')({
  component: Transactions,
  loader: ({ context }) => {
    const f = {
      ledger: 'card' as const,
      sortBy: 'txDate' as const,
      sortDir: 'desc' as const,
      page: 0,
      pageSize: PAGE_SIZE,
    }
    return context.queryClient.ensureQueryData({
      queryKey: ['transactions', f],
      queryFn: () => listTransactions({ data: f }),
    })
  },
})

function Transactions() {
  const qc = useQueryClient()
  const [ledger, setLedger] = useState<Ledger | 'all'>('card')
  const [classification, setClassification] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [sortBy, setSortBy] = useState<
    'txDate' | 'bookingDate' | 'amount' | 'merchant'
  >('txDate')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const filter = {
    ledger: ledger === 'all' ? undefined : ledger,
    classification:
      classification === 'all' ? undefined : (classification as never),
    search: search || undefined,
    sortBy,
    sortDir,
    page,
    pageSize: PAGE_SIZE,
  }

  const toggleSort = (by: typeof sortBy) => {
    if (sortBy === by) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortBy(by)
      setSortDir('desc')
    }
    setPage(0)
  }

  const { data } = useQuery({
    queryKey: ['transactions', filter],
    queryFn: () => listTransactions({ data: filter }),
  })
  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => listAccounts(),
  })
  const accById = new Map((accounts ?? []).map((a) => [a.id, a]))

  const [bulkOpen, setBulkOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const classify = useMutation({
    mutationFn: (v: { id: string; classification: string }) =>
      classifyTransaction({ data: v as never }),
    onMutate: (v) => ({
      prev:
        data?.rows.find((r) => r.id === v.id)?.classification ?? 'unclassified',
    }),
    onSuccess: (_d, v, ctx) => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      pushUndo({
        label: 'classification',
        run: () =>
          setTxClassification({ data: { id: v.id, classification: ctx!.prev } }),
      })
      toast.success('Classified')
    },
  })

  const bulkAssign = useMutation({
    mutationFn: (classification: string) =>
      bulkClassifyByFilter({ data: { filter, classification: classification as never } }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      qc.invalidateQueries({ queryKey: ['reconQueue'] })
      setBulkOpen(false)
      if (res.prev.length)
        pushUndo({
          label: `bulk classify (${res.updated})`,
          run: () => restoreClassifications({ data: { items: res.prev } }),
        })
      toast.success(`Classified ${res.updated} card expense(s)`)
    },
  })

  // s / d / f keyboard shortcuts while the bulk-assign dialog is open
  useEffect(() => {
    if (!bulkOpen) return
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const k = e.key.toLowerCase()
      if (k === 's') bulkAssign.mutate('swiss_media_partners')
      else if (k === 'd') bulkAssign.mutate('deliver_media')
      else if (k === 'f') bulkAssign.mutate('private')
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [bulkOpen, bulkAssign])

  const total = data?.total ?? 0
  const rows = data?.rows ?? []
  const pages = Math.ceil(total / PAGE_SIZE)

  return (
    <div>
      <PageHeader title="Transactions" description={`${total} rows`} />
      <div className="space-y-4 px-8 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={ledger}
            onValueChange={(v) => {
              setLedger(v as never)
              setPage(0)
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All ledgers</SelectItem>
              <SelectItem value="card">Card</SelectItem>
              <SelectItem value="bank">Bank</SelectItem>
              <SelectItem value="accounting">Accounting</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={classification}
            onValueChange={(v) => {
              setClassification(v)
              setPage(0)
            }}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any classification</SelectItem>
              <SelectItem value="unclassified">Unclassified</SelectItem>
              <SelectItem value="deliver_media">deliver.media</SelectItem>
              <SelectItem value="swiss_media_partners">SwissMediaPartners</SelectItem>
              <SelectItem value="private">Private</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="Search merchant / reference…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(0)
            }}
            className="w-72"
          />

          <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" className="ml-auto" disabled={total === 0}>
                <Users className="size-4" /> Assign all {total} results…
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Classify {total} card expense(s)</DialogTitle>
                <DialogDescription>
                  Applies to every <strong>card</strong> expense matching the current
                  filter{search ? <> (search: “{search}”)</> : null} — across all
                  pages, not just this one. Setting them to Private skips them in
                  review.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2 pt-2">
                {(
                  [
                    ['swiss_media_partners', 'SwissMediaPartners', 'bg-smp', 's'],
                    ['deliver_media', 'deliver.media', 'bg-deliver', 'd'],
                    ['private', 'Private', 'bg-muted-foreground', 'f'],
                  ] as const
                ).map(([value, label, dot, hotkey]) => (
                  <Button
                    key={value}
                    variant="outline"
                    className="justify-start"
                    disabled={bulkAssign.isPending}
                    onClick={() => bulkAssign.mutate(value)}
                  >
                    {bulkAssign.isPending && bulkAssign.variables === value ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <span className={cn('size-2.5 rounded-full', dot)} />
                    )}
                    {label}
                    <kbd className="ml-auto rounded bg-black/20 px-1.5 text-xs">
                      {hotkey}
                    </kbd>
                  </Button>
                ))}
              </div>
            </DialogContent>
          </Dialog>
        </div>

        <Card>
          <CardContent className="px-0">
            <div className="overflow-x-auto">
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
                    <TableHead>Account</TableHead>
                    <TableHead
                      className="cursor-pointer select-none"
                      onClick={() => toggleSort('merchant')}
                    >
                      <span className="inline-flex items-center gap-1">
                        Merchant / description{' '}
                        {sortIcon('merchant', sortBy, sortDir)}
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
                    <TableHead className="text-right">Original</TableHead>
                    <TableHead>Class</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((t) => (
                    <TableRow
                      key={t.id}
                      className="cursor-pointer"
                      onClick={() => setDetailId(t.id)}
                    >
                      <TableCell className="text-xs tabular-nums">{t.txDate}</TableCell>
                      <TableCell className="text-xs">
                        {accById.get(t.accountId)?.label ?? '—'}
                      </TableCell>
                      <TableCell className="max-w-[340px]">
                        <div className="truncate">
                          {t.merchant ?? t.counterparty ?? t.description ?? '—'}
                        </div>
                        {t.description &&
                          t.description !== (t.merchant ?? t.counterparty) && (
                            <div className="truncate text-xs text-muted-foreground">
                              {t.description}
                            </div>
                          )}
                        {(t.note || t.merchantNote) && (
                          <div className="mt-0.5 flex items-start gap-1 text-xs text-amber-500/90">
                            <StickyNote className="mt-0.5 size-3 shrink-0" />
                            <span className="truncate">
                              {t.note ?? t.merchantNote}
                            </span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Amount minor={t.amount} currency={t.currency} />
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {t.originalCurrency ? (
                          <Amount minor={t.originalAmount} currency={t.originalCurrency} />
                        ) : (
                          ''
                        )}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {t.ledger === 'card' ? (
                          <Select
                            value={
                              t.classification === 'unclassified'
                                ? ''
                                : t.classification
                            }
                            onValueChange={(v) =>
                              classify.mutate({ id: t.id, classification: v })
                            }
                          >
                            <SelectTrigger className="h-7 w-40 text-xs">
                              <SelectValue placeholder="Unclassified" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="deliver_media">
                                deliver.media
                              </SelectItem>
                              <SelectItem value="swiss_media_partners">
                                SwissMediaPartners
                              </SelectItem>
                              <SelectItem value="private">Private</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Pill>{t.ledger}</Pill>
                        )}
                      </TableCell>
                      <TableCell>
                        {t.ledger === 'card' ? (
                          <ReconBadge value={t.reconStatus} />
                        ) : (
                          ''
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                        No transactions. Import a statement first.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 text-sm">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span className="text-muted-foreground tabular-nums">
              {page + 1} / {pages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>

      <TransactionDetailDialog
        id={detailId}
        open={!!detailId}
        onOpenChange={(o) => !o && setDetailId(null)}
      />
    </div>
  )
}
