import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowRight, Check, ExternalLink, Loader2, X } from 'lucide-react'
import {
  confirmProposal,
  dismissProposal,
  getProposals,
  undismissProposal,
  unconfirmProposal,
} from '#/server/proposals.ts'
import { pushUndo } from '#/lib/undo.ts'
import { classificationLabel } from '#/lib/format.ts'
import { formatMoney } from '#/lib/money.ts'
import { cn } from '#/lib/utils.ts'
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
import { COMPANY_DOT, Pill } from '#/components/shared/bits.tsx'

type Proposals = Awaited<ReturnType<typeof getProposals>>
type Proposal = Proposals[number]

const proposalsQuery = (year: number) => ({
  queryKey: ['proposals', { year }],
  queryFn: () => getProposals({ data: { year } }),
})

const COMPANY_CLASS = { smp: 'swiss_media_partners', dm: 'deliver_media' } as const

export const Route = createFileRoute('/suggestions/')({
  component: Suggestions,
  loader: ({ context }) => context.queryClient.ensureQueryData(proposalsQuery(2025)),
})

function Suggestions() {
  const qc = useQueryClient()
  const [year, setYear] = useState(2025)
  const { data, isFetching } = useQuery(proposalsQuery(year))
  const items = data ?? []

  const key = (p: Proposal) => `${p.doc.id}|${p.payment.id}`
  // drop the row at once; refetch once nothing is pending (as on Triage)
  const removeRow = async (p: Proposal) => {
    await qc.cancelQueries({ queryKey: ['proposals'] })
    qc.setQueriesData<Proposals>({ queryKey: ['proposals'] }, (d) =>
      d?.filter((x) => key(x) !== key(p)),
    )
  }
  const refresh = () => {
    if (qc.isMutating({ mutationKey: ['proposal'] }) > 1) return
    for (const k of ['proposals', 'triage', 'transactions', 'dashboard', 'reconQueue'])
      qc.invalidateQueries({ queryKey: [k] })
  }

  const confirm = useMutation({
    mutationKey: ['proposal'],
    mutationFn: (p: Proposal) =>
      confirmProposal({ data: { docId: p.doc.id, paymentId: p.payment.id } }),
    onMutate: removeRow,
    onSuccess: (res, p) => {
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      pushUndo({
        label: `link ${p.doc.title}`,
        run: () =>
          unconfirmProposal({
            data: {
              docId: p.doc.id,
              paymentId: p.payment.id,
              groupId: res.groupId,
              prevClassification: res.prevClassification,
            },
          }),
      })
      toast.success(`Linked: ${p.doc.title}`, { duration: 1500 })
    },
    onError: (e, p) => toast.error(`${p.doc.title}: ${(e as Error).message}`),
    onSettled: refresh,
  })

  const dismiss = useMutation({
    mutationKey: ['proposal'],
    mutationFn: (p: Proposal) =>
      dismissProposal({ data: { docId: p.doc.id, paymentId: p.payment.id } }),
    onMutate: removeRow,
    onSuccess: (_r, p) => {
      pushUndo({
        label: `reject ${p.doc.title}`,
        run: () => undismissProposal({ data: { docId: p.doc.id, paymentId: p.payment.id } }),
      })
      toast.success('Rejected, won’t be suggested again', { duration: 1500 })
    },
    onError: (e, p) => toast.error(`${p.doc.title}: ${(e as Error).message}`),
    onSettled: refresh,
  })

  return (
    <div>
      <PageHeader
        title="Suggestions"
        description="Probable links between an Accounto document and the card or bank payment behind it. Confirm the right ones; reject the rest."
      />
      <div className="space-y-4 px-8 py-6">
        <div className="flex items-center gap-2">
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[2025, 2026].map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto text-sm text-muted-foreground">
            {isFetching && <Loader2 className="mr-1 inline size-3.5 animate-spin" />}
            {items.length} to review · Ctrl+Z undoes
          </span>
        </div>

        <Card>
          <CardContent className="px-0">
            {items.map((p) => {
              const cls = COMPANY_CLASS[p.doc.company]
              return (
                <div
                  key={key(p)}
                  className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-4 border-b border-border px-5 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className={cn('size-2 rounded-full', COMPANY_DOT[cls])} />
                      {classificationLabel(cls)} · Accounto · {p.doc.date}
                    </div>
                    <div className="truncate font-medium">{p.doc.title || '(no title)'}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {p.doc.vendor && <>{p.doc.vendor} · </>}
                      <span className="tabular-nums">
                        {formatMoney(p.doc.amount, p.doc.currency)}
                      </span>
                      {p.payout && (
                        <>
                          {' '}
                          · paid out {p.payout.date} ({formatMoney(p.payout.chf, 'CHF')})
                        </>
                      )}
                    </div>
                  </div>
                  <ArrowRight className="size-4 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {p.payment.source} · {p.payment.date}
                      {p.payment.ledger === 'card' && (
                        <Link
                          to="/reconcile/$id"
                          params={{ id: p.payment.id }}
                          className="hover:text-foreground"
                          title="Open in review"
                        >
                          <ExternalLink className="size-3" />
                        </Link>
                      )}
                    </div>
                    <div className="truncate font-medium">{p.payment.merchant ?? '—'}</div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="tabular-nums">
                        {formatMoney(p.payment.chf, 'CHF')}
                        {p.payment.origCurrency &&
                          ` (${formatMoney(p.payment.origAmount, p.payment.origCurrency)})`}
                      </span>
                      <Pill tone="warning">{p.reason}</Pill>
                      {p.classificationConflict && (
                        <Pill tone="destructive">
                          currently {classificationLabel(p.classificationConflict)}, Confirm changes it
                        </Pill>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <Button size="sm" onClick={() => confirm.mutate(p)}>
                      <Check className="size-4" /> Confirm
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => dismiss.mutate(p)}>
                      <X className="size-4" /> Not this
                    </Button>
                  </div>
                </div>
              )
            })}
            {items.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                {isFetching ? 'Loading…' : 'Nothing to review.'}
              </div>
            )}
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground">
          Confirm links the document to the payment, classifies the payment for that company and moves an already-found payout to it. “Not this” only
          rejects this pairing; the document then shows up as having no payment.
        </p>
      </div>
    </div>
  )
}
