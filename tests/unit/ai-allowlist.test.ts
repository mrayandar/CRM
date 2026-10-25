/**
 * lib/ai/allowlist.ts: pure env-var parsing, no DB — unset/empty/whitespace-only values must
 * allow no org, matching must be exact on whole ids (never a substring match), and whitespace
 * around commas must be trimmed.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { isOrgAllowlistedForAi } from '@lib/ai/allowlist'

const ORIGINAL = process.env.AI_ASSIST_ALLOWED_ORG_IDS

afterEach(() => {
  process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORIGINAL
})

describe('isOrgAllowlistedForAi', () => {
  it('allows no org when the env var is unset', () => {
    delete process.env.AI_ASSIST_ALLOWED_ORG_IDS
    expect(isOrgAllowlistedForAi('org-1')).toBe(false)
  })

  it('allows no org when the env var is an empty string', () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ''
    expect(isOrgAllowlistedForAi('org-1')).toBe(false)
  })

  it('allows no org when the env var is whitespace-only', () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = '   '
    expect(isOrgAllowlistedForAi('org-1')).toBe(false)
  })

  it('allows no org when the env var is only commas/whitespace', () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ' , , '
    expect(isOrgAllowlistedForAi('org-1')).toBe(false)
  })

  it('matches a single listed id exactly', () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = 'org-1'
    expect(isOrgAllowlistedForAi('org-1')).toBe(true)
    expect(isOrgAllowlistedForAi('org-2')).toBe(false)
  })

  it('matches on the whole id, never a substring of a listed id or vice versa', () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = 'org-123'
    expect(isOrgAllowlistedForAi('org-1')).toBe(false) // a prefix of a listed id
    expect(isOrgAllowlistedForAi('org-12')).toBe(false) // another prefix
    expect(isOrgAllowlistedForAi('rg-123')).toBe(false) // a suffix
    expect(isOrgAllowlistedForAi('org-1234')).toBe(false) // a listed id as ITS prefix
    expect(isOrgAllowlistedForAi('org-123')).toBe(true) // the exact id
  })

  it('trims whitespace around each comma-separated id', () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ' org-1 ,org-2,  org-3  '
    expect(isOrgAllowlistedForAi('org-1')).toBe(true)
    expect(isOrgAllowlistedForAi('org-2')).toBe(true)
    expect(isOrgAllowlistedForAi('org-3')).toBe(true)
    // the untrimmed, space-padded form itself is never a match
    expect(isOrgAllowlistedForAi(' org-1 ')).toBe(false)
  })

  it('matches any one of several listed ids', () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = 'org-a,org-b,org-c'
    expect(isOrgAllowlistedForAi('org-b')).toBe(true)
    expect(isOrgAllowlistedForAi('org-z')).toBe(false)
  })
})
