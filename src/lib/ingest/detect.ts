import chardet from 'chardet'
import iconv from 'iconv-lite'
import type { SourceType } from '#/db/types.ts'

export type FileKind = 'csv' | 'excel' | 'camt053' | 'mt942' | 'mt940' | 'unknown'

export interface EncodingResult {
  encoding: string
  confidence: number
  bom: 'utf8' | 'utf16le' | 'utf16be' | null
}

export function detectEncoding(buf: Buffer): EncodingResult {
  // BOM short-circuit
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return { encoding: 'UTF-8', confidence: 1, bom: 'utf8' }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return { encoding: 'UTF-16LE', confidence: 1, bom: 'utf16le' }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
    return { encoding: 'UTF-16BE', confidence: 1, bom: 'utf16be' }

  const analysis = chardet.analyse(buf.subarray(0, 64 * 1024))
  let top = analysis[0]
  // Swiss bias: generic single-byte Latin with bytes in 0x80-0x9F printable in cp1252
  if (top) {
    const name = top.name.toLowerCase()
    const hasCp1252Bytes = buf.subarray(0, 4096).some((b) => b >= 0x80 && b <= 0x9f)
    if (
      hasCp1252Bytes &&
      (name.includes('8859') || name.includes('latin') || name === 'iso-8859-1')
    ) {
      return { encoding: 'windows-1252', confidence: top.confidence / 100, bom: null }
    }
  }
  return {
    encoding: top?.name ?? 'UTF-8',
    confidence: (top?.confidence ?? 0) / 100,
    bom: null,
  }
}

export function decodeBuffer(buf: Buffer, encoding: string): string {
  // strip BOM bytes if present after decode
  try {
    const text = iconv.decode(buf, encoding)
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    return buf.toString('utf-8')
  }
}

export function detectKind(buf: Buffer, fileName = ''): FileKind {
  if (buf.length >= 4) {
    // XLSX = ZIP (PK\x03\x04)
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)
      return 'excel'
    // XLS = OLE2 compound file
    if (
      buf[0] === 0xd0 &&
      buf[1] === 0xcf &&
      buf[2] === 0x11 &&
      buf[3] === 0xe0
    )
      return 'excel'
  }

  // sniff text head
  const head = buf.subarray(0, 8192).toString('latin1').replace(/^﻿/, '')
  const trimmed = head.replace(/^\s+/, '')

  if (trimmed.startsWith('<')) {
    if (
      head.includes('camt.053') ||
      (head.includes('BkToCstmrStmt') && head.includes('Stmt'))
    )
      return 'camt053'
    if (head.includes('camt.052')) return 'camt053' // treat similarly
    return 'unknown'
  }

  // SWIFT MT940/942
  const hasSwiftTags =
    /(^|\n):20:/.test(head) &&
    /(^|\n):25:/.test(head) &&
    /(^|\n):28C?:/.test(head)
  if (hasSwiftTags) {
    if (/(^|\n):34F:/.test(head) || /(^|\n):13D:/.test(head)) return 'mt942'
    if (/(^|\n):60F:/.test(head) || /(^|\n):62F:/.test(head)) return 'mt940'
    return 'mt942'
  }

  // default: delimited text
  if (fileName.toLowerCase().endsWith('.csv')) return 'csv'
  if (/[,;\t|]/.test(head)) return 'csv'
  return 'unknown'
}

export function kindToSourceType(kind: FileKind): SourceType {
  switch (kind) {
    case 'excel':
      return 'excel'
    case 'camt053':
      return 'camt053'
    case 'mt942':
    case 'mt940':
      return 'mt942'
    default:
      return 'csv'
  }
}

const DELIMS = [';', ',', '\t', '|'] as const

/** Sniff the most likely CSV delimiter by column-count consistency. */
export function sniffDelimiter(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, 20)
  if (lines.length === 0) return ','

  let best = ','
  let bestScore = -1
  for (const delim of DELIMS) {
    const counts = lines.map((l) => l.split(delim).length)
    const max = Math.max(...counts)
    if (max <= 1) continue
    // mode
    const freq = new Map<number, number>()
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1)
    let modeCount = 0
    let modeVal = 0
    for (const [val, f] of freq) {
      if (f > modeCount) {
        modeCount = f
        modeVal = val
      }
    }
    const consistency = modeCount / counts.length
    const score = consistency * Math.min(modeVal, 12)
    // tie-break preference toward ';' (Swiss CSVs)
    const adjusted = delim === ';' ? score + 0.01 : score
    if (adjusted > bestScore) {
      bestScore = adjusted
      best = delim
    }
  }
  return best
}
