import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, FileText, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { listBatches, revertImport } from '#/server/imports.ts'
import { PageHeader } from '#/components/layout/AppShell.tsx'
import { Button } from '#/components/ui/button.tsx'
import { Card, CardContent } from '#/components/ui/card.tsx'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table.tsx'
import { Pill } from '#/components/shared/bits.tsx'

const batchesQuery = { queryKey: ['batches'], queryFn: () => listBatches() }

export const Route = createFileRoute('/import/')({
  component: ImportList,
  loader: ({ context }) => context.queryClient.ensureQueryData(batchesQuery),
})

function ImportList() {
  const qc = useQueryClient()
  const router = useRouter()
  const { data: batches } = useQuery(batchesQuery)

  const revert = useMutation({
    mutationFn: (id: string) => revertImport({ data: id }),
    onSuccess: (res) => {
      toast.success(
        `Reverted: removed ${res.removed} rows` +
          (res.blockedByMatches
            ? `, kept ${res.blockedByMatches} that are matched`
            : ''),
      )
      qc.invalidateQueries({ queryKey: ['batches'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      router.invalidate()
    },
  })

  return (
    <div>
      <PageHeader
        title="Imports"
        description="Upload statements from cards, bank, and accounting."
        actions={
          <Button asChild>
            <Link to="/import/new">
              <Plus className="size-4" /> New import
            </Link>
          </Button>
        }
      />
      <div className="px-8 py-6">
        <Card>
          <CardContent className="px-0 py-0">
            {!batches || batches.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <FileText className="size-8 text-muted-foreground" />
                <div className="text-sm text-muted-foreground">
                  No imports yet. Start by uploading a statement.
                </div>
                <Button asChild variant="outline">
                  <Link to="/import/new">
                    <Plus className="size-4" /> New import
                  </Link>
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Ledger</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="text-right">New</TableHead>
                    <TableHead className="text-right">Dupes</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batches.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="max-w-[260px] truncate font-medium">
                        {b.fileName}
                      </TableCell>
                      <TableCell>{b.accountLabel}</TableCell>
                      <TableCell>
                        <Pill>{b.ledger}</Pill>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {b.periodStart} → {b.periodEnd}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {b.rowCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-success">
                        {b.insertedCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {b.duplicateCount}
                      </TableCell>
                      <TableCell>
                        <Pill tone={b.status === 'reverted' ? 'muted' : 'success'}>
                          {b.status}
                        </Pill>
                      </TableCell>
                      <TableCell>
                        {b.status !== 'reverted' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => revert.mutate(b.id)}
                            disabled={revert.isPending}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
