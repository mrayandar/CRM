/**
 * Every CSV export (Leads, Contacts, Companies, Payments, Pipeline, Reports — see src/lib/utils.ts's
 * exportCsv doc comment) funnels through this one csvCell(), so this is the one place formula
 * injection needs to be blocked: a name/note/email starting with `=`, `+`, `-`, or `@` would
 * otherwise execute as a formula when the exported CSV is opened in Excel/Sheets. The one
 * exception is a value shaped unambiguously like a phone number (leading `+`, otherwise only
 * digits/spaces/parens/dots/dashes) — real phone numbers in this app are written "+1 555 010 0199"
 * and would otherwise be mangled on every export.
 */
import { describe, expect, it } from 'vitest'
import { csvCell } from '@/lib/utils'

describe('csvCell neutralizes CSV formula injection', () => {
  it.each([
    ['=HYPERLINK("http://evil.test","click")', `"'=HYPERLINK(""http://evil.test"",""click"")"`],
    ['-1', `'-1`],
    ['@mention', `'@mention`],
    ['=1+1', `'=1+1`],
    // A '+' prefix alone isn't enough to be exempted — the body must still be phone-shaped.
    ['+=cmd', `'+=cmd`],
    ['+1,=1+1', `"'+1,=1+1"`],
  ])('prefixes a leading formula character: %s', (input, expected) => {
    expect(csvCell(input)).toBe(expected)
  })

  it.each([
    ['+1 555 010 0199', '+1 555 010 0199'],
    ['+1-555-0100', '+1-555-0100'],
    ['+92 (300) 123.4567', '+92 (300) 123.4567'],
  ])('leaves a real phone number untouched (the one exemption): %s', (input, expected) => {
    expect(csvCell(input)).toBe(expected)
  })

  it('a phone cell whose value is actually a formula-injection payload is still neutralized', () => {
    expect(csvCell('=HYPERLINK("http://evil.test")')).toBe(`"'=HYPERLINK(""http://evil.test"")"`)
  })

  it('a note starting with = is still neutralized', () => {
    expect(csvCell('=SUM(A1:A10)')).toBe(`'=SUM(A1:A10)`)
  })

  it.each(['Alice Smith', 'alice@example.com', '100', 'Some, Co.', ''])(
    'leaves an ordinary value unchanged (aside from existing quote/comma escaping): %s',
    (input) => {
      expect(csvCell(input)).not.toMatch(/^"?'/)
    },
  )

  it('still escapes quotes/commas/newlines after neutralizing a formula prefix', () => {
    expect(csvCell('=A,B')).toBe(`"'=A,B"`)
  })
})
