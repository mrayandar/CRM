/**
 * Pure-function coverage for lib/data/import.ts's parsing/encoding/mapping/field-validation layer
 * — no DB access, so these run as unit tests. Duplicate-detection and company/owner resolution
 * (which do hit the DB) are covered in tests/integration/csv-import.test.ts instead.
 */
import { describe, expect, it } from 'vitest'
import {
  decodeImportFile,
  parseImportCsv,
  suggestColumnMapping,
  validateRowFields,
  MAX_IMPORT_ROWS,
  DEFAULT_LEAD_SOURCE,
  DEFAULT_LEAD_STATUS,
} from '@lib/data/import'

describe('decodeImportFile', () => {
  it('decodes a well-formed UTF-8 file with no fallback', () => {
    const content = 'name,email\nAlice Smith,alice@example.com\n'
    const { text, encodingFallback } = decodeImportFile(Buffer.from(content, 'utf8'))
    expect(text).toBe(content)
    expect(encodingFallback).toBeNull()
  })

  it('strips a leading UTF-8 BOM', () => {
    const content = 'name,email\nAlice Smith,alice@example.com\n'
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')])
    const { text, encodingFallback } = decodeImportFile(withBom)
    expect(text).toBe(content)
    expect(encodingFallback).toBeNull()
  })

  it('decodes UTF-8 text containing Urdu names correctly (no fallback)', () => {
    const content = 'name,email\nمحمد علی,ali@example.com\n'
    const { text, encodingFallback } = decodeImportFile(Buffer.from(content, 'utf8'))
    expect(text).toBe(content)
    expect(encodingFallback).toBeNull()
  })

  it('falls back to Windows-1252 for a non-UTF-8 file (common Excel export) and warns', () => {
    const content = 'name,email\nJose Garcia,jose@example.com\n'
    // 'é' as a single Windows-1252 byte (0xE9) makes the whole buffer invalid UTF-8 (0xE9 alone
    // has no valid continuation byte) — the same byte value Buffer's 'latin1' encoding writes.
    const windows1252 = Buffer.from('name,email\nJosé Garcia,jose@example.com\n', 'latin1')
    const { text, encodingFallback } = decodeImportFile(windows1252)
    expect(text).toBe('name,email\nJosé Garcia,jose@example.com\n')
    expect(encodingFallback).toBe('windows-1252')
    expect(content).toBeTruthy() // sanity: content var used for contrast above
  })

  it('rejects a file that is not readable as text even after the Windows-1252 fallback', () => {
    const garbage = Buffer.concat([Buffer.from([0xff]), Buffer.alloc(1000, 0x00)])
    expect(() => decodeImportFile(garbage)).toThrow(/CSV UTF-8/)
  })
})

describe('parseImportCsv', () => {
  it('parses a comma-delimited file', () => {
    const { headers, rows } = parseImportCsv('name,email\nAlice,alice@example.com\n')
    expect(headers).toEqual(['name', 'email'])
    expect(rows).toEqual([['Alice', 'alice@example.com']])
  })

  it('auto-detects a semicolon-delimited file (common European-locale Excel export)', () => {
    const { headers, rows } = parseImportCsv('name;email\nBob;bob@example.com\n')
    expect(headers).toEqual(['name', 'email'])
    expect(rows).toEqual([['Bob', 'bob@example.com']])
  })

  it('handles a quoted field with an embedded newline as one cell, not two rows', () => {
    const { headers, rows } = parseImportCsv('name,notes\n"Alice","Line one\nLine two"\n')
    expect(headers).toEqual(['name', 'notes'])
    expect(rows).toEqual([['Alice', 'Line one\nLine two']])
  })

  it('throws a clear error for a file with no rows at all', () => {
    expect(() => parseImportCsv('')).toThrow('no rows')
  })

  it('treats a header-only file as zero data rows, not an error', () => {
    const { headers, rows } = parseImportCsv('name,email\n')
    expect(headers).toEqual(['name', 'email'])
    expect(rows).toEqual([])
  })

  it('MAX_IMPORT_ROWS is a sane bound the route enforces (sanity check, not re-testing the route here)', () => {
    expect(MAX_IMPORT_ROWS).toBe(2000)
  })
})

