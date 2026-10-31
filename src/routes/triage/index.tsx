import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, ExternalLink, Loader2, StickyNote } from 'lucide-react'
import { getTriage } from '#/server/triage.ts'
import { bulkClassify, restoreClassifications } from '#/server/transactions.ts'
import { pushUndo } from '#/lib/undo.ts'
import { classificationLabel } from '#/lib/format.ts'
import { formatMoney } from '#/lib/money.ts'
import { cn } from '#/lib/utils.ts'
import { PageHeader } from '#/components/layout/AppShell.tsx'
import { Button } from '#/components/ui/button.tsx'
import { Card, CardContent } from '#/components/ui/card.tsx'
import { Input } from '#/components/ui/input.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog.tsx'
import { Amount, ClassificationBadge, COMPANY_DOT, Pill } from '#/components/shared/bits.tsx'

type Year = 'all' | `${number}`
type Size = 'all' | 'large' | 'small'
type Sort = 'total' | 'count' | 'merchant' | 'latest'
type Target = 'swiss_media_partners' | 'deliver_media' | 'private'

const triageQuery = (year: Year) => ({
  queryKey: ['triage', { year }],
  queryFn: () => getTriage({ data: { year } }),
})

type TriageData = Awaited<ReturnType<typeof getTriage>>

/** The triage data with some expenses removed (groups and summary recomputed). */
function withoutIds(d: TriageData, ids: Set<string>): TriageData {
  const groups = d.groups
    .map((g) => {
      if (!g.rows.some((r) => ids.has(r.id))) return g
      const rows = g.rows.filter((r) => !ids.has(r.id))
      const abs = rows.map((r) => Math.abs(r.amount))
      return {
        ...g,
        rows,
        count: rows.length,
        total: abs.reduce((s, a) => s + a, 0),
        small: abs.filter((a) => a < d.smallLimit).length,
      }
    })
    .filter((g) => g.count > 0)
  const rows = groups.flatMap((g) => g.rows)
  const abs = rows.map((r) => Math.abs(r.amount))
  const small = abs.filter((a) => a < d.smallLimit)
  const byAccount = new Map<string, { count: number; total: number }>()
  for (const r of rows) {
    const a = byAccount.get(r.account) ?? { count: 0, total: 0 }
    a.count++
    a.total += Math.abs(r.amount)
    byAccount.set(r.account, a)
  }
  return {
    ...d,
    groups,
    summary: {
      count: rows.length,
      total: abs.reduce((s, a) => s + a, 0),
      smallCount: small.length,
      smallTotal: small.reduce((s, a) => s + a, 0),
      byAccount: [...byAccount.entries()]
        .map(([label, v]) => ({ label, ...v }))
        .sort((a, b) => b.total - a.total),
    },
  }
}

const SHORT: Record<string, string> = {
  swiss_media_partners: 'SMP',
  deliver_media: 'DM',
  private: 'Private',
}

const TARGETS: { value: Target; label: string; key: string }[] = [
  { value: 'swiss_media_partners', label: 'SMP', key: 's' },
  { value: 'deliver_media', label: 'DM', key: 'd' },
  { value: 'private', label: 'Private', key: 'f' },
]

export const Route = createFileRoute('/triage/')({
  component: Triage,
  loader: ({ context }) => context.queryClient.ensureQueryData(triageQuery('2025')),
})

