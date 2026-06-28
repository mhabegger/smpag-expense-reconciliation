import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ListChecks } from 'lucide-react'
import { getTransaction } from '#/server/transactions.ts'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog.tsx'
import { Button } from '#/components/ui/button.tsx'
import { ReconBadge } from '#/components/shared/bits.tsx'
import { NotesEditor } from '#/components/shared/NotesEditor.tsx'
import { formatMoney } from '#/lib/money.ts'

function Field({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  if (value == null || value === '') return null
  return (
    <div className="flex justify-between gap-4 border-b border-border/60 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  )
}

function Detail({
  id,
  showReconcileLink,
}: {
  id: string
  showReconcileLink: boolean
}) {
  const { data } = useQuery({
    queryKey: ['transaction', id],
    queryFn: () => getTransaction({ data: id }),
  })
  if (!data)
    return <div className="py-8 text-sm text-muted-foreground">Loading…</div>
  const t = data.tx
  return (
    <div>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {t.merchant ?? t.counterparty ?? t.description ?? 'Transaction'}
          <ReconBadge value={t.reconStatus} />
        </DialogTitle>
        <DialogDescription>
          {data.account?.label} · {t.ledger}
        </DialogDescription>
      </DialogHeader>

      {showReconcileLink && t.ledger === 'card' && (
        <Button asChild variant="outline" size="sm" className="mt-2 w-fit">
          <Link to="/reconcile/$id" params={{ id: t.id }}>
            <ListChecks className="size-4" /> Open in Reconcile
          </Link>
        </Button>
      )}

      <div className="mt-2 max-h-[60vh] overflow-y-auto pr-1">
        <Field label="Transaction date" value={t.txDate} />
        <Field label="Booking date" value={t.bookingDate} />
        <Field label="Value date" value={t.valueDate} />
        <Field label="Direction" value={t.direction} />
        <Field label="Amount" value={formatMoney(t.amount, t.currency)} />
        <Field
          label="Original amount"
          value={
            t.originalCurrency
              ? formatMoney(t.originalAmount, t.originalCurrency)
              : null
          }
        />
        <Field label="FX rate" value={t.fxRate} />
        <Field
          label="CHF equivalent"
          value={t.chfEquiv != null ? formatMoney(t.chfEquiv, 'CHF') : null}
        />
        <Field label="Merchant" value={t.merchant} />
        <Field label="Normalized merchant" value={t.merchantNorm} />
        <Field label="Description" value={t.description} />
        <Field label="Counterparty" value={t.counterparty} />
        <Field label="Reference" value={t.reference} />
        <Field label="Category" value={t.category} />
        <Field label="Source status" value={t.statusText} />
        <Field label="Classification" value={t.classification} />
        <Field
          label="Reconciliation"
          value={`${t.reconStatus}${t.pending ? ' · pending' : ''}`}
        />
        <Field
          label="Accounting / Bank linked"
          value={`${t.accountingLinked ? 'yes' : 'no'} / ${t.bankLinked ? 'yes' : 'no'}`}
        />

        <div className="mt-4">
          <NotesEditor
            txId={t.id}
            merchantNorm={t.merchantNorm}
            transactionNote={t.note}
            merchantNote={data.merchantNote}
          />
        </div>

        <div className="mt-4">
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Raw imported row
          </div>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
            {data.rawJson}
          </pre>
        </div>
      </div>
    </div>
  )
}

export function TransactionDetailDialog({
  id,
  open,
  onOpenChange,
  showReconcileLink = true,
}: {
  id: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  showReconcileLink?: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {open && id && (
          <Detail id={id} showReconcileLink={showReconcileLink} />
        )}
      </DialogContent>
    </Dialog>
  )
}
