import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  X,
  ChevronLeft,
  ChevronRight,
  Ban,
  RotateCcw,
  Sparkles,
  Loader2,
  Clock,
  Lightbulb,
  StickyNote,
  Info,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  confirmCandidate,
  getReconQueue,
  getReconcileItem,
  markNoMatch,
  markPending,
  rejectCandidate,
  restoreCandidate,
  revokeGroup,
  runMatching,
} from '#/server/matching.ts'
import { classifyTransaction, setClassification } from '#/server/transactions.ts'
import { pushUndo } from '#/lib/undo.ts'
import { PageHeader } from '#/components/layout/AppShell.tsx'
import { Button } from '#/components/ui/button.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card.tsx'
import { Progress } from '#/components/ui/progress.tsx'
import {
  ClassificationBadge,
  Pill,
  ReconBadge,
  ScoreBadge,
} from '#/components/shared/bits.tsx'
import { formatMoney } from '#/lib/money.ts'
import { cn } from '#/lib/utils.ts'
import { NotesEditor } from '#/components/shared/NotesEditor.tsx'
import { TransactionDetailDialog } from '#/components/shared/TransactionDetailDialog.tsx'

const itemQuery = (id: string) => ({
  queryKey: ['reconcileItem', id],
  queryFn: () => getReconcileItem({ data: id }),
})
const fullQueueQuery = {
  queryKey: ['reconQueue', { status: 'all' }],
  queryFn: () => getReconQueue({ data: { status: 'all' as const } }),
}

export const Route = createFileRoute('/reconcile/$id')({
  component: Reconcile,
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(itemQuery(params.id)),
      context.queryClient.ensureQueryData(fullQueueQuery),
    ])
  },
})

type Item = NonNullable<Awaited<ReturnType<typeof getReconcileItem>>>
type Candidate = Item['accountingCandidates'][number]

