import { useEffect, useSyncExternalStore } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  LayoutDashboard,
  Upload,
  ListChecks,
  Receipt,
  Settings,
  Wallet,
  Undo2,
  Layers,
  Link2,
} from 'lucide-react'
import { cn } from '#/lib/utils.ts'
import { popUndo, subscribeUndo, undoSize } from '#/lib/undo.ts'

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/triage', label: 'Triage', icon: Layers },
  { to: '/suggestions', label: 'Suggestions', icon: Link2 },
  { to: '/reconcile', label: 'Reconcile', icon: ListChecks },
  { to: '/transactions', label: 'Transactions', icon: Receipt },
  { to: '/import', label: 'Import', icon: Upload },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const

export function AppShell({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient()
  const pending = useSyncExternalStore(
    subscribeUndo,
    undoSize,
    () => 0,
  )

  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (
        (e.key !== 'z' && e.key !== 'Z') ||
        !(e.ctrlKey || e.metaKey) ||
        e.shiftKey
      )
        return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el?.isContentEditable
      )
        return // let the browser do native text undo
      const entry = popUndo()
      if (!entry) return
      e.preventDefault()
      try {
        await entry.run()
        await qc.invalidateQueries()
        toast.success(`Undone: ${entry.label}`)
      } catch {
        toast.error('Undo failed')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [qc])

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Wallet className="size-5" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Reconciler</div>
            <div className="text-xs text-muted-foreground">Expense matching</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === '/' }}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
              )}
              activeProps={{
                className: 'bg-accent text-accent-foreground',
              }}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="px-5 py-4 text-xs text-muted-foreground">
          {pending > 0 ? (
            <span className="flex items-center gap-1.5">
              <Undo2 className="size-3.5" /> Ctrl+Z to undo ({pending})
            </span>
          ) : (
            'Local · SQLite'
          )}
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden">{children}</main>
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-8 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}
