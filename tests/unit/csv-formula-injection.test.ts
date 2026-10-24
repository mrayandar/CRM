/**
 * Every CSV export (Leads, Contacts, Companies, Payments, Pipeline, Reports — see src/lib/utils.ts's
 * exportCsv doc comment) funnels through this one csvCell(), so this is the one place formula
 * injection needs to be blocked: a name/note/email starting with `=`, `+`, `-`, or `@` would
 * otherwise execute as a formula when the exported CSV is opened in Excel/Sheets.
 */
import { describe, expect, it } from 'vitest'
import { csvCell } from '@/lib/utils'

describe('csvCell neutralizes CSV formula injection', () => {
  it.each([
    ['=HYPERLINK("http://evil.test","click")', `"'=HYPERLINK(""http://evil.test"",""click"")"`],
    ['+1-555-0100', `'+1-555-0100`],
    ['-1', `'-1`],
    ['@mention', `'@mention`],
    ['=1+1', `'=1+1`],
  ])('prefixes a leading formula character: %s', (input, expected) => {
    expect(csvCell(input)).toBe(expected)
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
