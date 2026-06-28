// Tiny app-wide undo stack. Each entry knows how to reverse one action via a
// compensating server call. A global Ctrl/Cmd+Z handler pops and runs the latest.

export interface UndoEntry {
  label: string
  run: () => Promise<unknown>
}

const stack: UndoEntry[] = []
const subscribers = new Set<() => void>()
const MAX = 50

function notify() {
  for (const s of subscribers) s()
}

export function pushUndo(entry: UndoEntry): void {
  stack.push(entry)
  if (stack.length > MAX) stack.shift()
  notify()
}

export function popUndo(): UndoEntry | null {
  const e = stack.pop() ?? null
  notify()
  return e
}

export function undoSize(): number {
  return stack.length
}

export function subscribeUndo(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}
