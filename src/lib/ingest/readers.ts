import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import type { RawRow } from '#/lib/ingest/parsers/tabular.ts'

export interface TableData {
  headers: string[]
  records: RawRow[]
  matrix: unknown[][]
  sheetNames?: string[]
  selectedSheet?: string
  headerRowIndex: number
}

/** Parse CSV text into a raw matrix (no header interpretation yet). */
export function csvToMatrix(text: string, delimiter: string): string[][] {
  const res = Papa.parse<string[]>(text, {
    delimiter,
    header: false,
    skipEmptyLines: false,
    quoteChar: '"',
  })
  return (res.data as string[][]).filter((r) => r.length > 0)
}

function looksNumericOrDate(v: unknown): boolean {
  if (v instanceof Date) return true
  if (typeof v === 'number') return true
  const s = String(v ?? '').trim()
  if (!s) return false
  return /^[-+]?[\d'.,\s]+$/.test(s) || /\d{1,4}[./-]\d{1,2}[./-]\d{1,4}/.test(s)
}

/** Pick the header row: first row of mostly non-empty text cells followed by data. */
export function detectHeaderRow(matrix: unknown[][]): number {
  const limit = Math.min(15, matrix.length)
  for (let i = 0; i < limit; i++) {
    const row = matrix[i] ?? []
    const nonEmpty = row.filter((c) => String(c ?? '').trim() !== '')
    if (nonEmpty.length < 2) continue
    const textCells = nonEmpty.filter((c) => !looksNumericOrDate(c))
    if (textCells.length < nonEmpty.length * 0.6) continue
    // next non-empty row should contain some data-typed cells
    const next = matrix[i + 1] ?? []
    if (next.some(looksNumericOrDate) || i + 1 >= matrix.length) return i
  }
  return 0
}

export function matrixToRecords(
  matrix: unknown[][],
  headerRowIndex: number,
): { headers: string[]; records: RawRow[] } {
  const headerRaw = matrix[headerRowIndex] ?? []
  const seen = new Map<string, number>()
  const headers = headerRaw.map((h, i) => {
    const s = String(h ?? '').trim()
    const name = s === '' ? `Column ${i + 1}` : s
    // disambiguate duplicate headers (banks emit e.g. two "Amount" columns) —
    // rec[name] would silently keep only the last one
    const n = (seen.get(name) ?? 0) + 1
    seen.set(name, n)
    return n === 1 ? name : `${name} (${n})`
  })
  const records: RawRow[] = []
  for (let r = headerRowIndex + 1; r < matrix.length; r++) {
    const row = matrix[r]
    if (!row || row.every((c) => String(c ?? '').trim() === '')) continue
    const rec: RawRow = {}
    headers.forEach((h, i) => {
      rec[h] = row[i] ?? null
    })
    records.push(rec)
  }
  return { headers, records }
}

export function readCsvTable(text: string, delimiter: string): TableData {
  const matrix = csvToMatrix(text, delimiter)
  const headerRowIndex = 0 // CSV header is conventionally the first row
  const { headers, records } = matrixToRecords(matrix, headerRowIndex)
  return { headers, records, matrix, headerRowIndex }
}

export function readExcelTable(
  buf: Buffer,
  sheetName?: string,
  headerRowIndex?: number,
): TableData {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true })
  const sheetNames = wb.SheetNames
  // pick the sheet with the most rows by default
  let selected = sheetName && sheetNames.includes(sheetName) ? sheetName : ''
  if (!selected) {
    let bestRows = -1
    for (const name of sheetNames) {
      const ref = wb.Sheets[name]['!ref']
      const rows = ref ? XLSX.utils.decode_range(ref).e.r : 0
      if (rows > bestRows) {
        bestRows = rows
        selected = name
      }
    }
  }
  const ws = wb.Sheets[selected]
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
    raw: true,
    blankrows: false,
  })
  const hri = headerRowIndex ?? detectHeaderRow(matrix)
  const { headers, records } = matrixToRecords(matrix, hri)
  return {
    headers,
    records,
    matrix,
    sheetNames,
    selectedSheet: selected,
    headerRowIndex: hri,
  }
}
