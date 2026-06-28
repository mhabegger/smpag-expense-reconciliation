export interface SubsetItem {
  id: string
  minor: number // positive magnitude in target currency
  date: string
}

export interface SubsetGroup {
  ids: string[]
  sum: number
  members: SubsetItem[]
}

export interface SubsetOptions {
  minSize?: number
  maxSize?: number
  maxResults?: number
}

/**
 * Find subsets of `items` whose magnitudes sum to `target` within `tol`.
 * Bounded DFS over positive magnitudes (items should be pre-capped, e.g. ≤15).
 */
export function findSubsetSums(
  items: SubsetItem[],
  target: number,
  tol: number,
  opts: SubsetOptions = {},
): SubsetGroup[] {
  const minSize = opts.minSize ?? 2
  const maxSize = opts.maxSize ?? 8
  const cap = opts.maxResults ?? 20
  const sorted = [...items].sort((a, b) => b.minor - a.minor)
  const results: SubsetGroup[] = []

  const dfs = (start: number, chosen: number[], sum: number) => {
    if (results.length >= cap * 4) return
    if (chosen.length >= minSize && Math.abs(sum - target) <= tol) {
      const members = chosen.map((i) => sorted[i])
      results.push({
        ids: members.map((m) => m.id),
        sum,
        members,
      })
    }
    if (chosen.length >= maxSize) return
    for (let i = start; i < sorted.length; i++) {
      const next = sum + sorted[i].minor
      if (next > target + tol) continue // overshoot; smaller later items may still fit
      chosen.push(i)
      dfs(i + 1, chosen, next)
      chosen.pop()
    }
  }
  dfs(0, [], 0)
  return results
}

/** Spread of member dates in days (max - min). */
export function dateSpreadDays(members: SubsetItem[]): number {
  if (members.length <= 1) return 0
  const times = members.map((m) => new Date(m.date).getTime())
  return Math.round((Math.max(...times) - Math.min(...times)) / 86400000)
}
