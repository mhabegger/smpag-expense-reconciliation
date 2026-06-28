import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { listAccounts, listCompanies } from '#/server/accounts.ts'
import { listMappings } from '#/server/mappings.ts'
import { runMatching } from '#/server/matching.ts'
import { PageHeader } from '#/components/layout/AppShell.tsx'
import { Button } from '#/components/ui/button.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card.tsx'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table.tsx'
import { Pill } from '#/components/shared/bits.tsx'

const accountsQuery = { queryKey: ['accounts'], queryFn: () => listAccounts() }
const companiesQuery = { queryKey: ['companies'], queryFn: () => listCompanies() }
const mappingsQuery = { queryKey: ['mappings'], queryFn: () => listMappings() }

export const Route = createFileRoute('/settings/')({
  component: Settings,
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(accountsQuery),
      context.queryClient.ensureQueryData(companiesQuery),
      context.queryClient.ensureQueryData(mappingsQuery),
    ])
  },
})

function Settings() {
  const qc = useQueryClient()
  const { data: accounts } = useQuery(accountsQuery)
  const { data: companies } = useQuery(companiesQuery)
  const { data: mappings } = useQuery(mappingsQuery)

  const match = useMutation({
    mutationFn: () => runMatching({ data: {} }),
    onSuccess: (res) => {
      toast.success(
        `Matched ${res.anchors} expenses · ${res.candidatesCreated} candidates`,
      )
      qc.invalidateQueries({ queryKey: ['reconQueue'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Accounts, companies, and import presets."
        actions={
          <Button onClick={() => match.mutate()} disabled={match.isPending}>
            {match.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            Run full matching
          </Button>
        }
      />
      <div className="grid gap-6 px-8 py-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Accounts</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Institute</TableHead>
                  <TableHead>Company</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts?.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.label}</TableCell>
                    <TableCell>
                      <Pill>{a.kind}</Pill>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {a.institute}
                    </TableCell>
                    <TableCell className="text-xs">
                      {a.company?.name ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Companies</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {companies?.map((c) => (
                  <li key={c.id} className="flex items-center justify-between">
                    <span>{c.name}</span>
                    <Pill>{c.slug}</Pill>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Import presets</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {mappings?.map((m) => (
                  <Pill key={m.key} tone={m.builtin ? 'success' : 'muted'}>
                    {m.label}
                  </Pill>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