describe('suggestColumnMapping', () => {
  it('auto-suggests common lead headers', () => {
    const mapping = suggestColumnMapping(
      ['Full Name', 'Email Address', 'Company Name', 'Lead Source', 'Status'],
      'lead',
    )
    expect(mapping).toEqual({ 0: 'name', 1: 'email', 2: 'company', 3: 'source', 4: 'status' })
  })

  it('auto-suggests common contact headers', () => {
    const mapping = suggestColumnMapping(['Name', 'Job Title', 'Organization'], 'contact')
    expect(mapping).toEqual({ 0: 'name', 1: 'title', 2: 'company' })
  })

  it('leaves an unrecognized header unmapped (null), not guessed', () => {
    const mapping = suggestColumnMapping(['Some Random Column'], 'lead')
    expect(mapping).toEqual({ 0: null })
  })
})

describe('validateRowFields', () => {
  const mapping = { 0: 'name' as const, 1: 'email' as const, 2: 'company' as const, 3: 'source' as const, 4: 'status' as const }

  it('accepts a well-formed lead row', () => {
    const result = validateRowFields('lead', ['Alice', 'alice@example.com', 'Acme', 'Inbound', 'new'], mapping, 1)
    expect(result.errors).toEqual([])
    expect(result.name.value).toBe('Alice')
    expect(result.source.defaulted).toBe(false)
    expect(result.status.defaulted).toBe(false)
  })

  it('requires a name', () => {
    const result = validateRowFields('lead', ['', 'alice@example.com', 'Acme', 'Inbound', 'new'], mapping, 1)
    expect(result.errors).toContain('Name is required')
  })

  it('requires a company', () => {
    const result = validateRowFields('lead', ['Alice', 'alice@example.com', '', 'Inbound', 'new'], mapping, 1)
    expect(result.errors).toContain('Company is required')
  })

  it('rejects a malformed email', () => {
    const result = validateRowFields('lead', ['Alice', 'not-an-email', 'Acme', 'Inbound', 'new'], mapping, 1)
    expect(result.errors).toContain('Invalid email')
  })

  it('allows a blank email (optional field)', () => {
    const result = validateRowFields('lead', ['Alice', '', 'Acme', 'Inbound', 'new'], mapping, 1)
    expect(result.errors).not.toContain('Invalid email')
    expect(result.email.value).toBe('')
  })

  it('defaults an unrecognized source to DEFAULT_LEAD_SOURCE and flags it, without erroring', () => {
    const result = validateRowFields('lead', ['Alice', 'alice@example.com', 'Acme', 'Carrier Pigeon', 'new'], mapping, 1)
    expect(result.errors).toEqual([])
    expect(result.source.value).toBe(DEFAULT_LEAD_SOURCE)
    expect(result.source.raw).toBe('Carrier Pigeon')
    expect(result.source.defaulted).toBe(true)
  })

  it('defaults an unrecognized status to DEFAULT_LEAD_STATUS and flags it, without erroring', () => {
    const result = validateRowFields('lead', ['Alice', 'alice@example.com', 'Acme', 'Inbound', 'somewhere'], mapping, 1)
    expect(result.errors).toEqual([])
    expect(result.status.value).toBe(DEFAULT_LEAD_STATUS)
    expect(result.status.defaulted).toBe(true)
  })

  it('a blank source/status cell is not flagged as defaulted (nothing to default from)', () => {
    const result = validateRowFields('lead', ['Alice', 'alice@example.com', 'Acme', '', ''], mapping, 1)
    expect(result.source.defaulted).toBe(false)
    expect(result.status.defaulted).toBe(false)
    expect(result.source.value).toBe(DEFAULT_LEAD_SOURCE)
    expect(result.status.value).toBe(DEFAULT_LEAD_STATUS)
  })

  it('rejects a name over the length cap', () => {
    const result = validateRowFields('lead', ['A'.repeat(201), 'alice@example.com', 'Acme', 'Inbound', 'new'], mapping, 1)
    expect(result.errors).toContain('Name is required')
  })
})
