import { ArrowUpDown, ChevronDown, ChevronUp } from 'lucide-react'

export type SortDir = 'asc' | 'desc'

/** Header sort indicator: faint ⇅ when inactive, ▲/▼ when active. */
export function sortIcon(col: string, sortBy: string, sortDir: SortDir) {
  if (col !== sortBy) return <ArrowUpDown className="size-3 opacity-40" />
  return sortDir === 'asc' ? (
    <ChevronUp className="size-3.5" />
  ) : (
    <ChevronDown className="size-3.5" />
  )
}
