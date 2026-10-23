/**
 * Merges one record's fetched (persisted, paginated) activity page with the optimistic rows
 * CrmProvider has added locally for that same record, for RecordDetail's Activity/Notes tabs.
 * Extracted from RecordDetail so it's unit-testable without rendering React (this repo has no
 * DOM/jsdom harness — see src/store/livePoll.ts and src/store/persistRun.ts for the same pattern).
 *
 * De-duplication is by id only. Every optimistic row is created with the same real UUID the
 * server eventually stores it under (see newEntityId in src/store/crm.tsx), so once the real,
 * persisted row for it shows up in `persisted`, it's an exact id match — never a guess from
 * content. Two distinct activities that happen to share kind/title/body (e.g. two calls logged
 * back to back with no note, or a new one that coincidentally matches an older one already on
 * the record) keep their own ids throughout and are never confused with each other.
 */
import type { Activity } from '@/data/types'
import { sortBy } from '@/lib/utils'

export function mergeTimeline(persisted: Activity[], pendingLocal: Activity[]): Activity[] {
  const persistedIds = new Set(persisted.map((a) => a.id))
  const pendingOnly = pendingLocal.filter((a) => !persistedIds.has(a.id))
  return sortBy([...persisted, ...pendingOnly], (a) => new Date(a.at).getTime(), 'desc')
}
