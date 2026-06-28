import { distance } from 'fastest-levenshtein'

function stripDiacritics(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

/** A long digit run or mixed ref code (POS terminal / store id / auth code). */
function isPosOrRef(t: string): boolean {
  return /^\d{4,}$/.test(t) || /^[a-z]{0,3}\d{3,}[a-z0-9]*$/.test(t)
}

/**
 * Normalize a merchant/counterparty string for matching: lowercase, strip
 * diacritics & punctuation, drop legal-form / card-network / geo / id noise.
 */
export function normalizeMerchant(
  raw: string | null | undefined,
  noiseTokens: Set<string>,
  cityCountry: Set<string>,
): string {
  if (!raw) return ''
  let s = stripDiacritics(raw.toLowerCase())
  s = s.replace(/[^a-z0-9 ]+/g, ' ')
  const tokens = s
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !noiseTokens.has(t))
    .filter((t) => !cityCountry.has(t))
    .filter((t) => !isPosOrRef(t))
  return tokens.join(' ').trim()
}

// ---------------------------------------------------------------------------
// Jaro-Winkler
// ---------------------------------------------------------------------------
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  const matchDistance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aMatches = new Array<boolean>(a.length).fill(false)
  const bMatches = new Array<boolean>(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance)
    const end = Math.min(i + matchDistance + 1, b.length)
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue
      aMatches[i] = true
      bMatches[j] = true
      matches++
      break
    }
  }
  if (matches === 0) return 0
  let t = 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue
    while (!bMatches[k]) k++
    if (a[i] !== b[k]) t++
    k++
  }
  t /= 2
  const m = matches
  const jaro = (m / a.length + m / b.length + (m - t) / m) / 3
  // Winkler prefix boost (up to 4 chars)
  let prefix = 0
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++
    else break
  }
  return jaro + prefix * 0.1 * (1 - jaro)
}

// ---------------------------------------------------------------------------
// Token-set similarity (Sørensen-Dice over token sets)
// ---------------------------------------------------------------------------
export function tokenSetRatio(a: string, b: string): number {
  const sa = new Set(a.split(/\s+/).filter(Boolean))
  const sb = new Set(b.split(/\s+/).filter(Boolean))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return (2 * inter) / (sa.size + sb.size)
}

export function levenshteinRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  return 1 - distance(a, b) / max
}

export interface MerchantBlend {
  tokenSet: number
  jaroWinkler: number
  levenshtein: number
}

/**
 * Ensemble merchant similarity in [0,1]. Returns null when either side has no
 * usable normalized text (so the caller can drop the merchant component).
 */
export function merchantSimilarity(
  aNorm: string,
  bNorm: string,
  blend: MerchantBlend,
): number | null {
  if (!aNorm || !bNorm) return null
  if (aNorm === bNorm) return 1
  const ts = tokenSetRatio(aNorm, bNorm)
  const jw = jaroWinkler(aNorm, bNorm)
  const lev = levenshteinRatio(aNorm, bNorm)
  let score =
    blend.tokenSet * ts + blend.jaroWinkler * jw + blend.levenshtein * lev
  // substring containment bonus (card merchant often a substring of acct desc)
  if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) {
    score = Math.max(score, 0.85)
  }
  return Math.max(0, Math.min(1, score))
}
