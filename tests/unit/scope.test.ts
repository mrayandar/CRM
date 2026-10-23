/**
 * Unit coverage for computeScopeOwnerId (src/lib/scope.ts — the fail-closed, two-source rule
 * requireAuth()/resolveAuth() now compute on every request). Nothing reads the result yet
 * (Stage 1 wires enforcement in); this is the structural guard for the rule itself, matching
 * requirePaymentAccess's identical two-source check one layer up.
 */
import { describe, expect, it } from 'vitest'
import { computeScopeOwnerId } from '@lib/scope'

const OWNER_ID = 'owner-123'

describe('computeScopeOwnerId', () => {
  it('is null (unrestricted) in ALL mode, regardless of role', () => {
    expect(
      computeScopeOwnerId({ repVisibility: 'ALL', ownerId: OWNER_ID, ownerRole: 'Member', sessionOrgRole: 'org:member' }),
    ).toBeNull()
    expect(
      computeScopeOwnerId({ repVisibility: 'ALL', ownerId: OWNER_ID, ownerRole: 'Admin', sessionOrgRole: 'org:admin' }),
    ).toBeNull()
  })

  it('is null (unrestricted) in OWN mode for a real admin — both sources agree', () => {
    expect(
      computeScopeOwnerId({ repVisibility: 'OWN', ownerId: OWNER_ID, ownerRole: 'Admin', sessionOrgRole: 'org:admin' }),
    ).toBeNull()
  })

  it('is scoped to ownerId in OWN mode for a Member', () => {
    expect(
      computeScopeOwnerId({ repVisibility: 'OWN', ownerId: OWNER_ID, ownerRole: 'Member', sessionOrgRole: 'org:member' }),
    ).toBe(OWNER_ID)
  })

  it('fails closed (scoped, not null) when the DB says Admin but the live session says org:member — a demotion the DB hasn\'t caught up to yet', () => {
    expect(
      computeScopeOwnerId({ repVisibility: 'OWN', ownerId: OWNER_ID, ownerRole: 'Admin', sessionOrgRole: 'org:member' }),
    ).toBe(OWNER_ID)
  })

  it('fails closed (scoped, not null) when the session says org:admin but the DB says Member — never trust a single source to grant broader access', () => {
    expect(
      computeScopeOwnerId({ repVisibility: 'OWN', ownerId: OWNER_ID, ownerRole: 'Member', sessionOrgRole: 'org:admin' }),
    ).toBe(OWNER_ID)
  })

  it('fails closed when the session role is missing entirely (null/undefined)', () => {
    expect(
      computeScopeOwnerId({ repVisibility: 'OWN', ownerId: OWNER_ID, ownerRole: 'Admin', sessionOrgRole: null }),
    ).toBe(OWNER_ID)
    expect(
      computeScopeOwnerId({ repVisibility: 'OWN', ownerId: OWNER_ID, ownerRole: 'Admin', sessionOrgRole: undefined }),
    ).toBe(OWNER_ID)
  })
})
