export const CLASSIFICATION_LABELS: Record<string, string> = {
  deliver_media: 'deliver.media',
  swiss_media_partners: 'SwissMediaPartners',
  private: 'Private',
  unclassified: 'Unclassified',
}

export function classificationLabel(c: string): string {
  return CLASSIFICATION_LABELS[c] ?? c
}

export type Tone = 'success' | 'warning' | 'muted' | 'destructive'

export function scoreTone(score: number): Tone {
  if (score >= 80) return 'success'
  if (score >= 50) return 'warning'
  return 'muted'
}

export const RECON_LABELS: Record<string, string> = {
  open: 'Open',
  partially_matched: 'Partial',
  matched: 'Reconciled',
  ignored: 'Private',
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}
