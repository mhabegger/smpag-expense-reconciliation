import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { setMerchantNote, setTransactionNote } from '#/server/notes.ts'
import { Textarea } from '#/components/ui/textarea.tsx'
import { Button } from '#/components/ui/button.tsx'

export function NotesEditor({
  txId,
  merchantNorm,
  transactionNote,
  merchantNote,
}: {
  txId: string
  merchantNorm: string | null
  transactionNote: string | null
  merchantNote: string | null
}) {
  const qc = useQueryClient()
  const [txNote, setTxNote] = useState(transactionNote ?? '')
  const [mNote, setMNote] = useState(merchantNote ?? '')

  useEffect(() => setTxNote(transactionNote ?? ''), [txId, transactionNote])
  useEffect(() => setMNote(merchantNote ?? ''), [merchantNorm, merchantNote])

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['transaction'] })
    qc.invalidateQueries({ queryKey: ['reconcileItem'] })
  }

  const saveTx = useMutation({
    mutationFn: () => setTransactionNote({ data: { id: txId, note: txNote } }),
    onSuccess: () => {
      invalidate()
      toast.success('Note saved')
    },
  })
  const saveMerchant = useMutation({
    mutationFn: () =>
      setMerchantNote({ data: { merchantNorm: merchantNorm!, note: mNote } }),
    onSuccess: () => {
      invalidate()
      toast.success('Merchant note saved')
    },
  })

  const onKey = (
    e: React.KeyboardEvent,
    save: () => void,
    dirty: boolean,
  ) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      if (dirty) save()
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs font-medium text-muted-foreground">
          Note on this booking
        </label>
        <Textarea
          value={txNote}
          onChange={(e) => setTxNote(e.target.value)}
          onKeyDown={(e) =>
            onKey(e, () => saveTx.mutate(), txNote !== (transactionNote ?? ''))
          }
          rows={2}
          placeholder="e.g. client dinner with X"
          className="mt-1"
        />
        <div className="mt-1 flex items-center justify-end gap-2">
          <span className="text-[10px] text-muted-foreground">Ctrl+S</span>
          <Button
            size="sm"
            variant="outline"
            disabled={saveTx.isPending || txNote === (transactionNote ?? '')}
            onClick={() => saveTx.mutate()}
          >
            Save note
          </Button>
        </div>
      </div>

      {merchantNorm && (
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Note for all “{merchantNorm}” bookings
          </label>
          <Textarea
            value={mNote}
            onChange={(e) => setMNote(e.target.value)}
            onKeyDown={(e) =>
              onKey(e, () => saveMerchant.mutate(), mNote !== (merchantNote ?? ''))
            }
            rows={2}
            placeholder="e.g. local grocery store — always private"
            className="mt-1"
          />
          <div className="mt-1 flex items-center justify-end gap-2">
            <span className="text-[10px] text-muted-foreground">Ctrl+S</span>
            <Button
              size="sm"
              variant="outline"
              disabled={saveMerchant.isPending || mNote === (merchantNote ?? '')}
              onClick={() => saveMerchant.mutate()}
            >
              Save merchant note
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
