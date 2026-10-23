/**
 * Unit coverage for RecordDetail's timeline merge (src/store/activityTimeline.ts) — specifically
 * the scenario that motivated extracting it: two activities with identical kind/title/body on the
 * same record, logged close together or one already persisted when the other is logged.
 */
import { describe, expect, it } from 'vitest'
import { mergeTimeline } from '@/store/activityTimeline'
import type { Activity } from '@/data/types'

const subject = { type: 'contact' as const, id: 'contact-1', label: 'Jane Doe' }

function call(id: string, at: string): Activity {
  return { id, kind: 'call', title: 'called Jane Doe', at, actorId: 'owner-1', subject }
}

describe('mergeTimeline', () => {
  it('shows both of two identical-content activities logged back to back, before either is persisted', () => {
    const pendingLocal = [call('temp-2', '2026-01-01T10:00:01.000Z'), call('temp-1', '2026-01-01T10:00:00.000Z')]
    const result = mergeTimeline([], pendingLocal)
    expect(result.map((a) => a.id)).toEqual(['temp-2', 'temp-1'])
  })

  it('shows both after "reload" — two distinct real persisted rows with identical content never collapse into one', () => {
    const persisted = [call('real-2', '2026-01-01T10:00:01.000Z'), call('real-1', '2026-01-01T10:00:00.000Z')]
    const result = mergeTimeline(persisted, [])
    expect(result.map((a) => a.id)).toEqual(['real-2', 'real-1'])
  })

  it(
    'a newly-logged call is not hidden by content-matching an older call already on the record ' +
      '(the bug content-based de-dup had: the new optimistic row would vanish)',
    () => {
      const olderPersisted = [call('real-old', '2026-01-01T09:00:00.000Z')]
      const newPendingLocal = [call('temp-new', '2026-01-01T10:00:00.000Z')]
      const result = mergeTimeline(olderPersisted, newPendingLocal)
      // Both the old real row and the brand-new optimistic row show — same content, different
      // activities, never confused because they have different ids.
      expect(result.map((a) => a.id)).toEqual(['temp-new', 'real-old'])
    },
  )

  it('drops the optimistic row once the matching real row (same id) appears in the persisted page', () => {
    const persisted = [call('a1', '2026-01-01T10:00:00.000Z')]
    const pendingLocal = [call('a1', '2026-01-01T10:00:00.000Z')] // same id — now confirmed
    const result = mergeTimeline(persisted, pendingLocal)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('a1')
  })

  it('is stable (no duplicate ids) across any combination of persisted and pending', () => {
    const persisted = [call('p1', '2026-01-01T10:00:02.000Z'), call('p2', '2026-01-01T10:00:00.000Z')]
    const pendingLocal = [call('p1', '2026-01-01T10:00:02.000Z'), call('t1', '2026-01-01T10:00:01.000Z')]
    const result = mergeTimeline(persisted, pendingLocal)
    const ids = result.map((a) => a.id)
    expect(ids).toEqual(['p1', 't1', 'p2'])
    expect(new Set(ids).size).toBe(ids.length)
  })
})