function Reconcile() {
  const { id } = Route.useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [focus, setFocus] = useState(0)
  const [infoOpen, setInfoOpen] = useState(false)

  const { data: item, isLoading } = useQuery(itemQuery(id))
  const { data: queue } = useQuery(fullQueueQuery)

  const order = queue?.items ?? []
  const index = order.findIndex((i) => i.id === id)
  // an item still needs review unless it's private or fully reconciled
  const needsReview = (it: (typeof order)[number]) =>
    it.classification !== 'private' && it.reconStatus !== 'matched'
  const findNext = (from: number) => {
    for (let i = from; i < order.length; i++)
      if (needsReview(order[i])) return order[i].id
    return undefined
  }
  const findPrev = (from: number) => {
    for (let i = from; i >= 0; i--)
      if (needsReview(order[i])) return order[i].id
    return undefined
  }
  const nextId =
    index >= 0 ? findNext(index + 1) : order.find(needsReview)?.id
  const prevId = index >= 0 ? findPrev(index - 1) : undefined
  const reviewed = order.filter((i) => !needsReview(i)).length

  const invalidate = () => {
    // prefix-invalidate all items: confirming a grouped reimbursement
    // updates sibling anchors, not just the current one
    qc.invalidateQueries({ queryKey: ['reconcileItem'] })
    qc.invalidateQueries({ queryKey: ['reconQueue'] })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
    qc.invalidateQueries({ queryKey: ['transactions'] })
    qc.invalidateQueries({ queryKey: ['transaction'] })
  }

  const goNext = () =>
    nextId && navigate({ to: '/reconcile/$id', params: { id: nextId } })
  const goPrev = () =>
    prevId && navigate({ to: '/reconcile/$id', params: { id: prevId } })

  const classify = useMutation({
    mutationFn: async (classification: string) => {
      await classifyTransaction({ data: { id, classification } as never })
      if (classification !== 'private')
        await runMatching({ data: { anchorTxId: id } })
    },
    onMutate: () => ({ prev: item?.tx.classification ?? 'unclassified' }),
    onSuccess: (_d, classification, ctx) => {
      invalidate()
      pushUndo({
        label: 'classification',
        run: () =>
          setClassification({ data: { id, classification: ctx!.prev } }),
      })
      if (classification === 'private') setTimeout(goNext, 150)
    },
  })

  const rematch = useMutation({
    mutationFn: () => runMatching({ data: { anchorTxId: id } }),
    onSuccess: () => {
      invalidate()
      toast.success('Re-matched')
    },
  })

  const confirm = useMutation({
    mutationFn: (candidateId: string) => confirmCandidate({ data: candidateId }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error ?? 'Could not confirm')
        return
      }
      if (res.affected.length > 1)
        toast.success(`Reconciled ${res.affected.length} expenses (grouped)`)
      else toast.success('Match confirmed')
      if (res.groupIds?.length)
        pushUndo({
          label: 'match',
          run: () =>
            Promise.all(res.groupIds.map((g) => revokeGroup({ data: g }))),
        })
      invalidate()
    },
  })
  const reject = useMutation({
    mutationFn: (candidateId: string) => rejectCandidate({ data: candidateId }),
    onSuccess: (_d, candidateId) => {
      pushUndo({
        label: 'reject',
        run: () => restoreCandidate({ data: candidateId }),
      })
      invalidate()
    },
  })
  const revoke = useMutation({
    mutationFn: (groupId: string) => revokeGroup({ data: groupId }),
    onSuccess: invalidate,
  })
  const noMatch = useMutation({
    mutationFn: (v: { leg: 'accounting' | 'reimbursement'; value: boolean }) =>
      markNoMatch({ data: { anchorTxId: id, leg: v.leg, value: v.value } }),
    onMutate: (v) => ({
      prev:
        v.leg === 'accounting'
          ? (item?.tx.noAccountingMatch ?? false)
          : (item?.tx.noBankMatch ?? false),
    }),
    onSuccess: (_d, v, ctx) => {
      pushUndo({
        label: 'no-match',
        run: () =>
          markNoMatch({
            data: { anchorTxId: id, leg: v.leg, value: ctx!.prev },
          }),
      })
      invalidate()
    },
  })
  const pending = useMutation({
    mutationFn: (value: boolean) => markPending({ data: { anchorTxId: id, value } }),
    onMutate: () => ({ prev: item?.tx.pending ?? false }),
    onSuccess: (_d, value, ctx) => {
      invalidate()
      pushUndo({
        label: 'pending flag',
        run: () => markPending({ data: { anchorTxId: id, value: ctx!.prev } }),
      })
      if (value) {
        toast.success('Flagged for later — will be re-checked after new imports')
        setTimeout(goNext, 150)
      }
    },
  })

  const allCands = useMemo(
    () => [
      ...(item?.accountingCandidates ?? []),
      ...(item?.bankCandidates ?? []),
    ],
    [item],
  )

  useEffect(() => setFocus(0), [id])

  // keep the focused index valid when candidates are removed (e.g. after `x`)
  useEffect(() => {
    setFocus((f) => Math.max(0, Math.min(f, allCands.length - 1)))
  }, [allCands.length])

  // keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        tag === 'BUTTON' ||
        el?.isContentEditable ||
        el?.closest('[role="dialog"]')
      )
        return
      if (infoOpen) return
      // ignore shortcuts while a mutation is in flight — a second Enter/x
      // would double-submit against stale candidate indices
      if (classify.isPending || confirm.isPending || reject.isPending || pending.isPending)
        return
      const k = e.key.toLowerCase()
      if (k === 'd') classify.mutate('deliver_media')
      else if (k === 's') classify.mutate('swiss_media_partners')
      else if (k === 'f') classify.mutate('private')
      else if (k === 'n' || e.key === 'ArrowRight') goNext()
      else if (k === 'p' || e.key === 'ArrowLeft') goPrev()
      else if (k === 'l') pending.mutate(true)
      else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocus((f) => Math.min(f + 1, Math.max(allCands.length - 1, 0)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocus((f) => Math.max(f - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const c = allCands[focus]
        if (c) confirm.mutate(c.id)
      } else if (k === 'x') {
        const c = allCands[focus]
        if (c) reject.mutate(c.id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allCands,
    focus,
    id,
    nextId,
    prevId,
    infoOpen,
    classify.isPending,
    confirm.isPending,
    reject.isPending,
    pending.isPending,
  ])

  if (isLoading) {
    return (
      <div className="px-8 py-10 text-sm text-muted-foreground">Loading…</div>
    )
  }
  if (!item) {
    return <div className="px-8 py-10 text-sm">Expense not found.</div>
  }

  const tx = item.tx
  const isPrivate = tx.classification === 'private'
  const isCompany =
    tx.classification === 'deliver_media' ||
    tx.classification === 'swiss_media_partners'
  const acctGroup = item.groups.find((g) => g.matchType === 'accounting')
  const bankGroup = item.groups.find((g) => g.matchType === 'reimbursement')
  const suggestionFor =
    tx.classification === 'unclassified'
      ? item.suggestion?.classification
      : undefined

  return (
    <div>
      <PageHeader
        title="Review expense"
        description={`${index + 1} of ${order.length} · ${reviewed} reviewed`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={goPrev} disabled={!prevId}>
              <ChevronLeft className="size-4" /> Prev
            </Button>
            <Button variant="outline" size="sm" onClick={goNext} disabled={!nextId}>
              Next <ChevronRight className="size-4" />
            </Button>
          </div>
        }
      />
      <div className="px-8 pt-3">
        <Progress value={(reviewed / Math.max(order.length, 1)) * 100} className="h-1.5" />
      </div>

      <div className="grid gap-6 px-8 py-6 lg:grid-cols-[360px_1fr]">
        {/* Left: expense + classify */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between gap-2 text-base">
                <span className="flex items-center gap-1.5">
                  Card expense
                  <button
                    type="button"
                    onClick={() => setInfoOpen(true)}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    title="All details"
                  >
                    <Info className="size-4" />
                  </button>
                </span>
                <span className="flex items-center gap-1.5">
                  {tx.pending && <Pill tone="warning">Pending</Pill>}
                  <ReconBadge value={tx.reconStatus} />
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-lg font-semibold">
                {tx.merchant ?? tx.description ?? '—'}
              </div>
              {tx.description && tx.description !== tx.merchant && (
                <div className="text-sm text-muted-foreground">
                  {tx.description}
                </div>
              )}
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums">
                  {formatMoney(tx.amount, tx.currency)}
                </span>
                {tx.originalCurrency && (
                  <span className="text-sm text-muted-foreground">
                    orig {formatMoney(tx.originalAmount, tx.originalCurrency)}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
                <span>Date</span>
                <span className="text-right tabular-nums text-foreground">
                  {tx.txDate}
                </span>
                <span>Account</span>
                <span className="text-right text-foreground">
                  {item.account?.label}
                </span>
                {tx.reference && (
                  <>
                    <span>Reference</span>
                    <span className="truncate text-right text-foreground">
                      {tx.reference}
                    </span>
                  </>
                )}
                {tx.category && (
                  <>
                    <span>Category</span>
                    <span className="text-right text-foreground">
                      {tx.category}
                    </span>
                  </>
                )}
                {tx.merchantNorm && (
                  <>
                    <span>Normalized</span>
                    <span className="text-right text-foreground">
                      {tx.merchantNorm}
                    </span>
                  </>
                )}
              </div>
              {(item.merchantNote || tx.note) && (
                <div className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">
                  {item.merchantNote && (
                    <div className="flex gap-1.5">
                      <StickyNote className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                      <span>
                        <span className="font-medium">Merchant: </span>
                        {item.merchantNote}
                      </span>
                    </div>
                  )}
                  {tx.note && (
                    <div className="flex gap-1.5">
                      <StickyNote className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                      <span>
                        <span className="font-medium">This booking: </span>
                        {tx.note}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Classify</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <ClassifyButton
                value="swiss_media_partners"
                label="SwissMediaPartners"
                hotkey="s"
                active={tx.classification === 'swiss_media_partners'}
                suggested={suggestionFor === 'swiss_media_partners'}
                onClick={() => classify.mutate('swiss_media_partners')}
              />
              <ClassifyButton
                value="deliver_media"
                label="deliver.media"
                hotkey="d"
                active={tx.classification === 'deliver_media'}
                suggested={suggestionFor === 'deliver_media'}
                onClick={() => classify.mutate('deliver_media')}
              />
              <ClassifyButton
                value="private"
                label="Private"
                hotkey="f"
                active={tx.classification === 'private'}
                suggested={suggestionFor === 'private'}
                onClick={() => classify.mutate('private')}
              />
              {suggestionFor && tx.classification === 'unclassified' && (
                <p className="text-xs text-muted-foreground">
                  Suggested from {item.suggestion?.count} earlier booking
                  {(item.suggestion?.count ?? 0) > 1 ? 's' : ''} of this merchant.
                </p>
              )}
              <div className="pt-1">
                <ClassificationBadge value={tx.classification} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <StickyNote className="size-4" /> Notes
              </CardTitle>
            </CardHeader>
            <CardContent>
              <NotesEditor
                txId={tx.id}
                merchantNorm={tx.merchantNorm}
                transactionNote={tx.note}
                merchantNote={item.merchantNote}
              />
            </CardContent>
          </Card>

          <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
            <div className="mb-1 font-medium text-foreground">Shortcuts</div>
            <span className="font-mono">s</span> SMP ·{' '}
            <span className="font-mono">d</span> deliver.media ·{' '}
            <span className="font-mono">f</span> private ·{' '}
            <span className="font-mono">↑/↓</span> select ·{' '}
            <span className="font-mono">Enter</span> accept ·{' '}
            <span className="font-mono">x</span> reject ·{' '}
            <span className="font-mono">l</span> flag pending ·{' '}
            <span className="font-mono">←/→</span> or{' '}
            <span className="font-mono">p/n</span> prev/next
          </div>
        </div>

        {/* Right: candidates */}
        <div className="space-y-6">
          {isPrivate ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                Private expense — no reconciliation needed.
              </CardContent>
            </Card>
          ) : !isCompany ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                Classify this expense to see matching accounting entries and
                reimbursements.
              </CardContent>
            </Card>
          ) : (
            <>
              <Leg
                title="Accounting — registered for payout?"
                leg="accounting"
                candidates={item.accountingCandidates}
                group={acctGroup}
                focusId={allCands[focus]?.id}
                anchorMarkNoMatch={tx.noAccountingMatch}
                onConfirm={(cid) => confirm.mutate(cid)}
                onReject={(cid) => reject.mutate(cid)}
                onRevoke={(gid) => revoke.mutate(gid)}
                onNoMatch={(v) => noMatch.mutate({ leg: 'accounting', value: v })}
              />
              <Leg
                title="Bank — money came back?"
                leg="reimbursement"
                candidates={item.bankCandidates}
                group={bankGroup}
                focusId={allCands[focus]?.id}
                anchorMarkNoMatch={tx.noBankMatch}
                onConfirm={(cid) => confirm.mutate(cid)}
                onReject={(cid) => reject.mutate(cid)}
                onRevoke={(gid) => revoke.mutate(gid)}
                onNoMatch={(v) => noMatch.mutate({ leg: 'reimbursement', value: v })}
              />
              <div className="flex items-center justify-between">
                {tx.pending ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => pending.mutate(false)}
                    disabled={pending.isPending}
                  >
                    <RotateCcw className="size-4" /> Clear pending flag
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => pending.mutate(true)}
                    disabled={pending.isPending}
                  >
                    <Clock className="size-4" /> Flag for later (l)
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => rematch.mutate()}
                  disabled={rematch.isPending}
                >
                  {rematch.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  Re-run matching for this expense
                </Button>
              </div>
            </>
          )}

          {item.related.length > 0 && <RelatedBookings related={item.related} />}
        </div>
      </div>

      <TransactionDetailDialog
        id={tx.id}
        open={infoOpen}
        onOpenChange={setInfoOpen}
        showReconcileLink={false}
      />
    </div>
  )
}

const CLASSIFY_TONE: Record<
  string,
  { dot: string; active: string; suggested: string }
> = {
  swiss_media_partners: {
    dot: 'bg-smp',
    active: 'border-2 border-smp bg-smp/15',
    suggested: 'border border-dashed border-smp/70 bg-smp/5',
  },
  deliver_media: {
    dot: 'bg-deliver',
    active: 'border-2 border-deliver bg-deliver/20',
    suggested: 'border border-dashed border-deliver/70 bg-deliver/10',
  },
  private: {
    dot: 'bg-muted-foreground',
    active: 'border-2 border-foreground/50 bg-accent',
    suggested: 'border border-dashed border-foreground/30 bg-accent/40',
  },
}

function ClassifyButton({
  value,
  label,
  hotkey,
  active,
  suggested,
  onClick,
}: {
  value: string
  label: string
  hotkey: string
  active: boolean
  suggested?: boolean
  onClick: () => void
}) {
  const tone = CLASSIFY_TONE[value]
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between rounded-md px-3 py-2 text-sm transition-colors',
        active
          ? cn(tone.active, 'font-semibold')
          : suggested
            ? cn(tone.suggested, 'hover:bg-accent')
            : 'border border-border hover:bg-accent',
      )}
    >
      <span className="flex items-center gap-2">
        <span className={cn('size-2.5 shrink-0 rounded-full', tone.dot)} />
        {label}
        {active && <Check className="size-4" />}
        {suggested && !active && (
          <span className="flex items-center gap-1 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Lightbulb className="size-3" /> suggested
          </span>
        )}
      </span>
      <kbd className="rounded bg-black/20 px-1.5 text-xs">{hotkey}</kbd>
    </button>
  )
}

function Leg({
  title,
  leg,
  candidates,
  group,
  focusId,
  anchorMarkNoMatch,
  onConfirm,
  onReject,
  onRevoke,
  onNoMatch,
}: {
  title: string
  leg: 'accounting' | 'reimbursement'
  candidates: Candidate[]
  group: Item['groups'][number] | undefined
  focusId: string | undefined
  anchorMarkNoMatch: boolean
  onConfirm: (id: string) => void
  onReject: (id: string) => void
  onRevoke: (id: string) => void
  onNoMatch: (value: boolean) => void
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          {title}
          {group ? <Pill tone="success">linked</Pill> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {group ? (
          <div className="rounded-md border border-success/30 bg-success/10 p-3">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="font-medium text-success">Confirmed match</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRevoke(group.id)}
              >
                <RotateCcw className="size-3.5" /> Undo
              </Button>
            </div>
            {group.members.map((m) => (
              <div key={m.id} className="flex justify-between text-sm">
                <span className="truncate">
                  {m.tx?.merchant ?? m.tx?.counterparty ?? m.tx?.description ?? m.txId}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {m.tx ? formatMoney(m.tx.amount, m.tx.currency) : ''}
                </span>
              </div>
            ))}
          </div>
        ) : anchorMarkNoMatch ? (
          <div className="flex items-center justify-between rounded-md border border-border p-3 text-sm text-muted-foreground">
            Marked as “no match exists”.
            <Button variant="ghost" size="sm" onClick={() => onNoMatch(false)}>
              <RotateCcw className="size-3.5" /> Undo
            </Button>
          </div>
        ) : candidates.length === 0 ? (
          <div className="flex items-center justify-between py-2 text-sm text-muted-foreground">
            No candidates found.
            <Button variant="outline" size="sm" onClick={() => onNoMatch(true)}>
              <Ban className="size-3.5" /> Mark no match
            </Button>
          </div>
        ) : (
          <>
            {candidates.map((c) => (
              <CandidateRow
                key={c.id}
                c={c}
                leg={leg}
                focused={c.id === focusId}
                onConfirm={() => onConfirm(c.id)}
                onReject={() => onReject(c.id)}
              />
            ))}
            <div className="pt-1">
              <Button variant="ghost" size="sm" onClick={() => onNoMatch(true)}>
                <Ban className="size-3.5" /> None of these — mark no match
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function CandidateRow({
  c,
  leg,
  focused,
  onConfirm,
  onReject,
}: {
  c: Candidate
  leg: 'accounting' | 'reimbursement'
  focused: boolean
  onConfirm: () => void
  onReject: () => void
}) {
  const isGroup = c.groupMembers.length > 0
  const target = c.candidate
  const bd = c.scoreBreakdown
  return (
    <div
      className={cn(
        'rounded-md border p-3 transition-colors',
        focused ? 'border-primary ring-1 ring-primary' : 'border-border',
      )}
    >
      <div className="flex items-start gap-3">
        <ScoreBadge score={c.score} />
        <div className="min-w-0 flex-1">
          {isGroup ? (
            <div>
              <div className="text-sm font-medium">
                Group of {c.groupMembers.length} expenses → 1 credit
              </div>
              <div className="mt-1 space-y-0.5">
                {c.groupMembers.map((m) => (
                  <div key={m.id} className="flex justify-between text-xs text-muted-foreground">
                    <span className="truncate">
                      {m.merchant ?? m.description ?? m.txDate}
                    </span>
                    <span className="tabular-nums">
                      {formatMoney(m.amount, m.currency)}
                    </span>
                  </div>
                ))}
                <div className="flex justify-between border-t border-border pt-0.5 text-xs font-medium">
                  <span>Σ vs credit</span>
                  <span className="tabular-nums">
                    {formatMoney(c.convertedAmount, target?.currency ?? 'CHF')}
                    {target
                      ? ` / ${formatMoney(target.amount, target.currency)}`
                      : ''}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="truncate text-sm font-medium">
                  {target?.merchant ??
                    target?.counterparty ??
                    target?.description ??
                    '—'}
                </span>
                <span className="tabular-nums text-sm">
                  {target ? formatMoney(target.amount, target.currency) : ''}
                </span>
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {target?.txDate}
                {target?.statusText ? ` · ${target.statusText}` : ''}
              </div>
            </>
          )}
          <div className="mt-1.5 flex flex-wrap gap-1">
            <Pill>amt {bd.amount}</Pill>
            {leg === 'accounting' && bd.merchant != null && (
              <Pill>merch {bd.merchant}</Pill>
            )}
            {leg === 'reimbursement' && bd.merchant != null && (
              <Pill>text {bd.merchant}</Pill>
            )}
            <Pill>date {bd.date}</Pill>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <Button size="sm" onClick={onConfirm}>
            <Check className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onReject}>
            <X className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

type Related = Item['related'][number]

function relatedStatus(r: Related): { label: string; tone: 'success' | 'warning' | 'muted' | 'destructive' } {
  if (r.classification === 'private') return { label: 'Private', tone: 'muted' }
  if (r.reconStatus === 'matched') return { label: 'Reconciled', tone: 'success' }
  if (r.pending) return { label: 'Pending', tone: 'warning' }
  if (r.accountingLinked && !r.bankLinked)
    return { label: 'Not reimbursed', tone: 'warning' }
  if (r.bankLinked && !r.accountingLinked)
    return { label: 'Reimbursed only', tone: 'warning' }
  if (r.classification === 'unclassified')
    return { label: 'Unclassified', tone: 'muted' }
  return { label: 'Not paid out', tone: 'destructive' }
}

function RelatedBookings({ related }: { related: Related[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          Other bookings from this merchant
          <span className="text-sm font-normal text-muted-foreground">
            {related.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <ul className="divide-y divide-border">
          {related.map((r) => {
            const st = relatedStatus(r)
            return (
              <li
                key={r.id}
                className="flex items-center gap-3 px-6 py-2 text-sm"
              >
                <span className="w-20 shrink-0 text-xs tabular-nums text-muted-foreground">
                  {r.txDate}
                </span>
                <span className="w-28 shrink-0 text-right tabular-nums">
                  {formatMoney(r.amount, r.currency)}
                </span>
                <span className="flex-1 truncate text-muted-foreground">
                  {r.merchant ?? ''}
                </span>
                <ClassificationBadge value={r.classification} />
                <Pill tone={st.tone}>{st.label}</Pill>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
