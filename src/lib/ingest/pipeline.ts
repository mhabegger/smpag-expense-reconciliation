import type { Ledger, SourceType } from '#/db/types.ts'
import {
  type FileKind,
  decodeBuffer,
  detectEncoding,
  detectKind,
  kindToSourceType,
  sniffDelimiter,
} from '#/lib/ingest/detect.ts'
import { parseCamt053 } from '#/lib/ingest/parsers/camt053.ts'
import { parseMt942 } from '#/lib/ingest/parsers/mt942.ts'
import { parseRaiffeisenCsv } from '#/lib/ingest/parsers/raiffeisenCsv.ts'
import { type RawRow, mapRowsToCanonical } from '#/lib/ingest/parsers/tabular.ts'
import {
  getPresetByKey,
  matchPresetByHeaders,
} from '#/lib/ingest/presets.ts'
import { readCsvTable, readExcelTable } from '#/lib/ingest/readers.ts'
import type {
  CanonicalRow,
  FieldMap,
  MappingOptions,
} from '#/lib/ingest/types.ts'

export interface AnalyzeOptions {
  presetKey?: string
  fieldMap?: FieldMap
  options?: MappingOptions
}

export interface AnalyzeResult {
  kind: FileKind
  sourceType: SourceType
  encoding: string | null
  delimiter: string | null
  sheetNames: string[] | null
  selectedSheet: string | null
  headers: string[]
  presetKey: string | null
  presetLabel: string | null
  institute: string | null
  ledger: Ledger | null
  rows: CanonicalRow[] | null // null when manual mapping is required
  sampleRecords: RawRow[]
  warnings: string[]
}

export function analyzeFile(
  buffer: Buffer,
  fileName: string,
  opts: AnalyzeOptions = {},
): AnalyzeResult {
  const kind = detectKind(buffer, fileName)
  const sourceType: SourceType = kindToSourceType(kind)
  const warnings: string[] = []

  // ---- Structured bank formats (no column mapping) ----
  if (kind === 'camt053') {
    const enc = detectEncoding(buffer)
    const text = decodeBuffer(buffer, enc.encoding)
    const res = parseCamt053(text)
    return base({
      kind,
      sourceType,
      encoding: enc.encoding,
      headers: [],
      rows: res.rows,
      ledger: 'bank',
      institute: 'raiffeisen',
      presetKey: 'camt053',
      presetLabel: 'ISO 20022 camt.053',
      warnings: res.warnings,
    })
  }
  if (kind === 'mt942' || kind === 'mt940') {
    const enc = detectEncoding(buffer)
    const text = decodeBuffer(buffer, enc.encoding)
    const res = parseMt942(text, kind)
    return base({
      kind,
      sourceType,
      encoding: enc.encoding,
      headers: [],
      rows: res.rows,
      ledger: 'bank',
      institute: 'raiffeisen',
      presetKey: 'mt942',
      presetLabel: 'SWIFT MT942',
      warnings: res.warnings,
    })
  }

  // ---- Tabular (CSV / Excel) ----
  let headers: string[] = []
  let records: RawRow[] = []
  let encoding: string | null = null
  let delimiter: string | null = null
  let sheetNames: string[] | null = null
  let selectedSheet: string | null = null

  if (kind === 'excel') {
    const table = readExcelTable(
      buffer,
      opts.options?.sheetName,
      opts.options?.headerRow,
    )
    headers = table.headers
    records = table.records
    sheetNames = table.sheetNames ?? null
    selectedSheet = table.selectedSheet ?? null
  } else {
    const enc = detectEncoding(buffer)
    encoding = opts.options?.encoding ?? enc.encoding
    const text = decodeBuffer(buffer, encoding)
    delimiter = opts.options?.delimiter ?? sniffDelimiter(text)
    const table = readCsvTable(text, delimiter)
    headers = table.headers
    records = table.records
  }

  // resolve a preset (explicit > auto by headers)
  const preset = opts.presetKey
    ? getPresetByKey(opts.presetKey)
    : matchPresetByHeaders(headers)

  let rows: CanonicalRow[] | null = null

  if (opts.fieldMap) {
    // manual mapping supplied by the wizard
    rows = mapRowsToCanonical(records, opts.fieldMap, opts.options ?? {})
  } else if (preset) {
    if (preset.customParser === 'raiffeisenCsv') {
      const res = parseRaiffeisenCsv(records)
      rows = res.rows
      warnings.push(...res.warnings)
    } else {
      rows = mapRowsToCanonical(records, preset.fieldMap, preset.options)
    }
  }

  return base({
    kind,
    sourceType,
    encoding,
    delimiter,
    sheetNames,
    selectedSheet,
    headers,
    rows,
    ledger: preset?.ledger ?? null,
    institute: preset?.institute ?? null,
    presetKey: preset?.key ?? null,
    presetLabel: preset?.label ?? null,
    sampleRecords: records.slice(0, 8),
    warnings,
  })
}

function base(p: Partial<AnalyzeResult> & Pick<AnalyzeResult, 'kind' | 'sourceType'>): AnalyzeResult {
  return {
    kind: p.kind,
    sourceType: p.sourceType,
    encoding: p.encoding ?? null,
    delimiter: p.delimiter ?? null,
    sheetNames: p.sheetNames ?? null,
    selectedSheet: p.selectedSheet ?? null,
    headers: p.headers ?? [],
    presetKey: p.presetKey ?? null,
    presetLabel: p.presetLabel ?? null,
    institute: p.institute ?? null,
    ledger: p.ledger ?? null,
    rows: p.rows ?? null,
    sampleRecords: p.sampleRecords ?? [],
    warnings: p.warnings ?? [],
  }
}

export function periodOf(rows: CanonicalRow[]): {
  start: string | null
  end: string | null
} {
  const dates = rows.map((r) => r.txDate).filter(Boolean).sort()
  return { start: dates[0] ?? null, end: dates[dates.length - 1] ?? null }
}