function Triage() {
  const qc = useQueryClient()
  const [year, setYear] = useState<Year>('2025')
  const [size, setSize] = useState<Size>('all')
  const [sort, setSort] = useState<Sort>('total')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [focus, setFocus] = useState(0)
  const [confirmSmall, setConfirmSmall] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const { data, isFetching } = useQuery(triageQuery(year))
  const limit = data?.smallLimit ?? 5000

  // filter rows by size, then drop groups left empty
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out = (data?.groups ?? [])
      .filter((g) => !q || g.key.includes(q) || g.merchant.toLowerCase().includes(q))
      .map((g) => {
        const rows = g.rows.filter((r) =>
          size === 'all'
            ? true
            : size === 'small'
              ? Math.abs(r.amount) < limit
              : Math.abs(r.amount) >= limit,
        )
        return { ...g, rows, count: rows.length, total: rows.reduce((s, r) => s + Math.abs(r.amount), 0) }
      })
      .filter((g) => g.count > 0)
    out.sort((a, b) =>
      sort === 'count'
        ? b.count - a.count || b.total - a.total
        : sort === 'merchant'
          ? a.merchant.localeCompare(b.merchant)
          : sort === 'latest'
            ? b.lastDate.localeCompare(a.lastDate)
            : b.total - a.total,
    )
    return out
  }, [data, search, size, sort, limit])

  const shown = {
    count: groups.reduce((s, g) => s + g.count, 0),
    total: groups.reduce((s, g) => s + g.total, 0),
  }
  const smallIds = groups.flatMap((g) =>
    g.rows.filter((r) => Math.abs(r.amount) < limit).map((r) => r.id),
  )

  // Optimistic: the expenses leave the list at once and the save runs in the
  // background, so the next merchant can be classified without waiting.
  // The list is refetched only after the last pending save has finished.
  const classify = useMutation({
    mutationKey: ['triageClassify'],
    mutationFn: (v: { ids: string[]; classification: Target; label: string }) =>
      bulkClassify({ data: { ids: v.ids, classification: v.classification } }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['triage'] })
      qc.setQueriesData<TriageData>({ queryKey: ['triage'] }, (d) =>
        d ? withoutIds(d, new Set(v.ids)) : d,
      )
      setConfirmSmall(false)
    },
    onSuccess: (_r, v) => {
      pushUndo({
        label: v.label,
        run: () =>
          restoreClassifications({
            data: { items: v.ids.map((id) => ({ id, classification: 'unclassified' as const })) },
          }),
      })
      toast.success(`${v.label} → ${classificationLabel(v.classification)}`, { duration: 1500 })
    },
    onError: (e, v) => toast.error(`${v.label}: classification failed (${(e as Error).message})`),
    onSettled: () => {
      if (qc.isMutating({ mutationKey: ['triageClassify'] }) > 1) return
      qc.invalidateQueries({ queryKey: ['triage'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      qc.invalidateQueries({ queryKey: ['reconQueue'] })
    },
  })

  const classifyGroup = (g: (typeof groups)[number], t: Target) =>
    classify.mutate({
      ids: g.rows.map((r) => r.id),
      classification: t,
      label: `${g.merchant} (${g.count})`,
    })

  // keep the focused group in range as groups disappear after classifying
  useEffect(() => {
    if (focus > groups.length - 1) setFocus(Math.max(0, groups.length - 1))
  }, [groups.length, focus])

  // j/k or arrows: move · s/d/f: classify the focused merchant · Enter/x: expand
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable)
        return
      if (e.ctrlKey || e.metaKey || e.altKey || confirmSmall) return
      const k = e.key.toLowerCase()
      const g = groups[focus]
      if (k === 'j' || k === 'arrowdown') {
        e.preventDefault()
        setFocus((f) => Math.min(f + 1, groups.length - 1))
      } else if (k === 'k' || k === 'arrowup') {
        e.preventDefault()
        setFocus((f) => Math.max(f - 1, 0))
      } else if ((k === 'enter' || k === 'x') && g) {
        e.preventDefault()
        toggle(g.key)
      } else if (g) {
        const t = TARGETS.find((t) => t.key === k)
        if (t) classifyGroup(g, t.value)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${focus}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [focus])

  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  const s = data?.summary

  return (
    <div>
      <PageHeader
        title="Triage"
        description="Unclassified card expenses grouped by merchant. Classify a whole merchant at once."
        actions={
          <Button
            variant="outline"
            disabled={smallIds.length === 0}
            onClick={() => setConfirmSmall(true)}
          >
            Shown under {formatMoney(limit, 'CHF')} → Private ({smallIds.length})
          </Button>
        }
      />
      <div className="space-y-4 px-8 py-6">
        {s && (
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Unclassified" value={String(s.count)} sub={formatMoney(s.total, 'CHF')} tone="warning" />
            <Stat
              label={`From ${formatMoney(limit, 'CHF')} (could be submitted)`}
              value={String(s.count - s.smallCount)}
              sub={formatMoney(s.total - s.smallTotal, 'CHF')}
            />
            <Stat
              label={`Under ${formatMoney(limit, 'CHF')} (lump sum)`}
              value={String(s.smallCount)}
              sub={formatMoney(s.smallTotal, 'CHF')}
            />
            <Card>
              <CardContent className="space-y-0.5 py-4 text-xs">
                <div className="mb-1 text-muted-foreground">By card</div>
                {s.byAccount.map((a) => (
                  <div key={a.label} className="flex justify-between gap-2 tabular-nums">
                    <span className="truncate">{a.label}</span>
                    <span className="text-muted-foreground">
                      {a.count} · {formatMoney(a.total, 'CHF')}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Select value={year} onValueChange={(v) => setYear(v as Year)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['2024', '2025', '2026'].map((y) => (
                <SelectItem key={y} value={y}>
                  {y}
                </SelectItem>
              ))}
              <SelectItem value="all">All years</SelectItem>
            </SelectContent>
          </Select>
          <Select value={size} onValueChange={(v) => setSize(v as Size)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any amount</SelectItem>
              <SelectItem value="large">From {formatMoney(limit, 'CHF')}</SelectItem>
              <SelectItem value="small">Under {formatMoney(limit, 'CHF')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="total">Sort: total</SelectItem>
              <SelectItem value="count">Sort: count</SelectItem>
              <SelectItem value="latest">Sort: latest</SelectItem>
              <SelectItem value="merchant">Sort: merchant</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="Search merchant…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64"
          />
          <span className="ml-auto text-sm text-muted-foreground tabular-nums">
            {isFetching && <Loader2 className="mr-1 inline size-3.5 animate-spin" />}
            {groups.length} merchants · {shown.count} expenses · {formatMoney(shown.total, 'CHF')}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>s</kbd> SMP · <kbd>d</kbd> DM · <kbd>f</kbd> Private ·{' '}
          <kbd>Enter</kbd> expand · <kbd>Ctrl+Z</kbd> undo
        </p>

        <Card>
          <CardContent className="px-0" ref={listRef}>
            {groups.map((g, idx) => {
              const isOpen = open.has(g.key)
              const hist = Object.entries(
                g.classified.reduce<Record<string, number>>((h, c) => {
                  h[c.classification] = (h[c.classification] ?? 0) + 1
                  return h
                }, {}),
              ).sort((a, b) => b[1] - a[1])
              return (
                <Fragment key={g.key}>
                  <div
                    data-idx={idx}
                    onClick={() => setFocus(idx)}
                    className={cn(
                      'flex items-center gap-3 border-b border-border px-4 py-2.5',
                      idx === focus && 'bg-accent/60 ring-1 ring-primary/60 ring-inset',
                    )}
                  >
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => toggle(g.key)}
                      aria-label={isOpen ? 'Collapse' : 'Expand'}
                    >
                      {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{g.merchant}</span>
                        {g.meal && <Pill>meal</Pill>}
                        {hist.map(([c, n]) => (
                          <span
                            key={c}
                            title={`${n} other expense(s) from this merchant are already ${classificationLabel(c)}. They are not in this list and the buttons don't change them.`}
                          >
                            <Pill>
                              <span className={cn('size-1.5 rounded-full', COMPANY_DOT[c])} />
                              already {n}× {SHORT[c] ?? classificationLabel(c)}
                            </Pill>
                          </span>
                        ))}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {g.firstDate === g.lastDate ? g.lastDate : `${g.firstDate} – ${g.lastDate}`} ·{' '}
                        {g.accounts.join(', ')}
                        {g.note && (
                          <span className="ml-2 text-amber-500/90">
                            <StickyNote className="mr-0.5 inline size-3" />
                            {g.note}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="w-12 text-right text-sm text-muted-foreground tabular-nums">
                      {g.count}×
                    </div>
                    <div className="w-28 text-right font-medium tabular-nums">
                      {formatMoney(g.total, 'CHF')}
                    </div>
                    <ClassifyButtons
                      onPick={(t) => classifyGroup(g, t)}
                    />
                  </div>
                  {isOpen &&
                    g.rows.map((r) => (
                      <div
                        key={r.id}
                        className="flex items-center gap-3 border-b border-border bg-muted/30 py-1.5 pr-4 pl-11 text-sm"
                      >
                        <span className="w-24 text-xs tabular-nums">{r.txDate}</span>
                        <span className="w-28 truncate text-xs text-muted-foreground">{r.account}</span>
                        <span className="min-w-0 flex-1 truncate text-xs">
                          {r.description && r.description !== r.merchant ? r.description : r.merchant}
                          {r.note && <span className="ml-2 text-amber-500/90">{r.note}</span>}
                        </span>
                        <span className="w-24 text-right text-xs text-muted-foreground">
                          {r.originalCurrency && (
                            <Amount minor={r.originalAmount} currency={r.originalCurrency} />
                          )}
                        </span>
                        <Amount
                          minor={r.amount}
                          currency={r.currency}
                          className={cn('w-28 text-right', Math.abs(r.amount) < limit && 'text-muted-foreground')}
                        />
                        <Link
                          to="/reconcile/$id"
                          params={{ id: r.id }}
                          className="text-muted-foreground hover:text-foreground"
                          title="Open in review"
                        >
                          <ExternalLink className="size-3.5" />
                        </Link>
                        <ClassifyButtons
                          small
                          onPick={(t) =>
                            classify.mutate({
                              ids: [r.id],
                              classification: t,
                              label: `${r.merchant ?? g.merchant} ${r.txDate}`,
                            })
                          }
                        />
                      </div>
                    ))}
                  {isOpen && g.classified.length > 0 && (
                    <>
                      <div className="border-b border-border bg-muted/30 py-1 pr-4 pl-11 text-xs text-muted-foreground">
                        Already classified, shown for reference (the buttons above don't change these)
                      </div>
                      {g.classified.map((c) => (
                        <div
                          key={c.id}
                          className="flex items-center gap-3 border-b border-border bg-muted/30 py-1.5 pr-4 pl-11 text-sm opacity-60"
                        >
                          <span className="w-24 text-xs tabular-nums">{c.txDate}</span>
                          <span className="w-28 truncate text-xs text-muted-foreground">{c.account}</span>
                          <span className="min-w-0 flex-1" />
                          <Amount minor={c.amount} currency={c.currency} className="w-28 text-right" />
                          <Link
                            to="/reconcile/$id"
                            params={{ id: c.id }}
                            className="text-muted-foreground hover:text-foreground"
                            title="Open in review"
                          >
                            <ExternalLink className="size-3.5" />
                          </Link>
                          <span className="flex w-[173px] justify-end">
                            <ClassificationBadge value={c.classification} />
                          </span>
                        </div>
                      ))}
                    </>
                  )}
                </Fragment>
              )
            })}
            {groups.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                {isFetching ? 'Loading…' : 'Nothing left to classify here.'}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={confirmSmall} onOpenChange={setConfirmSmall}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set {smallIds.length} small expenses to Private?</DialogTitle>
            <DialogDescription>
              Every expense under {formatMoney(limit, 'CHF')} in the current view (
              {year === 'all' ? 'all years' : year}
              {search ? `, search “${search}”` : ''}) will be classified Private: it can't be
              submitted, the lump sum covers it. Ctrl+Z undoes it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSmall(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                classify.mutate({
                  ids: smallIds,
                  classification: 'private',
                  label: `${smallIds.length} small expenses`,
                })
              }
            >
              Set to Private
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ClassifyButtons({
  onPick,
  disabled,
  small,
}: {
  onPick: (t: Target) => void
  disabled?: boolean
  small?: boolean
}) {
  return (
    <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
      {TARGETS.map((t) => (
        <Button
          key={t.value}
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(small ? 'h-6 px-1.5 text-xs' : 'h-7 px-2 text-xs')}
          onClick={() => onPick(t.value)}
          title={small ? undefined : `${classificationLabel(t.value)} (${t.key})`}
        >
          <span className={cn('size-2 rounded-full', COMPANY_DOT[t.value])} />
          {t.label}
        </Button>
      ))}
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'warning'
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={cn('mt-1 text-xl font-semibold tabular-nums', tone === 'warning' && 'text-warning')}>
          {value}
        </div>
        {sub && <div className="text-xs text-muted-foreground tabular-nums">{sub}</div>}
      </CardContent>
    </Card>
  )
}
