import { useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UploadCloud, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { commitImport, previewImport } from '#/server/imports.ts'
import { listAccounts } from '#/server/accounts.ts'
import { PageHeader } from '#/components/layout/AppShell.tsx'
import { Button } from '#/components/ui/button.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card.tsx'
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
import { Pill } from '#/components/shared/bits.tsx'
import { cn } from '#/lib/utils.ts'

export const Route = createFileRoute('/import/new')({ component: NewImport })

type Preview = Awaited<ReturnType<typeof previewImport>>

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(',')[1] ?? '')
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function NewImport() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [base64, setBase64] = useState<string>('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [accountId, setAccountId] = useState<string>('')
  const [dragOver, setDragOver] = useState(false)

  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => listAccounts(),
  })

  const doPreview = useMutation({
    mutationFn: async (f: File) => {
      const b64 = await fileToBase64(f)
      setBase64(b64)
      return previewImport({ data: { fileName: f.name, base64: b64 } })
    },
    onSuccess: (res) => {
      setPreview(res)
      // preselect account by detected institute
      if (res.meta.institute && accounts) {
        const acc = accounts.find((a) => a.institute === res.meta.institute)
        if (acc) setAccountId(acc.id)
      }
      if (res.alreadyImported) toast.warning('This exact file was already imported.')
    },
    onError: (e) => toast.error(`Preview failed: ${String(e)}`),
  })

  const doCommit = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('no file')
      return commitImport({
        data: {
          fileName: file.name,
          base64,
          accountId,
          presetKey: preview?.meta.presetKey ?? undefined,
        },
      })
    },
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error ?? 'Import failed')
        return
      }
      toast.success(
        `Imported ${res.inserted} rows` +
          (res.duplicates ? ` (${res.duplicates} duplicates skipped)` : ''),
      )
      qc.invalidateQueries({ queryKey: ['batches'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      navigate({ to: '/import' })
    },
    onError: (e) => toast.error(`Import failed: ${String(e)}`),
  })

  const onPick = async (f: File) => {
    setFile(f)
    setPreview(null)
    doPreview.mutate(f)
  }

  const meta = preview?.meta
  const stats = preview?.stats
  const canCommit =
    !!preview && !preview.needsMapping && !!accountId && (stats?.rowCount ?? 0) > 0

  return (
    <div>
      <PageHeader
        title="New import"
        description="CSV, Excel, ISO-20022 camt.053, or SWIFT MT942 — auto-detected."
      />
      <div className="max-w-4xl space-y-6 px-8 py-6">
        {/* Step 1: file */}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const f = e.dataTransfer.files?.[0]
            if (f) onPick(f)
          }}
          className={cn(
            'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border py-12 text-center transition-colors hover:border-primary/50',
            dragOver && 'border-primary bg-accent',
          )}
        >
          <UploadCloud className="size-8 text-muted-foreground" />
          <div className="text-sm font-medium">
            {file ? file.name : 'Drop a statement here or click to browse'}
          </div>
          <div className="text-xs text-muted-foreground">
            .csv · .xls · .xlsx · .xml · .txt
          </div>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept=".csv,.txt,.xls,.xlsx,.xml,.sta"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onPick(f)
            }}
          />
        </button>

        {doPreview.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Analyzing file…
          </div>
        )}

        {/* Step 2: detection + account */}
        {meta && stats && (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Detected format</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2 text-xs">
                  <Pill>kind: {meta.kind}</Pill>
                  {meta.encoding && <Pill>encoding: {meta.encoding}</Pill>}
                  {meta.delimiter && (
                    <Pill>delimiter: {JSON.stringify(meta.delimiter)}</Pill>
                  )}
                  {meta.presetLabel ? (
                    <Pill tone="success">preset: {meta.presetLabel}</Pill>
                  ) : (
                    <Pill tone="warning">no preset — manual mapping</Pill>
                  )}
                  {meta.ledger && <Pill>ledger: {meta.ledger}</Pill>}
                </div>
                <div className="flex flex-wrap gap-4 text-sm">
                  <span>
                    <span className="text-muted-foreground">Rows: </span>
                    <span className="font-medium tabular-nums">{stats.rowCount}</span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">Errors: </span>
                    <span
                      className={cn(
                        'font-medium tabular-nums',
                        stats.errorCount > 0 && 'text-warning',
                      )}
                    >
                      {stats.errorCount}
                    </span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">FX rows: </span>
                    <span className="font-medium tabular-nums">{stats.fxRows}</span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">Period: </span>
                    <span className="font-medium tabular-nums">
                      {stats.period.start} → {stats.period.end}
                    </span>
                  </span>
                </div>
                {meta.warnings.length > 0 && (
                  <div className="flex items-start gap-2 rounded-md bg-warning/10 p-2 text-xs text-warning">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <div>{meta.warnings.join(' · ')}</div>
                  </div>
                )}
                {preview?.alreadyImported && (
                  <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                    <AlertTriangle className="size-3.5" /> This exact file was already
                    imported — committing again will be rejected.
                  </div>
                )}

                <div className="flex items-center gap-3 pt-1">
                  <span className="text-sm text-muted-foreground">Import into</span>
                  <Select value={accountId} onValueChange={setAccountId}>
                    <SelectTrigger className="w-72">
                      <SelectValue placeholder="Choose account…" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts?.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.label} · {a.kind}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {preview?.needsMapping && (
                  <div className="rounded-md bg-warning/10 p-3 text-xs text-warning">
                    This format isn't recognised automatically. Manual column mapping
                    isn't wired into this build yet — add a preset for it, or use a
                    supported export.
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Step 3: preview rows */}
            {preview && preview.sampleRows.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    Preview (first {preview.sampleRows.length} rows)
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Dir</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead className="text-right">Original</TableHead>
                          <TableHead>Merchant / description</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.sampleRows.map((r, i) => (
                          <TableRow key={i}>
                            <TableCell className="tabular-nums text-xs">
                              {r.txDate}
                            </TableCell>
                            <TableCell>
                              <Pill
                                tone={r.direction === 'credit' ? 'success' : 'muted'}
                              >
                                {r.direction}
                              </Pill>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {r.amountDisplay}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {r.originalDisplay ?? ''}
                            </TableCell>
                            <TableCell className="max-w-[320px] truncate">
                              {r.merchant ?? r.description ?? ''}
                              {r.errors.length > 0 && (
                                <span className="ml-2 text-xs text-destructive">
                                  ({r.errors.join(', ')})
                                </span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="flex justify-end gap-2">
              <Button
                onClick={() => doCommit.mutate()}
                disabled={!canCommit || doCommit.isPending}
              >
                {doCommit.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-4" />
                )}
                Commit import
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
