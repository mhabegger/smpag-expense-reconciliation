import { cn } from '#/lib/utils.ts'
import { classificationLabel, RECON_LABELS, type Tone } from '#/lib/format.ts'
import { formatMoney } from '#/lib/money.ts'

const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-success/15 text-success border-success/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  muted: 'bg-muted text-muted-foreground border-border',
  destructive: 'bg-destructive/15 text-destructive border-destructive/30',
}

export function Pill({
  tone = 'muted',
  className,
  children,
}: {
  tone?: Tone
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function ScoreBadge({ score }: { score: number }) {
  const tone: Tone = score >= 80 ? 'success' : score >= 50 ? 'warning' : 'muted'
  return (
    <span
      className={cn(
        'inline-flex h-7 min-w-9 items-center justify-center rounded-md border px-1.5 text-sm font-semibold tabular-nums',
        TONE_CLASSES[tone],
      )}
    >
      {score}
    </span>
  )
}

// company brand colors (solid chip + white text for readability)
const CLASS_CHIP: Record<string, string> = {
  swiss_media_partners: 'border-smp bg-smp text-white',
  deliver_media: 'border-deliver bg-deliver text-white',
}

/** Brand dot color per classification (used on buttons / dashboards). */
export const COMPANY_DOT: Record<string, string> = {
  swiss_media_partners: 'bg-smp',
  deliver_media: 'bg-deliver',
  private: 'bg-muted-foreground',
  unclassified: 'bg-destructive',
}

export function ClassificationBadge({ value }: { value: string }) {
  const chip = CLASS_CHIP[value]
  if (chip) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
          chip,
        )}
      >
        {classificationLabel(value)}
      </span>
    )
  }
  return (
    <Pill tone={value === 'unclassified' ? 'destructive' : 'muted'}>
      {classificationLabel(value)}
    </Pill>
  )
}

const RECON_TONE: Record<string, Tone> = {
  open: 'destructive',
  partially_matched: 'warning',
  matched: 'success',
  ignored: 'muted',
}

export function ReconBadge({ value }: { value: string }) {
  return <Pill tone={RECON_TONE[value] ?? 'muted'}>{RECON_LABELS[value] ?? value}</Pill>
}

export function Amount({
  minor,
  currency,
  className,
}: {
  minor: number | null | undefined
  currency: string
  className?: string
}) {
  return (
    <span className={cn('tabular-nums', className)}>{formatMoney(minor, currency)}</span>
  )
}
